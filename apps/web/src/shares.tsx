import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { api, ApiError, bytes, dateTime, setSession, type Resource, type Session } from "./api";
import { ResourcePicker } from "./pagination";
import { Check, Clock3, Copy, Film } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Summary = {
  id: string; name: string; type: "Series" | "Episode"; videoCount: number;
  sizeBytes: number; expiresAt: string; imageId?: string | null; overview?: string; durationMs?: number;
  items: { id: string; parentId: string | null; name: string; type: string; imageId?: string | null; overview?: string; runtimeMs?: number }[];
};
type Created = Summary & { url: string; code: string };
type Preview = Summary & { claimedResourceId: string | null; claimedDeleted: boolean; claimedFolderId: string | null; ownShare: boolean };
type Credential = { code: string };

function durationLabel(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}`;
}

function ShareArtwork({ imageId, code, name, hero = false }: { imageId?: string | null; code: string; name: string; hero?: boolean }) {
  const [failed, setFailed] = useState(false);
  const [src, setSrc] = useState("");
  useEffect(() => {
    setFailed(false); setSrc("");
    if (!imageId) return;
    const controller = new AbortController();
    let objectUrl = "";
    void fetch(`/api/shares/images/${encodeURIComponent(imageId)}`, {
      method: "POST", credentials: "same-origin", signal: controller.signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    }).then(async (response) => {
      if (!response.ok) throw new Error("封面加载失败");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setSrc(objectUrl);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [imageId, code]);
  if (hero && (!src || failed)) return null;
  return <div className={hero ? "share-hero-art" : "share-video-art"}>
    {src && !failed ? <img src={src} alt={`${name}封面`} loading={hero ? "eager" : "lazy"} referrerPolicy="no-referrer" onError={() => setFailed(true)} /> :
      <div className="share-art-placeholder"><Film aria-hidden="true" />{hero && <span>{name}</span>}</div>}
  </div>;
}

function SummaryDetails({ share, code, children }: { share: Summary; code: string; children?: ReactNode }) {
  const videos = share.items.filter((item) => item.type === "Episode");
  return <>
    <div className="share-hero">
      <ShareArtwork imageId={share.imageId} code={code} name={share.name} hero />
      <div className="share-hero-copy">
        <h2>{share.name}</h2>
        {share.overview && <p className="share-overview">{share.overview}</p>}
        <div className="share-facts"><span>{share.videoCount} 个视频</span><span>{bytes(share.sizeBytes)}</span>{!!share.durationMs && <span><Clock3 aria-hidden="true" />{durationLabel(share.durationMs)}</span>}</div>
      </div>
    </div>
    {children}
    {share.type === "Series" && <section className="share-catalog" aria-label="分享内容">
      <div className="share-section-title"><h3>包含的视频 <span className="ml-2 tabular-nums">共 {share.videoCount} 个</span></h3></div>
      <ul className="share-video-grid">
        {videos.map((item) => <li className="share-video" key={item.id}>
          <div className="share-video-image"><ShareArtwork imageId={item.imageId} code={code} name={item.name} />{!!item.runtimeMs && <span className="share-runtime">{durationLabel(item.runtimeMs)}</span>}</div>
          <h4>{item.name}</h4>
          {item.overview && <p>{item.overview}</p>}
        </li>)}
      </ul>
    </section>}
  </>;
}

export function ShareDialog({ resource, close }: { resource: Resource; close: () => void }) {
  const [share, setShare] = useState<Created>();
  const [prepared, setPrepared] = useState<{ videoCount: number; sizeBytes: number }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const creating = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    api<{ videoCount: number; sizeBytes: number }>("/shares/prepare", "POST", { resourceId: resource.id }, undefined, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setPrepared(value); })
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [resource.id]);
  const create = async () => {
    if (creating.current) return;
    creating.current = true;
    setBusy(true); setError("");
    try { setShare(await api<Created>("/shares", "POST", { resourceId: resource.id })); }
    catch (e) { setError(e instanceof Error ? e.message : "生成分享失败"); }
    finally { creating.current = false; setBusy(false); }
  };
  const copy = async (value: string, kind: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(`${kind}已复制`); }
    catch { setError("复制失败，请选中下方文字手动复制"); }
  };
  const details = share || prepared;
  const expiry = share && new Date(share.expiresAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) close(); }}>
    <DialogContent className="max-w-110">
      <DialogHeader>
        <DialogTitle className="truncate">分享 · {resource.name}</DialogTitle>
        <DialogDescription>
          {details ? `${details.videoCount} 个视频 · ${bytes(details.sizeBytes)}` : "正在准备分享…"}
          {expiry && ` · ${expiry} 到期`}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-5">
        {share ? <>
          <div className="space-y-2">
            <Label htmlFor="share-link">分享链接</Label>
            <InputGroup>
              <InputGroupInput id="share-link" className="text-sm" value={share.url} readOnly onFocus={(e) => e.target.select()} />
              <InputGroupAddon align="inline-end">
                <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" aria-label="复制链接" onClick={() => void copy(share.url, "链接")}>
                  {copied === "链接已复制" ? <Check /> : <Copy />}
                  {copied === "链接已复制" ? "已复制" : "复制"}
                </Button>
              </InputGroupAddon>
            </InputGroup>
          </div>
          <div className="space-y-2">
            <Label htmlFor="share-code">分享口令</Label>
            <InputGroup>
              <InputGroupInput id="share-code" className="font-mono text-sm tracking-wider" value={share.code.match(/.{1,4}/g)?.join("-") || share.code} readOnly onFocus={(e) => e.target.select()} />
              <InputGroupAddon align="inline-end">
                <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" aria-label="复制口令" onClick={() => void copy(share.code, "口令")}>
                  {copied === "口令已复制" ? <Check /> : <Copy />}
                  {copied === "口令已复制" ? "已复制" : "复制"}
                </Button>
              </InputGroupAddon>
            </InputGroup>
          </div>
          <span role="status" className="sr-only">{copied}</span>
        </> : <p className="text-sm text-muted-foreground">分享当前已发布的内容，后续修改不会同步。</p>}
        <p className="text-xs text-muted-foreground">七天内可领取，接收后无法撤回。</p>
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      </DialogBody>
      {!share && <DialogFooter>
        <Button disabled={busy || !prepared} onClick={() => void create()}>{busy ? "正在生成…" : "生成分享"}</Button>
      </DialogFooter>}
    </DialogContent>
  </Dialog>;
}

function credentialFromText(value: string): Credential {
  if (!/^https?:\/\//i.test(value)) return { code: value };
  const url = new URL(value);
  const [path, query = ""] = url.hash.slice(1).split("?");
  const code = /^\/share\/([^/]+)$/.exec(path)?.[1] || new URLSearchParams(query || url.search).get("code");
  if (code) return { code };
  throw new Error("请输入有效的分享链接或十二位口令");
}

async function previewShare(credential: Credential, signal?: AbortSignal): Promise<Preview> {
  const response = await fetch("/api/shares/preview", {
    method: "POST", credentials: "same-origin", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(credential),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "请输入有效的分享链接或十二位口令");
  return result;
}

function ShareLoginDialog({ close, loggedIn }: { close: () => void; loggedIn: (session: Session) => Promise<void> }) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) close(); }}>
    <DialogContent className="max-w-100" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>登录领取</DialogTitle><DialogDescription>登录后加入自己的内容库。</DialogDescription></DialogHeader>
      <form onSubmit={(event) => {
        event.preventDefault(); if (busy) return;
        setBusy(true); setError("");
        void api<Session>("/auth/login", "POST", { username: account, password })
          .then(loggedIn).catch((failure) => setError(failure.message)).finally(() => setBusy(false));
      }}>
        <DialogBody className="space-y-4">
          <div className="space-y-2"><Label htmlFor="share-login-account">账号</Label><Input id="share-login-account" autoComplete="username" placeholder="邮箱或数字 ID" maxLength={254} value={account} onChange={(event) => setAccount(event.target.value)} disabled={busy} required /></div>
          <div className="space-y-2"><Label htmlFor="share-login-password">密码</Label><Input id="share-login-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} required /></div>
          {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        </DialogBody>
        <DialogFooter><Button type="submit" className="w-full" disabled={busy}>{busy ? "正在登录…" : "登录并领取"}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function ShareClaimDialog({ session, initialFolder, close, received }: { session: Session; initialFolder?: Resource; close: () => void; received: () => void }) {
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent><DialogHeader><DialogTitle>领取分享</DialogTitle><DialogDescription>粘贴分享链接或输入口令，加入自己的内容库。</DialogDescription></DialogHeader>
      <DialogBody><ShareReceive session={session} readonly={false} modal initialFolderId={initialFolder?.id} initialFolder={initialFolder} received={received} /></DialogBody>
    </DialogContent>
  </Dialog>;
}

export function ShareReceive({ session, readonly, standalone = false, modal = false, initialFolderId = "", initialFolder, received, onSession }: { session?: Session; readonly: boolean; standalone?: boolean; modal?: boolean; initialFolderId?: string; initialFolder?: Resource; received?: () => void; onSession?: (value: Session) => void }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const code = /^\/share\/([^/]+)$/.exec(location.pathname)?.[1] || params.get("code") || "";
  const [input, setInput] = useState("");
  const [share, setShare] = useState<Preview>();
  const [credential, setCredential] = useState<Credential>();
  const [folder, setFolder] = useState(initialFolderId);
  const [loginOpen, setLoginOpen] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const accepting = useRef(false);
  const load = async (value: Credential, signal?: AbortSignal) => {
    setBusy(true); setError(""); setShare(undefined); setCredential(undefined);
    try {
      const result = await previewShare(value, signal);
      if (signal?.aborted) return;
      setShare(result); setCredential(value); setFolder(initialFolderId);
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : "加载分享失败"); }
    finally { if (!signal?.aborted) setBusy(false); }
  };
  useEffect(() => {
    setShare(undefined); setCredential(undefined); setError(""); setBusy(false);
    if (!code) return;
    const controller = new AbortController();
    void load({ code }, controller.signal);
    return () => controller.abort();
  }, [code]);
  const performClaim = async (actor: Session, selected = share) => {
    if (!selected || !credential || accepting.current) return;
    if (!["admin", "superadmin"].includes(actor.user.role)) { setError("请使用家庭管理员账号领取分享。"); return; }
    accepting.current = true; setBusy(true); setError("");
    try {
      const result = await api<{ resourceId: string; deleted: boolean }>("/shares/accept", "POST", {
        ...credential, targetFolderId: selected.type === "Episode" ? folder : undefined,
      });
      if (result.deleted) throw new Error("此分享已经领取，收到的内容已删除，无法重复领取");
      setShare({ ...selected, claimedResourceId: result.resourceId, claimedDeleted: false, claimedFolderId: selected.type === "Episode" ? folder : null });
      setClaimed(true);
      if (received) received();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) setLoginOpen(true);
      else setError(failure instanceof Error ? failure.message : "领取失败");
    } finally { accepting.current = false; setBusy(false); }
  };
  const loggedIn = async (value: Session) => {
    setSession(value); onSession?.(value); setBusy(true);
    try {
      if (!credential) return;
      const refreshed = await previewShare(credential);
      setShare(refreshed); setLoginOpen(false);
      if (refreshed.type === "Series" && !refreshed.ownShare && !refreshed.claimedResourceId)
        await performClaim(value, refreshed);
    } catch (failure) {
      setLoginOpen(false);
      setError(failure instanceof Error ? failure.message : "加载分享失败");
    } finally { setBusy(false); }
  };
  const accept = async () => {
    if (!session) { setLoginOpen(true); return; }
    await performClaim(session);
  };
  const claimPanel = share && (
    <div className={modal ? "space-y-4" : "share-claim-panel"}>
      <p className="share-expiry">领取截止：{dateTime(share.expiresAt)}</p>
      {share.ownShare ? <p className="text-sm text-muted-foreground">这是你家庭分享的内容，无需重复领取。</p> : share.claimedResourceId ? <>
        <p>{share.claimedDeleted ? "你的家庭已领取过此分享，内容已删除，无法重复领取。" : claimed ? "已加入我的内容库，发布后可在电视上观看。" : "你的家庭已领取此分享，无需重复加入。"}</p>
        {!standalone && !share.claimedDeleted && <Button asChild><Link to={share.type === "Series" ? `/library/${share.claimedResourceId}` : share.claimedFolderId ? `/library/${share.claimedFolderId}` : "/library"}>查看我的内容</Link></Button>}
      </> : <>
        {session && !readonly && share.type === "Episode" && <ResourcePicker initial={initialFolder} value={folder} onChange={setFolder} label="接收合集" placeholder="选择接收合集" />}
        <p className="text-sm text-muted-foreground">{readonly ? "请使用家庭管理员账号领取分享。" : "领取后由你决定是否发布。"}</p>
        <Button className="w-full" disabled={busy || readonly || (!!session && share.type === "Episode" && !folder)} onClick={() => void accept()}>{busy ? "正在加入…" : "加入我的内容库"}</Button>
      </>}
    </div>
  );
  const content = <>
    {!modal && <div className={share && code ? "sr-only" : "share-page-heading"}><h1 className="text-2xl font-semibold">{code ? "分享给你的内容" : "领取分享"}</h1><p className="mt-2 text-sm text-muted-foreground">加入自己的内容库，再决定给孩子看什么。</p></div>}
    <Card className={modal ? "border-0 bg-transparent p-0 shadow-none space-y-4" : share ? "share-content" : "p-6 space-y-5"}>
      {!code && <form className={share && !modal ? "share-code-form space-y-3" : "space-y-3"} onSubmit={(e) => {
        e.preventDefault();
        try { void load(credentialFromText(input.trim())); }
        catch (failure) { setError(failure instanceof Error ? failure.message : "请输入有效的分享链接或口令"); }
      }}>
        <Label htmlFor="receive-code">分享链接或口令</Label>
        <div className="flex items-center gap-2">
          <Input id="receive-code" className="min-w-0 flex-1" value={input} disabled={busy} onChange={(e) => setInput(e.target.value)} placeholder="粘贴链接或输入十二位口令" required />
          <Button className="shrink-0" disabled={busy} type="submit">{busy ? "正在加载…" : "查看分享"}</Button>
        </div>
      </form>}
      {code && !share && <Button variant="bordered" disabled={busy} onClick={() => void load({ code })}>{busy ? "正在加载…" : "重新加载分享"}</Button>}
      {share && <>
        {modal ? <div className="space-y-2"><h3>{share.name}</h3><p className="text-sm text-muted-foreground">{share.videoCount} 个视频 · {bytes(share.sizeBytes)}</p><ul className="max-h-40 overflow-auto space-y-1 text-sm">{share.items.filter((item) => item.type === "Episode").map((item) => <li key={item.id}>{item.name}</li>)}</ul></div> : <SummaryDetails share={share} code={credential?.code || code}>{claimPanel}</SummaryDetails>}
        {modal && claimPanel}
      </>}
      {error && <Alert variant="destructive" role="alert" className={share && !modal ? "share-error" : ""}><AlertDescription>{error}</AlertDescription></Alert>}
    </Card>
    {loginOpen && <ShareLoginDialog close={() => setLoginOpen(false)} loggedIn={loggedIn} />}
  </>;
  return standalone ? <main className="share-landing">
    <div className="share-page">
      <header className="share-brand"><div className="wordmark">MollyTime</div><span>内容分享</span></header>
      {content}
    </div>
  </main> : modal ? content : <div className="share-page share-page-embedded">{content}</div>;
}
