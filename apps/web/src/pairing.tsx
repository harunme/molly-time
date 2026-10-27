import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { api, type Session } from "./api";

const PairingContext = createContext<{ open: (install?: boolean) => void; refresh: () => void; revision: number; deviceCount?: number } | null>(null);
export function usePairing() {
  const value = useContext(PairingContext);
  if (!value) throw new Error("PairingProvider is required");
  return value;
}

export function PairingProvider({ session, devices, devicesError, children }: {
  session: Session; devices?: { id: string }[]; devicesError: string; children: ReactNode;
}) {
  const location = useLocation(), navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  // Legacy entry routes must normalize before mounting a modal over them.
  const opened = params.get("pair") === "1" && !["/pair", "/family", "/family/", "/family/devices", "/family/watching"].includes(location.pathname);
  const [revision, setRevision] = useState(0);
  const opener = useRef<HTMLElement | null>(null);
  const signature = devices?.map(device => device.id).sort().join(",");
  useEffect(() => { setRevision(value => value + 1); }, [signature]);
  const refresh = () => {
    setRevision(value => value + 1);
    window.dispatchEvent(new Event("molly:watch-controlChanged"));
  };
  const open = (install = false) => {
    opener.current = document.activeElement as HTMLElement;
    const next = new URLSearchParams(location.search);
    next.set("pair", "1");
    if (install) next.set("install", "1"); else next.delete("install");
    navigate(`${location.pathname}?${next}`, { state: { ...location.state, pairingReturnTo: location.pathname + location.search } });
  };
  const close = () => {
    const next = new URLSearchParams(location.search);
    ["pair", "code", "install"].forEach(key => next.delete(key));
    const background = `${location.pathname}${next.size ? `?${next}` : ""}`;
    if (location.state?.pairingReturnTo === background) navigate(-1);
    else navigate(background, { replace: true });
  };
  return <PairingContext.Provider value={{ open, refresh, revision, deviceCount: devices && !devicesError ? devices.length : undefined }}>
    {children}
    <Dialog open={opened} onOpenChange={value => { if (!value) close(); }}>
      {opened && <PairingDialog key={`${params.get("code") ?? ""}:${params.get("install") ?? ""}`} initialCode={params.get("code") ?? ""}
        initialInstall={params.get("install") === "1"} session={session} close={close} paired={refresh}
        restoreFocus={() => {
          const target = opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>(".page-title button, .page-title h1");
          if (target) { if (target.tagName === "H1") target.tabIndex = -1; target.focus(); }
        }} />}
    </Dialog>
  </PairingContext.Provider>;
}

