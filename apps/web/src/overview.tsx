import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty } from "@/components/ui/empty";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Clock, Heart, Monitor, UploadCloud } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, bytes, dateTime, type Upload } from "./api";
import { Pagination, usePagedData } from "./pagination";
import { ParentReminderActions, useReminderData } from "./reminders";
import type { Run } from "./main";
import { useLocation, useNavigate } from "react-router";
import { dateKey, parseDateKey } from "@/lib/date-only";
import { WatchHistoryDialog } from "./watch-history";

export type OverviewData = {
  media: { folders: number; videos: number; published: number; draft: number; archived: number; };
  uploads: { active: number; failed: number; ready: number; };
  devices: { active: number; revoked: number; online: number; };
  children: number;
  storageBytes: number;
  watch: {
    last7DaysSessions: number; timezone: string; todayPlayedMs: number; weekPlayedMs: number;
    weekStart: string; favoriteVideo: { id: string; name: string; playedMs: number; } | null;
    days: { date: string; playedMs: number; }[];
  };
};

type Destination = "library" | "upload" | "watch" | "family";
const uploadNames: Record<string, string> = {
  uploading: "上传中", processing: "检查中", ready: "文件就绪", failed: "检查失败", cancelled: "已取消",
};

function duration(value: number) {
  if (value === 0) return "0 分钟";
  if (value < 60000) return `${Math.max(1, Math.round(value / 1000))} 秒`;
  const minutes = Math.floor(value / 60000);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

const heatLevels = ["未观看", "不足 15 分钟", "15–30 分钟", "30–60 分钟", "60 分钟及以上"];
function heatLevel(playedMs: number) {
  return playedMs === 0 ? 0 : playedMs < 15 * 60000 ? 1 : playedMs < 30 * 60000 ? 2 : playedMs < 60 * 60000 ? 3 : 4;
}

function WatchHeatmap({ watch, onOpen }: { watch: OverviewData["watch"]; onOpen: (date: string) => void; }) {
  const [selectedDate, setSelectedDate] = useState<string>();
  const scroll = useRef<HTMLDivElement>(null);
  const days = watch.days;
  const firstDate = days[0]?.date;
  useEffect(() => {
    const container = scroll.current;
    if (!container) return;
    const latest = () => { container.scrollLeft = container.scrollWidth; };
    latest();
    const observer = new ResizeObserver(latest);
    observer.observe(container);
    return () => observer.disconnect();
  }, [firstDate]);
  if (!days.length) return <p className="overview-empty-note">还没有观看记录。</p>;
  const selected = days.find((day) => day.date === selectedDate) ?? days[days.length - 1];
  const offset = (new Date(`${firstDate}T00:00:00Z`).getUTCDay() + 6) % 7;
  const columns = Math.ceil((offset + days.length) / 7);
  const activeDays = days.filter((day) => day.playedMs > 0).length;
  const total = days.reduce((sum, day) => sum + day.playedMs, 0);
  const months = days.flatMap((day, index) => index === 0 || day.date.slice(0, 7) !== days[index - 1].date.slice(0, 7)
    ? [{ label: `${Number(day.date.slice(5, 7))}月`, column: Math.floor((index + offset) / 7) + 2, key: day.date }] : [])
    .filter((month, index, labels) => !labels[index + 1] || labels[index + 1].column - month.column >= 3);
  return <div className="overview-heatmap-body">
    <div className="overview-heatmap-summary"><span>近一年 <strong>{activeDays}</strong> 天有观看</span><span>共 <strong>{duration(total)}</strong></span><span>{firstDate} 至 {days[days.length - 1].date}</span>
      {!activeDays && <p className="overview-empty-note">近一年还没有观看记录，电视播放后会在这里显示。</p>}
    </div>
    <div className="overview-heatmap-visual">
    <div className="overview-heatmap-scroll" ref={scroll}>
      <div className="overview-heatmap-grid" role="group" aria-label="每日观看热力图" aria-description="每格代表一天，点击查看当天记录，用方向键选择日期，左右滑动可查看全年。" style={{ gridTemplateColumns: `28px repeat(${columns}, var(--spacing-heatmap-cell))` }}>
        {months.map((month) => <span className="overview-heatmap-month" key={month.key} style={{ gridColumn: `${month.column} / span ${Math.min(4, columns + 2 - month.column)}`, gridRow: 1 }}>{month.label}</span>)}
        {["一", "二", "三", "四", "五", "六", "日"].map((day, index) => <span className="overview-heatmap-weekday" key={day} style={{ gridRow: index + 2, gridColumn: 1 }}>{index % 2 === 0 ? day : ""}</span>)}
        {days.map((day, index) => {
          const label = `${day.date} · ${day.playedMs ? duration(day.playedMs) : "未观看"}`;
          return <Button variant="ghost" size="icon" type="button" key={day.date} className="overview-heatmap-day" data-level={heatLevel(day.playedMs)}
            style={{ gridColumn: Math.floor((index + offset) / 7) + 2, gridRow: (index + offset) % 7 + 2 }}
            aria-label={label} title={label} aria-pressed={selected.date === day.date} tabIndex={selected.date === day.date ? 0 : -1}
            onClick={() => { setSelectedDate(day.date); onOpen(day.date); }} onFocus={() => setSelectedDate(day.date)}
            onKeyDown={(event) => {
              const change = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
              if (change === undefined && event.key !== "Home" && event.key !== "End") return;
              event.preventDefault();
              const next = event.key === "Home" ? 0 : event.key === "End" ? days.length - 1 : Math.max(0, Math.min(days.length - 1, index + change!));
              const cells = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(".overview-heatmap-day");
              cells?.[next]?.focus();
            }} />;
        })}
      </div>
    </div>
    <div className="overview-heatmap-footer">
      <p aria-live="polite">{selected.date} <strong>{selected.playedMs ? `观看 ${duration(selected.playedMs)}` : "未观看"}</strong></p>
      <div className="overview-heatmap-legend" aria-label="颜色越深，观看时长越长"><span>少</span>{heatLevels.map((label, index) => <span key={label} className="overview-heatmap-swatch" data-level={index} title={label} aria-label={label} />)}<span>多</span></div>
    </div>
    </div>
  </div>;
}

export function Overview({ familyName, navigate, run, readonly, notify }: {
  familyName: string; navigate: (page: Destination) => void;
  run: Run; readonly: boolean; notify: (value: string) => void;
}) {
  const location = useLocation();
  const routerNavigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const watchOpen = params.get("watch") === "1";
  const opener = useRef<HTMLElement | null>(null);
  const heatmap = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<OverviewData>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const reminders = useReminderData(true);
  const onlineCount = reminders.devices?.filter((device) => device.online).length ?? data?.devices.online;
  const uploads = usePagedData<Upload>("/uploads", 0, 5);
  const devices = usePagedData<{ id: string; name: string; lastSeen: string; }>(
    "/devices?activeOnly=true", 0, 5,
  );
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError("");
    const refresh = () => api<OverviewData>("/overview", "GET", undefined, undefined, controller.signal)
      .then((value) => { if (!controller.signal.aborted) { setData(value); setError(""); } })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  const today = data?.watch.days[data.watch.days.length - 1]?.date ?? dateKey(new Date());
  const openWatch = (start?: string, end = today) => {
    opener.current = document.activeElement as HTMLElement;
    const next = new URLSearchParams(location.search);
    next.set("watch", "1");
    if (start) { next.set("start", start); next.set("end", end); }
    else { next.delete("start"); next.delete("end"); }
    routerNavigate(`${location.pathname}?${next}`, { state: { watchReturnTo: location.pathname + location.search } });
  };
  const closeWatch = () => {
    const next = new URLSearchParams(location.search);
    ["watch", "start", "end"].forEach((key) => next.delete(key));
    const background = `${location.pathname}${next.size ? `?${next}` : ""}`;
    if (location.state?.watchReturnTo === background) routerNavigate(-1);
    else routerNavigate(background, { replace: true });
  };
  const metrics = [
    { label: "在线设备", value: onlineCount !== undefined ? `${onlineCount} 台` : "—", detail: data ? `共绑定 ${data.devices.active} 台 · 每 5 秒更新` : "最近 90 秒内有连接", icon: Monitor, page: "family" },
    { label: "今日观看时长", value: data ? duration(data.watch.todayPlayedMs) : "—", detail: "今天 00:00 至现在", icon: Clock, page: "watch" },
    { label: "本周观看时长", value: data ? duration(data.watch.weekPlayedMs) : "—", detail: "本周一至现在", icon: Clock, page: "watch" },
    { label: "最喜欢的视频", value: data ? data.watch.favoriteVideo?.name ?? "暂无观看记录" : "—", detail: data?.watch.favoriteVideo ? `累计观看 ${duration(data.watch.favoriteVideo.playedMs)}` : "按累计观看时长排名", icon: Heart, page: "watch" },
  ] as const;
  return <>
    <WatchHistoryDialog open={watchOpen} onClose={closeWatch} today={today} watch={data?.watch}
      start={parseDateKey(params.get("start") ?? "") ? params.get("start")! : undefined}
      end={parseDateKey(params.get("end") ?? "") ? params.get("end")! : undefined}
      restoreFocus={() => { const target = opener.current?.isConnected ? opener.current : heatmap.current?.querySelector<HTMLButtonElement>(".section-heading button"); target?.focus(); }} />
    <div className="page-title">
      <div><h1>概览</h1><p>{familyName}的设备在线状态与观看习惯。</p></div>
    </div>
    {error && <Alert variant="destructive" role="alert" className="banner error"><AlertDescription>{error}</AlertDescription></Alert>}
    {!data && busy && <p role="status" className="muted">正在加载概览…</p>}
    <div className="overview-metrics">
      {metrics.map((metric) => <Card className="overview-metric" key={metric.label}>
        <div className="overview-metric-label"><span>{metric.label}</span><metric.icon className="size-4" /></div>
        <strong className={`overview-metric-value${metric.label === "最喜欢的视频" ? " overview-favorite-value" : ""}`} title={metric.value}>
          {metric.label === "最喜欢的视频" ? metric.value : metric.value.split(/(\d+)/).map((part, index) => /^\d+$/.test(part) ? part : <span className="overview-metric-unit" key={index}>{part}</span>)}
        </strong>
        <div className="overview-metric-bottom"><span>{metric.detail}</span><Button variant="ghost" size="icon" aria-label={`查看${metric.label}`} onClick={() => metric.page === "watch" ? openWatch(metric.label === "今日观看时长" ? today : undefined) : navigate(metric.page)}><ArrowRight className="size-4" /></Button></div>
        {metric.label === "在线设备" && <ParentReminderActions data={reminders} readonly={readonly} run={run} notify={notify} />}
      </Card>)}
    </div>
    <Card className="overview-panel overview-heatmap" ref={heatmap}>
      <div className="section-heading"><h2>观看热力图</h2><Button variant="ghost" size="sm" onClick={() => openWatch()}>查看明细<ArrowRight className="size-3.5" /></Button></div>
      {data ? <WatchHeatmap watch={data.watch} onOpen={(date) => openWatch(date, date)} /> : <p className="overview-empty-note">{busy ? "正在加载观看热力图…" : "观看热力图加载失败，请重新进入概览。"}</p>}
      {data && <p className="overview-watch-note">时区 {data.watch.timezone} · 每格一天 · 不含家长预览</p>}
    </Card>
    <div className="overview-panels">
      <Card className="overview-panel overview-uploads">
        <div className="section-heading"><h2>最近上传</h2><Button variant="ghost" size="sm" onClick={() => navigate("upload")}>全部任务<ArrowRight className="size-3.5" /></Button></div>
        {uploads.error ? <Alert variant="destructive" role="alert" className="error"><AlertDescription>{uploads.error}</AlertDescription></Alert> : uploads.loading ? <Empty role="status" className="empty">正在加载上传记录…</Empty> : uploads.data.length ?
          <div className="table-scroll"><Table className="overview-upload-table"><TableHeader><TableRow><TableHead scope="col">文件</TableHead><TableHead scope="col">状态</TableHead><TableHead scope="col">大小</TableHead></TableRow></TableHeader><TableBody>
            {uploads.data.map((item) => <TableRow key={item.id}><TableCell><strong title={item.filename}>{item.filename}</strong><small>{item.kind === "video" ? "视频" : item.kind === "subtitle" ? "字幕" : "封面"}</small></TableCell><TableCell><Badge variant="secondary" className={`badge ${item.status}`}>{uploadNames[item.status] ?? item.status}</Badge></TableCell><TableCell>{bytes(item.size)}</TableCell></TableRow>)}
          </TableBody></Table></div> : <Empty className="empty"><UploadCloud className="size-7" /><h3>还没有上传记录</h3><p>进入资源库，上传视频并整理到文件夹中。</p><Button variant="bordered" onClick={() => navigate("library")}>打开资源库</Button></Empty>}
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
          {devices.error ? <Alert variant="destructive" role="alert" className="error"><AlertDescription>{devices.error}</AlertDescription></Alert> : devices.loading ? <p role="status" className="muted">正在加载设备…</p> : devices.data.length ?
            <div className="overview-devices">{devices.data.map((device) => <div key={device.id}><Monitor className="size-4" /><span><strong>{device.name}</strong><small>最近连接：{dateTime(device.lastSeen)}</small></span></div>)}</div> : <p className="overview-empty-note">还没有绑定电视。可在家庭设置中绑定。</p>}
          <Pagination {...devices} loading={devices.refreshing} label="概览设备分页" />
        </Card>
      </div>
    </div>
  </>;
}
