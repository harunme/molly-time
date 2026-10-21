import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEffect, useState } from "react";
import { api, type Session } from "./api";

type Pending = { name: string; expiresAt: string; };
export function PairingDialog({
  initialCode,
  session,
  close,
  paired,
}: {
  initialCode: string;
  session: Session;
  close: () => void;
  paired: () => void;
}) {
  const [code, setCode] = useState(initialCode),
    [selected, setSelected] = useState("");
  const [pending, setPending] = useState<Pending>(),
    [name, setName] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const admin = ["admin", "superadmin"].includes(session.user.role);
  const lookup = async (value: string) => {
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
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initialCode && admin) void lookup(initialCode);
  }, [initialCode, admin]);
  const confirm = async () => {
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
      setBusy(false);
    }
  };
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{confirmed ? "已确认绑定" : "绑定电视"}</DialogTitle>
        <DialogDescription>只确认你正在操作的电视。配对码应与电视屏幕一致。</DialogDescription>
      </DialogHeader>
      {confirmed ? (
        <>
          <DialogBody>
            <p role="status">电视正在连接「{session.family.name}」，无需在遥控器上输入密码。</p>
          </DialogBody>
          <DialogFooter><Button onClick={() => { paired(); close(); }}>完成</Button></DialogFooter>
        </>
      ) : !admin ? (
        <>
          <DialogBody>
            <Alert variant="destructive" role="alert">
              <AlertDescription>绑定电视需要家庭管理员账号。</AlertDescription>
            </Alert>
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
              <Label>
                电视配对码
                <Input
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
