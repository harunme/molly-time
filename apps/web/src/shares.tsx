import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { api, bytes, dateTime, type Resource } from "./api";
import { ResourcePicker } from "./pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Summary = {
  id: string; name: string; type: "Series" | "Episode"; videoCount: number;
  sizeBytes: number; expiresAt: string;
  items: { id: string; parentId: string | null; name: string; type: string }[];
};
type Created = Summary & { url: string; code: string };
type Preview = Summary & { claimedResourceId: string | null; claimedDeleted: boolean };
type Credential = { token: string } | { code: string };

function SummaryDetails({ share }: { share: Summary }) {
  return <div className="space-y-3">
    <p>{share.videoCount} 个视频 · {bytes(share.sizeBytes)}</p>
    <p className="text-sm text-muted-foreground">领取截止：{dateTime(share.expiresAt)}</p>
    <ul className="max-h-64 overflow-auto space-y-2" aria-label="分享内容">
      {share.items.filter((item) => item.type === "Episode").map((item) =>
        <li key={item.id}>{item.name}</li>)}
    </ul>
  </div>;
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
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) close(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>分享 · {resource.name}</DialogTitle>
        <DialogDescription>分享当前已发布的内容版本，后续修改不会同步给对方。</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <p className="text-sm">链接和口令七天内有效，持有者可加入自己的内容库。接收后独立保留，无法撤回。</p>
        {!share && prepared && <p>{prepared.videoCount} 个视频 · {bytes(prepared.sizeBytes)}</p>}
        {!share && <p className="text-sm text-muted-foreground">合集仅包含已发布且处理完成的视频、字幕和封面。</p>}
        {share && <>
          <SummaryDetails share={share} />
          <Label htmlFor="share-link">分享链接</Label>
          <Input id="share-link" value={share.url} readOnly onFocus={(e) => e.target.select()} />
          <Button variant="bordered" onClick={() => void copy(share.url, "链接")}>复制链接</Button>
          <Label htmlFor="share-code">分享口令</Label>
          <Input id="share-code" value={share.code.match(/.{1,4}/g)?.join("-") || share.code} readOnly onFocus={(e) => e.target.select()} />
          <Button variant="bordered" onClick={() => void copy(share.code, "口令")}>复制口令</Button>
          <p role="status" className="text-sm">{copied}</p>
        </>}
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      </DialogBody>
      <DialogFooter>
        <Button variant="bordered" disabled={busy} onClick={close}>关闭</Button>
        {!share && <Button disabled={busy || !prepared} onClick={() => void create()}>{busy ? "正在生成…" : "生成分享"}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function ShareReceive({ readonly }: { readonly: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const token = new URLSearchParams(location.search).get("token") || "";
  const [input, setInput] = useState("");
  const [share, setShare] = useState<Preview>();
  const [credential, setCredential] = useState<Credential>();
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const accepting = useRef(false);
  const load = async (value: Credential, signal?: AbortSignal) => {
    setBusy(true); setError(""); setShare(undefined); setCredential(undefined);
    try {
      const result = await api<Preview>("/shares/preview", "POST", value, undefined, signal);
      if (signal?.aborted) return;
      setShare(result); setCredential(value); setName(result.name); setFolder("");
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : "加载分享失败"); }
    finally { if (!signal?.aborted) setBusy(false); }
  };
  useEffect(() => {
    setShare(undefined); setCredential(undefined); setError(""); setBusy(false);
    if (!token || readonly) return;
    const controller = new AbortController();
    void load({ token }, controller.signal);
    return () => controller.abort();
  }, [token, readonly]);
  const openResource = (id: string, type: string) => {
    navigate(type === "Series" ? `/library/${id}` : `/library/${folder}`);
  };
  const accept = async () => {
    if (!share || !credential || accepting.current) return;
    accepting.current = true;
    setBusy(true); setError("");
    try {
      const result = await api<{ resourceId: string; deleted: boolean }>("/shares/accept", "POST", {
        ...credential, targetFolderId: share.type === "Episode" ? folder : undefined, name: name.trim(),
      });
      if (result.deleted) throw new Error("此分享已经领取，收到的内容已删除，无法重复领取");
      openResource(result.resourceId, share.type);
    } catch (e) { setError(e instanceof Error ? e.message : "领取失败"); }
    finally { accepting.current = false; setBusy(false); }
  };
  return <>
    <div className="page-title"><div><h1>领取分享</h1><p>加入自己的内容库，再决定给孩子看什么。</p></div></div>
    {readonly ? <p>请使用家庭管理员账号领取分享。</p> : <Card className="p-6 space-y-5 max-w-2xl">
      {!token && <form className="space-y-3" onSubmit={(e) => {
        e.preventDefault();
        const value = input.trim();
        if (value.startsWith("http")) {
          try {
            const url = new URL(value);
            const supplied = new URLSearchParams(url.hash.split("?")[1] || url.search).get("token");
            if (!supplied) throw new Error();
            void load({ token: supplied });
          } catch { setError("请输入有效的分享链接或十二位口令"); }
        } else void load({ code: value });
      }}>
        <Label htmlFor="receive-code">分享链接或口令</Label>
        <Input id="receive-code" value={input} disabled={busy} onChange={(e) => setInput(e.target.value)} placeholder="粘贴链接或输入十二位口令" required />
        <Button disabled={busy} type="submit">{busy ? "正在加载…" : "查看分享"}</Button>
      </form>}
      {token && !share && <Button variant="bordered" disabled={busy} onClick={() => void load({ token })}>{busy ? "正在加载…" : "重新加载分享"}</Button>}
      {share && <>
        <h2 className="text-xl font-semibold">{share.name}</h2>
        <SummaryDetails share={share} />
        {share.claimedResourceId ? <>
          <p>{share.claimedDeleted ? "你的家庭已领取过此分享，内容已删除，无法重复领取。" : "你的家庭已领取此分享，无需重复加入。"}</p>
          {!share.claimedDeleted && <Button asChild><Link to={share.type === "Series" ? `/library/${share.claimedResourceId}` : "/library"}>查看我的内容</Link></Button>}
        </> : <>
          <Label htmlFor="received-name">接收后的名称</Label>
          <Input id="received-name" value={name} disabled={busy} maxLength={256} onChange={(e) => setName(e.target.value)} />
          {share.type === "Episode" && <ResourcePicker value={folder} onChange={setFolder} label="接收合集" placeholder="选择接收合集" />}
          <p className="text-sm text-muted-foreground">接收后为草稿，发布后才会出现在电视上。占用家庭内容容量，不跟随对方后续更新。</p>
          <Button disabled={busy || !name.trim() || (share.type === "Episode" && !folder)} onClick={() => void accept()}>{busy ? "正在加入…" : "加入我的内容库"}</Button>
        </>}
      </>}
      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
    </Card>}
  </>;
}
