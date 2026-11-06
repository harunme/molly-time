import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loading } from "@/components/ui/loading";
import { SelectField } from "@/components/ui/select";
import { bytes, dateTime, minutes } from "./api";
import { Pagination, useDebounced, usePagedData } from "./pagination";

type Video = {
  id: string; itemId: string; name: string; filename: string;
  familyId: string | null; familyName: string;
  accounts: { id: string; name: string; email: string | null; accountId: string | null }[];
  collection: string; status: string; canPreview: boolean;
  size: number; runtimeMs: number; storage: string; shared: boolean; uploadedAt: string | null;
};
const statuses: Record<string, string> = {
  published: "已发布", unpublished: "未发布", archived: "回收站", deleted: "已删除",
};

function VideoPreview({ video }: { video: Video }) {
  const [failure, setFailure] = useState("");
  const [revision, setRevision] = useState(0);
  return <>
    <video key={revision} src={`/api/manage/operations/videos/${encodeURIComponent(video.id)}/play`}
      className="video-preview" controls autoPlay playsInline preload="none" aria-label={`预览 ${video.name}`}
      onError={event => {
        const code = event.currentTarget.error?.code;
        setFailure(code === 3 || code === 4
          ? "视频无法播放，可能已被移除或浏览器不支持此格式。"
          : "视频加载失败，请检查网络或登录状态后重试。");
      }} />
    {failure && <Alert variant="destructive" role="alert" className="mt-4">
      <AlertDescription>{failure}<Button variant="bordered" className="mt-3" onClick={() => {
        setFailure(""); setRevision(value => value + 1);
      }}>重试播放</Button></AlertDescription>
    </Alert>}
  </>;
}

export function OperationsVideos() {
  const [params, setParams] = useSearchParams();
  const userId = params.get("userId") || "";
  const [search, setSearch] = useState("");
  const [storage, setStorage] = useState("");
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Video>();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const query = useDebounced(search);
  const list = usePagedData<Video>(`/operations/videos?q=${encodeURIComponent(query)}&storage=${storage}${userId ? `&userId=${encodeURIComponent(userId)}` : ""}`, revision);
  return <Card className="settings-card">
    <div className="section-heading flex-wrap gap-3">
      <div><h2>全部视频</h2><p className="muted">查看所有家庭片库中的视频。仅在点击预览后加载视频。</p></div>
      <Button variant="bordered" disabled={list.refreshing} onClick={() => setRevision(value => value + 1)}>刷新列表</Button>
    </div>
    <p className="muted">视频按家庭共享，家庭账号不代表实际上传人。列表包含未发布及回收站中的视频，不包含未完成的上传和已替换的历史版本。</p>
    {userId && <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
      <span>当前查看所选用户的家庭视频</span>
      <Button variant="bordered" size="sm" onClick={() => setParams({})}>查看所有家庭</Button>
    </div>}
    <div className="mb-6 grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
      <div className="grid gap-2"><Label htmlFor="operations-video-search">搜索视频或用户</Label>
        <Input id="operations-video-search" maxLength={254} value={search} onChange={event => setSearch(event.target.value)}
          placeholder="视频名称、文件名、家庭、邮箱或账号 ID" /></div>
      <div className="grid gap-2"><Label htmlFor="operations-video-storage">存储位置</Label>
        <SelectField id="operations-video-storage" aria-label="存储位置" value={storage} onValueChange={setStorage}
          options={[{ value: "", label: "全部存储" }, { value: "local", label: "本地存储" }, { value: "oss", label: "OSS 云存储" }]} /></div>
    </div>
    {list.error && <Alert variant="destructive" role="alert"><AlertDescription>{list.error}</AlertDescription></Alert>}
    {list.loading ? <Loading variant="table" label="正在加载视频…" /> : !list.error && !list.data.length
      ? <Empty>{query || storage || userId ? "没有匹配的视频，试试其他关键词或清除筛选。" : "还没有已完成上传的视频。"}</Empty>
      : !!list.data.length && <ul className="grid gap-4" aria-label="全部视频列表" aria-busy={list.refreshing}>
        {list.data.map(video => <li key={video.id} className="grid min-w-0 gap-4 rounded-lg border border-border p-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <h3 className="break-words text-base font-semibold">{video.name}</h3>
            {video.collection && <p className="mt-1 break-words text-sm text-muted-foreground">{video.collection}</p>}
            <p className="mt-2 break-all text-sm text-muted-foreground">文件：{video.filename}</p>
            <div className="mt-3 flex flex-wrap gap-2"><Badge variant="secondary">{statuses[video.status] || video.status}</Badge>
              {video.shared && <Badge variant="bordered">分享领取</Badge>}</div>
          </div>
          <div className="min-w-0 text-sm">
            <p className="break-words"><span className="text-muted-foreground">所属家庭：</span>{video.familyName}</p>
            <p className="mt-2 text-muted-foreground">家庭账号</p>
            {video.accounts.length ? <ul className="mt-1 grid gap-2">{video.accounts.map(account => <li key={account.id} className="break-all">
              <span>{account.email || account.name}</span>
              {account.accountId && <span className="block text-xs text-muted-foreground">账号 ID：{account.accountId}</span>}
            </li>)}</ul> : <p className="mt-1 text-muted-foreground">无关联账号</p>}
          </div>
          <dl className="grid content-start gap-2 text-sm">
            <div><dt className="text-muted-foreground">大小 / 时长</dt><dd>{video.size ? bytes(video.size) : "大小未记录"} · {video.runtimeMs ? minutes(video.runtimeMs) : "时长未记录"}</dd></div>
            <div><dt className="text-muted-foreground">存储</dt><dd>{video.storage === "oss" ? "OSS 云存储" : "本地存储"}</dd></div>
            <div><dt className="text-muted-foreground">上传时间</dt><dd>{video.uploadedAt ? dateTime(video.uploadedAt) : "未记录"}</dd></div>
          </dl>
          <Button variant="bordered" className="self-start" disabled={!video.canPreview} aria-label={`预览 ${video.name}`} onClick={event => {
            trigger.current = event.currentTarget; setSelected(video);
          }}>{video.canPreview ? "预览视频" : "暂不可预览"}</Button>
        </li>)}
      </ul>}
    <Pagination {...list} label="全部视频分页" loading={list.refreshing} />
    <Dialog open={!!selected} onOpenChange={open => { if (!open) setSelected(undefined); }}>
      <DialogContent className="max-w-4xl" onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }}>
        <DialogHeader><DialogTitle className="break-words">{selected?.name}</DialogTitle>
          <DialogDescription className="break-words">{selected?.familyName} · 预览不会计入孩子的观看时长或更改续播进度。</DialogDescription></DialogHeader>
        <DialogBody>{selected && <VideoPreview key={selected.id} video={selected} />}</DialogBody>
      </DialogContent>
    </Dialog>
  </Card>;
}
