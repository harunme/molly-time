import { useEffect, useState } from "react";
import { ChevronRight, Monitor } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dateKey, parseDateKey } from "@/lib/date-only";
import { api, type WatchReport, type WatchDeviceSegment } from "./api";
import { Pagination } from "./pagination";
import type { OverviewData } from "./overview";

type Report = WatchReport & { sessionTotal: number; contentTotal: number; pageSize: number };
function daysAgo(today: string, count: number) {
  const date = parseDateKey(today)!;
  date.setDate(date.getDate() - count);
  return dateKey(date);
}
function duration(ms: number) {
  if (!ms) return "0 分钟";
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  const minutes = Math.floor(ms / 60000);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
function localTime(value: string, timezone: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

// Hash the device identity so colors stay stable across dates and pagination.
function deviceColor(id: string | null) {
  let hash = 0;
  for (const char of id ?? "legacy-device") hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  return `hsl(${((hash ^ (hash >>> 16)) >>> 0) % 360} 60% 46%)`;
}
type ChartDevice = { id: string | null; name: string };
function WatchBar({ playedMs, peak, devices, names, selectedDevice, onDevice }: {
  playedMs: number; peak: number; devices?: WatchDeviceSegment[]; names?: ChartDevice[];
  selectedDevice?: ChartDevice; onDevice: (device: ChartDevice) => void;
}) {
  return <span className="watch-history-stack" style={{ height: playedMs ? `${playedMs / peak * 100}%` : "2px" }}>
    {devices?.filter((device) => device.playedMs > 0).map((device) => {
      const name = names?.find((entry) => entry.id === device.deviceId)?.name ?? "旧设备身份";
      return <button type="button" key={device.deviceId ?? "legacy"} aria-label={`${name} · ${duration(device.playedMs)}，查看该设备记录`}
        aria-pressed={selectedDevice?.id === device.deviceId}
        onClick={(event) => { event.stopPropagation(); onDevice({ id: device.deviceId, name }); }}
        style={{ height: `${device.playedMs / playedMs * 100}%`, background: deviceColor(device.deviceId), opacity: selectedDevice && selectedDevice.id !== device.deviceId ? .3 : 1 }} />;
    })}
  </span>;
}

export function WatchHistoryDialog({ open, onClose, today, watch, start, end, restoreFocus }: {
  open: boolean; onClose: () => void; today: string; watch?: OverviewData["watch"]; start?: string; end?: string; restoreFocus: () => void;
}) {
  return <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
    <DialogContent className="watch-history-dialog" onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}>
      {open && <WatchHistory key={`${start ?? ""}|${end ?? ""}`} today={today} watch={watch} initialDate={start === end ? start : undefined} />}
    </DialogContent>
  </Dialog>;
}

function WatchHistory({ today, watch, initialDate }: { today: string; watch?: OverviewData["watch"]; initialDate?: string }) {
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [selectedDevice, setSelectedDevice] = useState<ChartDevice>();
  const [chartSelection, setChartSelection] = useState<string | number>();
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [pages, setPages] = useState({ session: 1, content: 1 });
  const [result, setResult] = useState<{ data?: Report; chartData?: Report; error?: string; loading: boolean }>({ loading: true });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult((previous) => ({ chartData: previous.chartData, loading: true }));
    const start = selectedDate ?? daysAgo(today, 30), end = selectedDate ?? today;
    const path = `/reports/watch-time?start=${start}&end=${end}&sessionPage=${pages.session}&contentPage=${pages.content}&pageSize=10`;
    const chart = api<Report>(path, "GET", undefined, undefined, controller.signal);
    const deviceQuery = selectedDevice ? selectedDevice.id === null ? "&unassignedDevice=true" : `&deviceId=${encodeURIComponent(selectedDevice.id)}` : "";
    const report = deviceQuery ? api<Report>(path + deviceQuery, "GET", undefined, undefined, controller.signal) : chart;
    Promise.all([chart, report])
      .then(([chartData, data]) => { if (!controller.signal.aborted) setResult({ loading: false, chartData, data }); })
      .catch((error) => { if (!controller.signal.aborted) setResult((previous) => ({ chartData: previous.chartData, loading: false, error: error.message })); });
    return () => controller.abort();
  }, [selectedDate, selectedDevice, today, pages.session, pages.content, retry]);
  const data = result.data;
  const chartData = result.chartData;
  const days = watch?.days ?? [];
  const recent: WatchReport["days"] = chartData?.days ?? days.slice(-31);
  const total = days.reduce((sum, day) => sum + day.playedMs, 0);
  const monthTotal = days.slice(-31).reduce((sum, day) => sum + day.playedMs, 0);
  const peak = Math.max(0, ...days.map((day) => day.playedMs));
  const chartPeak = Math.max(1, ...recent.map((day) => day.playedMs));
  const hourPeak = Math.max(1, ...(chartData?.hours ?? []).map((hour) => hour.playedMs));
  const describe = (label: string, playedMs: number, segments?: WatchDeviceSegment[]) => [
    `${label} · ${duration(playedMs)}`,
    ...(segments ?? []).filter((segment) => segment.playedMs > 0).map((segment) =>
      `${chartData?.devices?.find((device) => device.id === segment.deviceId)?.name ?? "旧设备身份"} ${duration(segment.playedMs)}`),
  ].join(" · ");
  const selectedHour = typeof chartSelection === "number" ? chartData?.hours.find((hour) => hour.hour === chartSelection) : undefined;
  const selectedDay = typeof chartSelection === "string" ? recent.find((day) => day.date === chartSelection) : undefined;
  const chartDetail = selectedHour ? describe(`${selectedHour.hour}:00–${String((selectedHour.hour + 1) % 24).padStart(2, "0")}:00`, selectedHour.playedMs, selectedHour.devices)
    : selectedDay ? describe(selectedDay.date, selectedDay.playedMs, selectedDay.devices) : "";
  const selectDevice = (device?: ChartDevice, date = selectedDate) => {
    if (device?.id === selectedDevice?.id && date === selectedDate) { setSessionsOpen(true); return; }
    setResult((previous) => ({ chartData: date === selectedDate ? previous.chartData : undefined, loading: true }));
    setSelectedDevice(device); setSelectedDate(date); setPages({ session: 1, content: 1 }); setSessionsOpen(true);
  };
  const legend = chartData?.devices?.length ? <div className="watch-history-device-legend" aria-label="设备颜色图例">
    {chartData.devices.map((device) => <button type="button" key={device.id ?? "legacy"} aria-pressed={selectedDevice?.id === device.id}
      onClick={() => selectDevice(device)}><i style={{ background: deviceColor(device.id) }} />{device.name}</button>)}
  </div> : null;
  const selectDay = (date?: string) => { setChartSelection(undefined); setResult({ loading: true }); setSelectedDate(date); setPages({ session: 1, content: 1 }); setSessionsOpen(false); };
  const stats = [
    { label: "今天", value: watch?.todayPlayedMs, detail: "今日观看时长" },
    { label: "最近 31 天", value: watch ? monthTotal : undefined, detail: `${recent.filter((day) => day.playedMs > 0).length} 天有观看` },
    { label: "单日最多", value: watch ? peak : undefined, detail: "近一年" },
    { label: "累计", value: watch ? total : undefined, detail: "近一年观看时长" },
  ];
  return <>
    <DialogHeader>
      <DialogTitle>观看记录</DialogTitle>
      <DialogDescription>{data?.lastSync ? `最后同步 ${localTime(data.lastSync, data.timezone)}` : "家庭的观看时光"}</DialogDescription>
    </DialogHeader>
    <div className="watch-history-body">
      {(selectedDate || selectedDevice) && <dl className="watch-history-stats">
        <div><dt>{selectedDate ? "当天观看时长" : "最近 31 天观看时长"}</dt><dd><strong>{data ? duration(data.totalPlayedMs) : "—"}</strong><span>{selectedDate ?? "最近 31 天"}{selectedDevice ? ` · ${selectedDevice.name}` : ""}</span></dd></div>
        <div><dt>观看视频</dt><dd><strong>{data ? `${data.episodeCount} 个` : "—"}</strong><span>{selectedDate ? "当天" : "这段时间"}实际播放</span></dd></div>
      </dl>}
      {selectedDate && chartData?.hours?.length === 24 && <section className="watch-history-hourly" aria-label="当天每小时观看时长">
        <div className="watch-history-hourly-bars">
          {chartData.hours.map((hour) => {
            const label = describe(`${hour.hour}:00–${String((hour.hour + 1) % 24).padStart(2, "0")}:00`, hour.playedMs, hour.devices);
            return <div key={hour.hour} role="group" aria-label={label} title={label} data-active={hour.playedMs > 0}
              onMouseEnter={() => setChartSelection(hour.hour)} onFocus={() => setChartSelection(hour.hour)}>
              <WatchBar playedMs={hour.playedMs} peak={hourPeak} devices={hour.devices} names={chartData.devices} selectedDevice={selectedDevice} onDevice={(device) => selectDevice(device)} />
            </div>;
          })}
        </div>
        <div className="watch-history-hourly-labels"><span>0 点</span><span>6 点</span><span>12 点</span><span>18 点</span><span>23 点</span></div>
        {legend}
        {chartDetail && <p className="watch-history-chart-detail" aria-live="polite">{chartDetail}</p>}
      </section>}
      {!selectedDate && <>{!selectedDevice && <dl className="watch-history-stats">
        {stats.map((stat) => <div key={stat.label}><dt>{stat.label}</dt><dd><strong>{stat.value === undefined ? "—" : duration(stat.value)}</strong><span>{stat.detail}</span></dd></div>)}
      </dl>}
      <section className="watch-history-trend" aria-label="最近 31 天的观看趋势">
        <div className="watch-history-bars" role="group" aria-label="每日观看趋势，点击查看当天记录">
          {recent.map((day) => {
            const label = describe(day.date, day.playedMs, day.devices);
            return <div key={day.date} role="group" aria-label={label}
              title={label} data-active={day.playedMs > 0} onMouseEnter={() => setChartSelection(day.date)} onFocus={() => setChartSelection(day.date)}>
              <WatchBar playedMs={day.playedMs} peak={chartPeak} devices={day.devices} names={chartData?.devices} selectedDevice={selectedDevice} onDevice={(device) => selectDevice(device, day.date)} />
              {!day.playedMs && <button type="button" className="watch-history-empty-bar" aria-label={`${day.date}，查看当天记录`} onClick={() => selectDay(day.date)} />}
            </div>;
          })}
        </div>
        {legend}
        {chartDetail && <p className="watch-history-chart-detail" aria-live="polite">{chartDetail}</p>}
        <p>每条代表一天 · 仅统计实际播放，不含家长预览。</p>
      </section></>}
      <div className="watch-history-scope"><span>{selectedDate ? <strong>{selectedDate}</strong> : "最近 31 天"}{selectedDevice && ` · ${selectedDevice.name}`}</span>{selectedDevice && <Button variant="ghost" size="sm" onClick={() => selectDevice()}>全部设备</Button>}</div>
      {result.error && <Alert variant="destructive" role="alert"><AlertDescription>{result.error}</AlertDescription><Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>重试</Button></Alert>}
      {selectedDate && result.loading && <p className="watch-history-note" role="status">正在加载当天记录…</p>}
      {selectedDate && data?.totalPlayedMs === 0 && <div className="watch-history-empty">当天没有观看记录</div>}
      {(!selectedDate || data && data.totalPlayedMs > 0) && <>
      <details className="watch-history-detail" open={sessionsOpen} onToggle={(event) => setSessionsOpen(event.currentTarget.open)}>
        <summary>播放明细<ChevronRight className="size-4" /></summary>
        {result.loading ? <p className="watch-history-note" role="status">正在加载观看记录…</p> : data && <>
          {data.sessions.length ? <ul className="watch-history-list">{data.sessions.map((session) => <li key={session.id}>
            <div className="watch-history-row-title"><strong>{session.name}</strong><span>{duration(session.playedMs)}</span></div>
            <div className="watch-history-row-meta"><span><Monitor className="size-3" />{session.deviceName}</span><time dateTime={session.startedAt}>{localTime(session.startedAt, data.timezone)}</time><span>{session.ended ? "正常结束" : "播放中或未正常结束"}</span></div>
          </li>)}</ul> : <p className="watch-history-note">{data.statisticsSince ? "这段时间还没有观看记录。" : "在电视上播放视频后，这里会显示观看记录。"}</p>}
          {data.sessionTotal > data.pageSize && <Pagination page={pages.session} pageSize={data.pageSize} total={data.sessionTotal} setPage={(session) => setPages({ ...pages, session })} label="播放明细分页" />}
        </>}
      </details>
      <details className="watch-history-detail">
        <summary>内容分布<ChevronRight className="size-4" /></summary>
        {result.loading ? <p className="watch-history-note" role="status">正在加载观看记录…</p> : data && <>
          {data.contents.length ? <ul className="watch-history-list">{data.contents.map((content) => <li key={content.id}>
            <div className="watch-history-row-title"><strong>{content.name}</strong><span>{duration(content.playedMs)}</span></div>
          </li>)}</ul> : <p className="watch-history-note">这段时间还没有观看记录。</p>}
          {data.contentTotal > data.pageSize && <Pagination page={pages.content} pageSize={data.pageSize} total={data.contentTotal} setPage={(content) => setPages({ ...pages, content })} label="内容分布分页" />}
        </>}
      </details>
      </>}
      <p className="watch-history-footer">时区 {watch?.timezone ?? data?.timezone ?? "—"}</p>
    </div>
  </>;
}
