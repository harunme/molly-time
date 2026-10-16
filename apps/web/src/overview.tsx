import { Alert, AlertDescription } from "@/components/ui/alert";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChartColumn, Clock, Monitor, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "./api";
import { ParentReminderActions, useReminderData } from "./reminders";
import type { Run } from "./main";
import { useLocation, useNavigate } from "react-router";
import { dateKey, parseDateKey } from "@/lib/date-only";
import { WatchHistoryDialog } from "./watch-history";

export type OverviewData = {
  media: { folders: number; videos: number; published: number; draft: number; archived: number; };
  resources: { series: number; episodes: number; subtitles: number; };
  uploads: { active: number; failed: number; ready: number; };
  devices: { active: number; revoked: number; online: number; };
  children: number;
  storageBytes: number;
  watch: {
    last7DaysSessions: number; timezone: string; todayPlayedMs: number; weekPlayedMs: number;
    weekStart: string; mostPlayedVideos: { id: string; name: string; playCount: number; }[];
    days: { date: string; playedMs: number; }[];
  };
};

type Destination = "library" | "upload" | "watch" | "family";

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

function MostPlayedChart({ videos }: { videos: OverviewData["watch"]["mostPlayedVideos"]; }) {
  if (!videos.length) return <p className="overview-empty-note">暂无观看记录</p>;
  const peak = Math.max(1, ...videos.map((video) => video.playCount));
  return <div className="overview-ranking" role="img" aria-label={videos.map((video) => `${video.name}：${video.playCount} 次`).join("；")}>
    {videos.map((video) => <div className="overview-ranking-item" key={video.id}>
      <span className="overview-ranking-name" title={video.name}>{video.name}</span>
      <div className="overview-ranking-measure">
        <span className="overview-ranking-track"><span className="overview-ranking-bar" style={{ width: `${video.playCount / peak * 100}%` }} /></span>
        <span className="overview-ranking-count">{video.playCount} 次</span>
      </div>
    </div>)}
  </div>;
}

