import { useEffect, useState } from "react";
import { ChevronRight, Monitor } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dateKey, parseDateKey } from "@/lib/date-only";
import { api, type WatchReport } from "./api";
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
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [pages, setPages] = useState({ session: 1, content: 1 });
  const [result, setResult] = useState<{ data?: Report; error?: string; loading: boolean }>({ loading: true });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult({ loading: true });
    const start = selectedDate ?? daysAgo(today, 30), end = selectedDate ?? today;
    api<Report>(`/reports/watch-time?start=${start}&end=${end}&sessionPage=${pages.session}&contentPage=${pages.content}&pageSize=10`, "GET", undefined, undefined, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setResult({ loading: false, data }); })
      .catch((error) => { if (!controller.signal.aborted) setResult({ loading: false, error: error.message }); });
    return () => controller.abort();
  }, [selectedDate, today, pages.session, pages.content, retry]);
  const data = result.data;
  const days = watch?.days ?? [];
  const recent = days.slice(-31);
  const total = days.reduce((sum, day) => sum + day.playedMs, 0);
  const monthTotal = recent.reduce((sum, day) => sum + day.playedMs, 0);
  const peak = Math.max(0, ...days.map((day) => day.playedMs));
  const chartPeak = Math.max(1, ...recent.map((day) => day.playedMs));
  const hourPeak = Math.max(1, ...(data?.hours ?? []).map((hour) => hour.playedMs));
  const selectDay = (date?: string) => { setResult({ loading: true }); setSelectedDate(date); setPages({ session: 1, content: 1 }); setSessionsOpen(false); };
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
      {selectedDate && <dl className="watch-history-stats">
        <div><dt>当天观看时长</dt><dd><strong>{data ? duration(data.totalPlayedMs) : "—"}</strong><span>{selectedDate}</span></dd></div>
        <div><dt>观看视频</dt><dd><strong>{data ? `${data.episodeCount} 个` : "—"}</strong><span>当天实际播放</span></dd></div>
      </dl>}
      {selectedDate && data?.hours?.length === 24 && <section className="watch-history-hourly" aria-label="当天每小时观看时长">
        <div className="watch-history-hourly-bars">
          {data.hours.map((hour) => <span key={hour.hour} role="img" aria-label={`${hour.hour}点至${hour.hour + 1}点，观看${duration(hour.playedMs)}`} title={`${hour.hour}:00–${String((hour.hour + 1) % 24).padStart(2, "0")}:00 · ${duration(hour.playedMs)}`} data-active={hour.playedMs > 0}>
            <span style={{ height: hour.playedMs ? `${Math.max(5, hour.playedMs / hourPeak * 100)}%` : "2px" }} />
          </span>)}
        </div>
        <div className="watch-history-hourly-labels"><span>0 点</span><span>6 点</span><span>12 点</span><span>18 点</span><span>23 点</span></div>
      </section>}
      {!selectedDate && <><dl className="watch-history-stats">
        {stats.map((stat) => <div key={stat.label}><dt>{stat.label}</dt><dd><strong>{stat.value === undefined ? "—" : duration(stat.value)}</strong><span>{stat.detail}</span></dd></div>)}
      </dl>
      <section className="watch-history-trend" aria-label="最近 31 天的观看趋势">
        <div className="watch-history-bars" role="group" aria-label="每日观看趋势，点击查看当天记录">
          {recent.map((day) => <button type="button" key={day.date} aria-label={`${day.date} · ${duration(day.playedMs)}，查看当天记录`}
            title={`${day.date} · ${duration(day.playedMs)}`} data-active={day.playedMs > 0} aria-pressed={selectedDate === day.date} onClick={() => selectDay(day.date)}>
            <span style={{ height: day.playedMs ? `${Math.max(5, day.playedMs / chartPeak * 100)}%` : "2px" }} />
          </button>)}
        </div>
        <p>每条代表一天 · 仅统计实际播放，不含家长预览。</p>
      </section></>}
      <div className="watch-history-scope"><span>{selectedDate ? <strong>{selectedDate}</strong> : "最近 31 天"}</span></div>
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
