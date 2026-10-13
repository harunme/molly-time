import { useEffect, useState } from "react";
import { ArrowRight, FolderOpen, Monitor, Play, UploadCloud } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, bytes, dateTime, type Upload } from "./api";
import { Pagination, usePagedData } from "./pagination";

type OverviewData = {
  media: { folders: number; videos: number; published: number; draft: number; archived: number };
  uploads: { active: number; failed: number; ready: number };
  devices: { active: number; revoked: number };
  children: number;
  storageBytes: number;
  watch: { last7DaysSessions: number; timezone: string };
};

type Destination = "library" | "upload" | "watch" | "family";
const uploadNames: Record<string, string> = {
  uploading: "上传中", processing: "检查中", ready: "文件就绪", failed: "检查失败", cancelled: "已取消",
};

export function Overview({ familyName, navigate }: {
  familyName: string; navigate: (page: Destination) => void;
}) {
  const [data, setData] = useState<OverviewData>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const uploads = usePagedData<Upload>("/uploads", 0, 5);
  const devices = usePagedData<{ id: string; name: string; lastSeen: string }>(
    "/devices?activeOnly=true", 0, 5,
  );
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError("");
    api<OverviewData>("/overview", "GET", undefined, undefined, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setData(value); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, []);
  const metrics = [
    { label: "视频资源", value: data?.media.videos, detail: data ? `${data.media.folders} 个文件夹` : "媒体库规模", icon: FolderOpen, page: "library" },
    { label: "进行中的上传", value: data?.uploads.active, detail: data?.uploads.failed ? `${data.uploads.failed} 个失败任务待处理` : "上传中与检查中的任务", icon: UploadCloud, page: "upload" },
    { label: "已绑定电视", value: data?.devices.active, detail: data ? `${data.children} 位儿童档案` : "家庭设备", icon: Monitor, page: "family" },
    { label: "近 7 天观看次数", value: data?.watch.last7DaysSessions, detail: "有实际播放的观看记录", icon: Play, page: "watch" },
  ] as const;
  return <>
    <div className="page-title">
      <div><h1>概览</h1><p>{familyName}的媒体、任务与观看情况。</p></div>
      <div className="actions">
        <Button onClick={() => navigate("library")}><FolderOpen className="size-4" />管理资源</Button>
      </div>
    </div>
    {error && <p role="alert" className="banner error">{error}</p>}
    {!data && busy && <p role="status" className="muted">正在加载概览…</p>}
    <div className="overview-metrics">
      {metrics.map((metric) => <Card className="overview-metric" key={metric.label}>
        <div className="overview-metric-label"><span>{metric.label}</span><metric.icon className="size-4" /></div>
        <strong className="overview-metric-value">{metric.value?.toLocaleString("zh-CN") ?? "—"}</strong>
        <div className="overview-metric-bottom"><span>{metric.detail}</span><Button variant="ghost" size="icon-sm" aria-label={`查看${metric.label}`} onClick={() => navigate(metric.page)}><ArrowRight className="size-4" /></Button></div>
      </Card>)}
    </div>
    <div className="overview-panels">
      <Card className="overview-panel overview-uploads">
        <div className="section-heading"><h2>最近上传</h2><Button variant="ghost" size="sm" onClick={() => navigate("upload")}>全部任务<ArrowRight className="size-3.5" /></Button></div>
        {uploads.error ? <p role="alert" className="error">{uploads.error}</p> : uploads.loading ? <p role="status" className="empty">正在加载上传记录…</p> : uploads.data.length ?
          <div className="table-scroll"><table className="overview-upload-table"><thead><tr><th scope="col">文件</th><th scope="col">状态</th><th scope="col">大小</th></tr></thead><tbody>
            {uploads.data.map((item) => <tr key={item.id}><td><strong title={item.filename}>{item.filename}</strong><small>{item.kind === "video" ? "视频" : item.kind === "subtitle" ? "字幕" : "封面"}</small></td><td><Badge variant="secondary" className={`badge ${item.status}`}>{uploadNames[item.status] ?? item.status}</Badge></td><td>{bytes(item.size)}</td></tr>)}
          </tbody></table></div> : <div className="empty"><UploadCloud className="size-7" /><h3>还没有上传记录</h3><p>进入资源库，上传视频并整理到文件夹中。</p><Button variant="outline" onClick={() => navigate("library")}>打开资源库</Button></div>}
        <Pagination {...uploads} loading={uploads.refreshing} label="概览上传分页" />
      </Card>
      <div className="overview-side">
        <Card className="overview-panel">
          <div className="section-heading"><h2>资源状态</h2><Button variant="ghost" size="sm" onClick={() => navigate("library")}>查看<ArrowRight className="size-3.5" /></Button></div>
          <dl className="overview-resource-status">
            {([['published', '已发布'], ['draft', '草稿'], ['archived', '已归档']] as const).map(([status, label]) => <div key={status}><dt><Badge variant="secondary" className={`badge ${status}`}>{label}</Badge></dt><dd>{data?.media[status]?.toLocaleString("zh-CN") ?? "—"}<span> 个视频</span></dd></div>)}
          </dl>
          <p className="overview-storage">媒体用量 <strong>{data ? bytes(data.storageBytes) : "—"}</strong></p>
        </Card>
        <Card className="overview-panel">
          <div className="section-heading"><h2>电视设备</h2><Button variant="ghost" size="sm" onClick={() => navigate("family")}>家庭设置<ArrowRight className="size-3.5" /></Button></div>
          {devices.error ? <p role="alert" className="error">{devices.error}</p> : devices.loading ? <p role="status" className="muted">正在加载设备…</p> : devices.data.length ?
            <div className="overview-devices">{devices.data.map((device) => <div key={device.id}><Monitor className="size-4" /><span><strong>{device.name}</strong><small>最近连接：{dateTime(device.lastSeen)}</small></span></div>)}</div> : <p className="overview-empty-note">还没有绑定电视。可在家庭设置中绑定。</p>}
          <Pagination {...devices} loading={devices.refreshing} label="概览设备分页" />
        </Card>
      </div>
    </div>
    {data && <p className="overview-watch-note">观看次数按家庭时区 {data.watch.timezone} 统计，包含近 7 天开始且有实际播放的记录。</p>}
  </>;
}