export function Overview({ familyName, navigate, run, readonly, notify, reminders }: {
  familyName: string; navigate: (page: Destination) => void;
  run: Run; readonly: boolean; notify: (value: string) => void;
  reminders: ReturnType<typeof useReminderData>;
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
  const loading = !data && busy;
  const onlineCount = reminders.devices?.filter((device) => device.online).length ?? data?.devices.online;
  const watching = reminders.devices?.filter((device) => device.online && device.currentWatch) ?? [];
  const onlineDevices = reminders.devices?.filter((device) => device.online) ?? [];
  const bootKnown = onlineDevices.every((device) => typeof device.bootPlayedMs === "number");
  const liveDetail = watching.map((device) => `${device.name} · ${device.currentWatch!.name}`).join("；");
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
    { label: "本次观看时长", value: reminders.devices && bootKnown ? duration(onlineDevices.reduce((sum, device) => sum + (device.bootPlayedMs ?? 0), 0)) : "—", detail: !bootKnown ? "请更新电视客户端，以统计本次开机观看时长" : onlineDevices.length > 1 ? `${onlineDevices.length} 台电视本次开机观看合计 · 每 5 秒更新` : "本次开机累计观看 · 切换视频继续累计", icon: Clock, page: "watch" },
    { label: "正在观看", value: reminders.devices ? watching.map((device) => device.currentWatch!.name).join("、") || "暂无正在观看" : "—", detail: liveDetail || "电视播放后显示 · 每 5 秒更新", icon: Play, page: "watch" },
    { label: "今日观看时长", value: data ? duration(data.watch.todayPlayedMs) : "—", detail: "今天 00:00 至现在", icon: Clock, page: "watch" },
    { label: "本周观看时长", value: data ? duration(data.watch.weekPlayedMs) : "—", detail: "本周一至现在", icon: Clock, page: "watch" },
  ] as const;
  const renderMetric = (metric: typeof metrics[number]) => <div className={`overview-metric ${metric.label === "正在观看" ? "overview-now" : metric.label === "本次观看时长" ? "overview-session" : metric.label === "在线设备" ? "overview-online" : "overview-stat"}`} key={metric.label}>
        <div className="overview-metric-label"><span>{metric.label}</span><metric.icon className="size-4" /></div>
        <strong className={`overview-metric-value${metric.label === "正在观看" ? " overview-current-value" : ""}`} title={metric.value}>
          {(metric.label === "本次观看时长" || metric.label === "正在观看" ? !reminders.devices && !reminders.error : loading && !(metric.label === "在线设备" && onlineCount !== undefined)) ? <span className="overview-skeleton overview-metric-skeleton" aria-hidden="true" /> : metric.label === "正在观看" ? metric.value : metric.value.split(/(\d+)/).map((part, index) => /^\d+$/.test(part) ? part : <span className="overview-metric-unit" key={index}>{part}</span>)}
        </strong>
        <div className="overview-metric-bottom"><span title={metric.detail}>{metric.detail}</span>{metric.label !== "正在观看" && metric.label !== "本次观看时长" && <Button variant="ghost" size="icon" aria-label={`查看${metric.label}`} onClick={() => metric.page === "watch" ? openWatch(metric.label === "今日观看时长" ? today : undefined) : navigate(metric.page)}><ArrowRight className="size-4" /></Button>}</div>
        {metric.label === "在线设备" && <ParentReminderActions data={reminders} readonly={readonly} run={run} notify={notify} />}
      </div>;
  return <>
    <WatchHistoryDialog open={watchOpen} onClose={closeWatch} today={today} watch={data?.watch}
      start={parseDateKey(params.get("start") ?? "") ? params.get("start")! : undefined}
      end={parseDateKey(params.get("end") ?? "") ? params.get("end")! : undefined}
      restoreFocus={() => { const target = opener.current?.isConnected ? opener.current : heatmap.current?.querySelector<HTMLButtonElement>(".section-heading button"); target?.focus(); }} />
    <div className="page-title">
      <div><h1>概览</h1><p>{familyName}的设备在线状态与观看习惯。</p></div>
    </div>
    {error && <Alert variant="destructive" role="alert" className="banner error"><AlertDescription>{error}</AlertDescription></Alert>}
    {loading && <p role="status" className="sr-only">正在加载概览…</p>}
    <Card className="overview-panel overview-resources" aria-busy={loading}>
      <div className="section-heading"><h2>资源概览</h2><Button variant="ghost" size="sm" onClick={() => navigate("library")}>资源库<ArrowRight className="size-3.5" /></Button></div>
      <dl className="overview-resource-counts">
        {([
          ["series", "动画片", "部"], ["episodes", "已发布视频", "集"], ["subtitles", "字幕", "个"],
        ] as const).map(([key, label, unit]) => <div key={key}><dt>{label}</dt><dd>{loading ? <span className="overview-skeleton overview-metric-skeleton" aria-hidden="true" /> : <><strong>{data?.resources[key].toLocaleString("zh-CN") ?? "—"}</strong><span>{unit}</span></>}</dd></div>)}
      </dl>
    </Card>
    <div className="overview-metrics" aria-busy={loading}>
      <Card className="overview-live">
        {renderMetric(metrics[2])}
        {renderMetric(metrics[1])}
        {renderMetric(metrics[0])}
      </Card>
      <Card className="overview-summary">
        {metrics.slice(3).map(renderMetric)}
        <div className="overview-metric overview-most-played" aria-label="播放次数最多的视频">
          <div className="overview-metric-label"><span>播放次数最多的视频</span><ChartColumn className="size-4" /></div>
          {loading ? <span className="overview-skeleton overview-ranking-skeleton" aria-hidden="true" />
            : data ? <MostPlayedChart videos={data.watch.mostPlayedVideos ?? []} /> : <p className="overview-empty-note">播放次数加载失败</p>}
        </div>
      </Card>
    </div>
    <Card className="overview-panel overview-heatmap" ref={heatmap} aria-busy={loading}>
      <div className="section-heading"><h2>观看热力图</h2><Button variant="ghost" size="sm" disabled={!data} onClick={() => openWatch()}>查看明细<ArrowRight className="size-3.5" /></Button></div>
      {data ? <WatchHeatmap watch={data.watch} onOpen={(date) => openWatch(date, date)} /> : loading ? <div className="overview-heatmap-body" aria-hidden="true">
        <div className="overview-heatmap-summary"><span className="overview-skeleton h-5 w-32" /><span className="overview-skeleton h-5 w-24" /><span className="overview-skeleton h-4 w-48" /></div>
        <div className="overview-skeleton overview-heatmap-skeleton" />
      </div> : <p className="overview-empty-note">观看热力图加载失败，请重新进入概览。</p>}
      {data && <p className="overview-watch-note">时区 {data.watch.timezone} · 每格一天 · 不含家长预览</p>}
    </Card>

  </>;
}