function InstallInstructions() {
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const download = async () => {
    if (busy) return;
    setBusy(true); setStatus("正在获取最新安装包…");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch("/api/client/releases/latest", { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error("暂时无法获取安装包，请重试。");
      const { release } = await response.json();
      if (!release) { setStatus("电视安装包尚未发布，请稍后再来。"); return; }
      if (release.packageName !== "com.molly.tv" || typeof release.url !== "string" || typeof release.versionName !== "string" || !Number.isSafeInteger(release.size) || release.size <= 0) throw new Error("安装包信息不完整，请稍后重试。");
      const url = new URL(release.url, location.origin);
      if (url.origin !== location.origin || !/^\/api\/client\/releases\/com\.molly\.tv\/\d+\/[a-f0-9]{64}\.apk$/.test(url.pathname) || url.search || url.hash) throw new Error("安装包地址无效，请稍后重试。");
      const link = document.createElement("a");
      link.href = url.href; link.download = "mollytime-tv.apk";
      document.body.append(link); link.click(); link.remove();
      setStatus(`v${release.versionName} · ${(release.size / 1024 / 1024).toFixed(1)} MB · 已开始下载，请将安装包转移到电视。`);
    } catch (failure) {
      setStatus(failure instanceof Error && failure.name !== "AbortError" ? failure.message : "网络连接超时，请重试。");
    } finally { clearTimeout(timeout); setBusy(false); }
  };
  return <div className="pairing-install">
    <p className="muted">适用于支持安装 APK 的 Android 电视和电视盒子。</p>
    <ol><li>下载安装包，将文件复制到 U 盘。</li><li>把 U 盘插入电视，在文件管理器中找到安装包并安装。安装权限和操作方式以电视品牌说明为准。</li><li>打开 MollyTime，用手机扫描电视二维码，或在这里输入配对码。</li></ol>
    <Button type="button" variant="bordered" disabled={busy} onClick={() => { void download(); }}>{busy ? "正在获取…" : "下载电视安装包"}</Button>
    {status && <p role="status" className="muted">{status}</p>}
  </div>;
}

type Pending = { name: string; expiresAt: string; };
export function PairingDialog({
  initialCode,
  session,
  close,
  paired,
  initialInstall = false,
  restoreFocus,
}: {
  initialCode: string;
  session: Session;
  close: () => void;
  paired: () => void;
  initialInstall?: boolean;
  restoreFocus?: () => void;
}) {
  const [install, setInstall] = useState(initialInstall);
  const lock = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState(initialCode),
    [selected, setSelected] = useState("");
  const [pending, setPending] = useState<Pending>(),
    [name, setName] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const admin = ["admin", "superadmin"].includes(session.user.role);
  const lookup = async (value: string) => {
    if (lock.current || !/^[0-9]{4}$/.test(value.trim())) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setPending(undefined);
    try {
      const data = await api<Pending>(
        `/pairing/${encodeURIComponent(value.trim())}`,
      );
      setSelected(value.trim());
      setPending(data);
      setName(data.name);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "配对码无效");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initialCode && admin) void lookup(initialCode);
  }, [initialCode, admin]);
  const confirm = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await api("/pairing/confirm", "POST", {
        code: selected,
        name: name.trim(),
      });
      setConfirmed(true);
      paired();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "绑定失败，请重试");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <DialogContent onOpenAutoFocus={event => {
      if (!initialInstall && !initialCode && admin) { event.preventDefault(); input.current?.focus(); }
    }} onCloseAutoFocus={restoreFocus ? event => { event.preventDefault(); restoreFocus(); } : undefined}>
      <DialogHeader>
        <DialogTitle>{confirmed ? "已确认绑定" : "绑定电视"}</DialogTitle>
        <DialogDescription>只确认你正在操作的电视。配对码应与电视屏幕一致。</DialogDescription>
      </DialogHeader>
      {confirmed ? (
        <>
          <DialogBody>
            <p role="status">已确认绑定到「{session.family.name}」，请查看电视屏幕。电视连接后会自动进入内容页，无需在遥控器上输入密码。</p>
            <p className="muted">如果电视还没有内容，请在资源库中添加并发布视频。</p>
          </DialogBody>
          <DialogFooter><Button onClick={() => { paired(); close(); }}>完成</Button></DialogFooter>
        </>
      ) : !admin ? (
        <>
          <DialogBody>
            <Alert variant="destructive" role="alert">
              <AlertDescription>请家庭管理员完成绑定。</AlertDescription>
            </Alert>
            <details className="pairing-help" open={install} onToggle={event => setInstall(event.currentTarget.open)}><summary>电视还没安装？</summary><InstallInstructions /></details>
          </DialogBody>
          <DialogFooter><Button variant="bordered" onClick={close}>关闭</Button></DialogFooter>
        </>
      ) : (
        <form onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          if (pending) void confirm();
          else void lookup(code);
        }}>
          <DialogBody>
            {!pending ? (
              <>
              <p className="pairing-instruction">打开电视上的 MollyTime，在绑定页面查看四位配对码。也可以用手机直接扫描电视上的二维码。</p>
              <Label>
                电视配对码
                <Input
                  ref={input}
                  autoComplete="off"
                  inputMode="numeric"
                  pattern="[0-9]{4}"
                  placeholder="四位数字"
                  spellCheck={false}
                  value={code}
                  maxLength={4}
                  onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ""))}
                  required
                />
              </Label>
              <details className="pairing-help" open={install} onToggle={event => setInstall(event.currentTarget.open)}><summary>电视还没安装？</summary><InstallInstructions /></details>
              </>
            ) : (
              <>
                <div className="pairing-summary">
                  <span>配对码</span><strong>{selected}</strong>
                  <span>绑定到</span><strong>{session.family.name}</strong>
                </div>
                <Label>
                  电视名称
                  <Input value={name} maxLength={128}
                    onChange={(event) => setName(event.target.value)} required />
                </Label>
                <Button variant="ghost" type="button" className="quiet" disabled={busy}
                  onClick={() => { setPending(undefined); setError(""); }}>
                  输入其他配对码
                </Button>
              </>
            )}
            {error && <Alert variant="destructive" role="alert" className="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>}
          </DialogBody>
          <DialogFooter>
            <Button variant="bordered" type="button" disabled={busy} onClick={close}>取消</Button>
            <Button disabled={busy || (pending ? !name.trim() : !/^[0-9]{4}$/.test(code))}>
              {pending ? (busy ? "正在绑定…" : "确认绑定这台电视") : (busy ? "正在查找…" : "查看电视")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </DialogContent>
  );
}
