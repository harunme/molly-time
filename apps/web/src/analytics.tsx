import { Fragment, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loading } from "@/components/ui/loading";
import { api } from "./api";
import "./analytics.css";

type Meta = { updatedAt: string; collectionStartedAt: string | null };
type Overview = Meta & { installationCount: number; familyCount: number; boundDevices: number; onlineDevices: number; todayWatchingFamilies: number; weekWatchingFamilies: number; todayVodMs: number; todayLiveMs: number };
type Day = { date: string; newInstallations: number | null; visitingDevices: number | null; watchingFamilies: number; watchingDevices: number; vodMs: number; liveMs: number };
type Family = { id: string; name: string; boundDevices: number; onlineDevices: number; lastSeen: string | null; weekPlayedMs: number };
type Device = { id: string; name: string; revoked: boolean; online: boolean; lastSeen: string; version: string | null };
type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };
const root = "/operations/analytics";
const time = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "尚无记录";
const duration = (ms: number) => ms < 60000 ? `${Math.round(ms / 1000)} 秒` : `${(ms / 3600000).toFixed(1)} 小时`;

function useReport<T>(path: string, refresh = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const previousPath = useRef(path);
  useEffect(() => {
    const controller = new AbortController();
    if (previousPath.current !== path) setData(undefined);
    previousPath.current = path;
    setError("");
    api<T>(root + path, "GET", undefined, undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) setData(value);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [path, refresh]);
  return { data, error };
}
function ErrorMessage({ message }: { message: string }) {
  return message ? <p className="error" role="alert">统计加载失败：{message}。请稍后重试。</p> : null;
}
function Pager({ page, total, onChange }: { page: number; total: number; onChange: (page: number) => void }) {
  return <div className="actions analytics-pagination"><span>共 {total} 条 · 第 {page} 页</span><Button variant="bordered" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</Button><Button variant="bordered" disabled={page * 20 >= total} onClick={() => onChange(page + 1)}>下一页</Button></div>;
}
function Devices({ familyId, refresh }: { familyId: string; refresh: number }) {
  const [page, setPage] = useState(1);
  const { data, error } = useReport<Paged<Device>>(`/devices?familyId=${encodeURIComponent(familyId)}&page=${page}`, refresh);
  return <div className="analytics-devices"><ErrorMessage message={error} />{!data && !error && <Loading label="正在加载设备…" />}{data && <>
    {!data.items.length && <p>这个家庭尚未绑定设备。</p>}
    {data.items.map(d => <div className="analytics-device" key={d.id}><strong>{d.name}</strong><span>{d.revoked ? "已解绑" : d.online ? "在线" : "离线"}</span><span>APK {d.version || "未知"}</span><span>最近访问 {time(d.lastSeen)}</span></div>)}
    {data.total > 20 && <Pager page={page} total={data.total} onChange={setPage} />}
  </>}</div>;
}

export function OperationsAnalytics() {
  const [refresh, setRefresh] = useState(0);
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<"watchingFamilies" | "visitingDevices" | "newInstallations" | "played">("watchingFamilies");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string>();
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(1); setExpanded(undefined); }, 300); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    const update = () => { if (!document.hidden) setRefresh(v => v + 1); };
    const timer = setInterval(update, 30000);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, []);
  const overview = useReport<Overview>("/overview", refresh);
  const daily = useReport<Meta & { items: Day[] }>(`/daily?days=${days}`, refresh);
  const families = useReport<Paged<Family>>(`/families?q=${encodeURIComponent(query)}&page=${page}`, refresh);
  const versions = useReport<{ items: { version: string; count: number }[] }>("/versions", refresh);
  const values = daily.data?.items.map(d => metric === "played" ? (d.vodMs + d.liveMs) / 3600000 : d[metric]) || [];
  const maximum = Math.max(1, ...values.map(v => v || 0));
  const label = { watchingFamilies: "观看家庭", visitingDevices: "访问设备", newInstallations: "新增激活", played: "观看时长（小时）" }[metric];
  const o = overview.data;
  return <div className="analytics-page">
    <div className="section-heading"><div><h2>使用概览</h2><p className="muted">从家庭的实际观看，了解茉莉电视的使用情况。</p></div>{(overview.error || daily.error || families.error || versions.error) && <Button variant="bordered" onClick={() => setRefresh(v => v + 1)}>重试加载</Button>}</div>
    <ErrorMessage message={overview.error} />
    {!o && !overview.error && <Loading label="正在加载使用概览…" />}
    {o && <><div className="analytics-metrics">{[
      ["累计激活安装", o.installationCount, "首次观测的正式版安装"], ["当前绑定设备", o.boundDevices, `${o.familyCount} 个注册家庭`],
      ["当前在线设备", o.onlineDevices, "最近 90 秒内有效通信"], ["今日观看家庭", o.todayWatchingFamilies, "点播与直播合并去重"],
      ["近 7 天观看家庭", o.weekWatchingFamilies, "包含今天"], ["今日观看时长", duration(o.todayVodMs + o.todayLiveMs), `点播 ${duration(o.todayVodMs)} · 直播 ${duration(o.todayLiveMs)}`],
    ].map(([name, value, note]) => <Card key={name} className="analytics-stat"><span>{name}</span><strong>{value}</strong><small>{note}</small></Card>)}</div>
    <p className="muted analytics-caption">北京时间 · 更新于 {time(o.updatedAt)} · 访问及激活采集始于 {time(o.collectionStartedAt)}</p></>}
    <Card className="settings-card"><div className="section-heading"><h3>使用趋势</h3><div className="actions analytics-range">{[7, 30, 90].map(n => <Button size="sm" key={n} variant={days === n ? "default" : "bordered"} aria-pressed={days === n} onClick={() => setDays(n)}>近 {n} 天</Button>)}</div></div>
      <div className="actions analytics-filter">{(["watchingFamilies", "visitingDevices", "newInstallations", "played"] as const).map(key => <Button key={key} variant="bordered" aria-pressed={metric === key} onClick={() => setMetric(key)}>{{ watchingFamilies: "观看家庭", visitingDevices: "访问设备", newInstallations: "新增激活", played: "观看时长" }[key]}</Button>)}</div>
      <ErrorMessage message={daily.error} />
      {!daily.data && !daily.error && <Loading label="正在加载趋势…" />}
      {daily.data && <><div className="analytics-chart" role="img" aria-label={`近 ${days} 天${label}趋势，最高 ${maximum.toFixed(metric === "played" ? 1 : 0)}；详细数值见下方每日数据`}>
        <span className="analytics-chart-scale">{maximum.toFixed(metric === "played" ? 1 : 0)}</span>
        {daily.data.items.map((d, i) => <div className="analytics-bar-slot" key={d.date} title={`${d.date} · ${label} ${values[i] === null ? "未采集" : metric === "played" ? values[i]?.toFixed(2) : values[i]}`}><div className={`analytics-bar ${values[i] === null ? "uncollected" : ""}`} style={{ height: values[i] === null ? "100%" : `${Math.max(values[i] ? 1 : 0, (values[i] || 0) / maximum * 100)}%` }} /></div>)}
      </div><div className="analytics-axis"><span>{daily.data.items[0]?.date}</span><span>{label}</span><span>{daily.data.items[daily.data.items.length - 1]?.date}</span></div>
      <details><summary>每日数据与直播时长</summary><div className="table-scroll"><table className="analytics-table"><thead><tr>{["日期", "新增激活", "访问设备", "观看家庭", "观看设备", "点播时长", "直播时长"].map(x => <th key={x}>{x}</th>)}</tr></thead><tbody>{daily.data.items.slice().reverse().map(d => <tr key={d.date}><td>{d.date}</td><td>{d.newInstallations ?? "未采集"}</td><td>{d.visitingDevices ?? "未采集"}</td><td>{d.watchingFamilies}</td><td>{d.watchingDevices}</td><td>{duration(d.vodMs)}</td><td>{duration(d.liveMs)}</td></tr>)}</tbody></table></div></details></>}
    </Card>
    <Card className="settings-card"><div className="section-heading"><h3>家庭使用明细</h3><Label>搜索家庭<Input value={search} onChange={e => setSearch(e.target.value)} placeholder="家庭名称" /></Label></div><p className="muted">按最近访问排序，展开家庭查看设备与 APK 版本。</p>
      <ErrorMessage message={families.error} />{!families.data && !families.error && <Loading label="正在加载家庭…" />}
      {families.data && <><div className="table-scroll"><table className="analytics-table analytics-family-table"><thead><tr><th>家庭</th><th>绑定 / 在线设备</th><th>最近访问</th><th>近 7 天观看</th></tr></thead><tbody>{families.data.items.map(f => <Fragment key={f.id}><tr><td><Button variant="bordered" aria-expanded={expanded === f.id} onClick={() => setExpanded(expanded === f.id ? undefined : f.id)}>{f.name}</Button></td><td>{f.boundDevices} / {f.onlineDevices}</td><td>{time(f.lastSeen)}</td><td>{duration(f.weekPlayedMs)}</td></tr>{expanded === f.id && <tr><td colSpan={4}><Devices familyId={f.id} refresh={refresh} /></td></tr>}</Fragment>)}</tbody></table></div>{!families.data.items.length && <p>没有匹配的家庭。</p>}<Pager page={page} total={families.data.total} onChange={n => { setPage(n); setExpanded(undefined); }} /></>}
    </Card>
    <Card className="settings-card"><h3>APK 版本分布</h3><p className="muted">近 30 天访问过的正式版安装，按最新上报版本统计。</p><ErrorMessage message={versions.error} />{!versions.data && !versions.error && <Loading label="正在加载版本分布…" />}{versions.data && <div className="analytics-versions">{versions.data.items.length ? versions.data.items.map(v => <div key={v.version}><strong>{v.version}</strong><span>{v.count} 个安装</span></div>) : <p>尚无 APK 采集记录。新版客户端联网后会逐步显示。</p>}</div>}</Card>
    <p className="muted analytics-notes">统计口径：激活量不是下载量或真实人数。已有安装升级后首次上报也会计入；清除数据或卸载重装可能产生新安装。采集前的访问历史无法恢复，斜纹区域表示未采集。观看数据使用已有有效播放记录，包含直播，排除家长预览；离线播放补传后可能更新历史统计。当天数据仍在累计。</p>
  </div>;
}
