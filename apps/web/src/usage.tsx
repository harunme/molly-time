import { Loading } from "@/components/ui/loading";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty } from "@/components/ui/empty";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MonthPicker } from "@/components/ui/month-picker";
import { api, bytes as largeBytes, dateTime } from "./api";
import { Pagination, useDebounced, usePagedData } from "./pagination";

type Usage = {
  id: string; name: string; accountCount: number; month: string; timezone: string;
  statisticsSince: string | null; storageMeasuredAt: string;
  storage: {
    usedBytes: number; localBytes: number; ossBytes: number; pendingBytes: number;
    reservedBytes: number; objectCount: number; unknownSizeCount: number
   };
  traffic: {
    totalBytes: number; localBytes: number; ossBytes: number; requestCount: number;
    lastOssImportAt: string | null
   };
};

const currentMonth = () => new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
}).format(new Date());
const exactBytes = (value: number) => `${value.toLocaleString("zh-CN")} 字节`;
const bytes = (value: number) => value < 1024 ? `${value} B`
  : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : largeBytes(value);

function UsageNotes() {
  return <p className="muted">存储为当前家庭引用的文件容量，包含旧版本和有效分享保留的文件，同一文件在家庭内仅计算一次；家庭之间可能共用文件，家庭容量之和不代表平台实际存储。流量按北京时间自然月汇总，包含播放、下载、字幕和封面。OSS 公网下行仅显示历史已入账数据，不代表当前完整用量。</p>;
}

export function FamilyUsage() {
  const [month, setMonth] = useState(currentMonth);
  const [result, setResult] = useState<{ month: string; value: Usage; }>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<Usage>(`/usage?month=${encodeURIComponent(month)}`, "GET", undefined, undefined, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setResult({ month, value }); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [month]);
  const row = result?.month === month ? result.value : undefined;
  return <Card className="settings-card">
    <div className="section-heading"><h2>家庭用量</h2></div>
    <Label>用量月份<MonthPicker aria-label="用量月份" value={month} onValueChange={setMonth} /></Label>
    {error ? <Alert variant="destructive" className="error" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : !row ? <Loading variant="detail" label="正在加载家庭用量…" /> : <>
      <p>当前文件占用 <strong title={exactBytes(row.storage.usedBytes)}>{bytes(row.storage.usedBytes)}</strong> · 待处理上传 {bytes(row.storage.pendingBytes)}</p>
      <p>本月已统计流量 <strong title={exactBytes(row.traffic.totalBytes)}>{bytes(row.traffic.totalBytes)}</strong></p>
      <p className="muted">服务器下行 {bytes(row.traffic.localBytes)} · OSS 公网下行 {bytes(row.traffic.ossBytes)}<br />计量启用时间：{dateTime(row.statisticsSince)}</p>
      {row.storage.unknownSizeCount > 0 && <p className="error">{row.storage.unknownSizeCount} 个文件大小尚未确认，存储统计不完整。</p>}
    </>}
    <UsageNotes />
  </Card>;
}

export function OperationsUsage() {
  const [month, setMonth] = useState(currentMonth), [search, setSearch] = useState("");
  const query = useDebounced(search);
  const params = new URLSearchParams({ month, q: query }).toString();
  const list = usePagedData<Usage>(`/operations/usage?${params}`);
  return <Card className="settings-card usage-card">
    <div className="section-heading"><h2>家庭用量</h2><div className="actions">
      <Button variant="bordered" asChild><a href={`/api/manage/operations/usage/export?${params}`} download>导出月度 CSV</a></Button>
    </div></div>
    <UsageNotes />
    <div className="grid w-full max-w-[37rem] grid-cols-1 gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
      <Label>用量月份<MonthPicker aria-label="用量月份" value={month} onValueChange={setMonth} /></Label>
      <Label>搜索家庭或账号<Input placeholder="家庭名称、家庭 ID、邮箱或账号 ID" value={search} onChange={(event) => setSearch(event.target.value)} /></Label>
    </div>
    {list.error && <Alert variant="destructive" className="error" role="alert"><AlertDescription>{list.error}</AlertDescription></Alert>}
    {list.loading ? <Loading variant="table" label="正在加载家庭用量…" /> : !list.error && <>
      <div className="table-scroll"><Table className="family-usage-table">
        <TableHeader><TableRow><TableHead>家庭</TableHead><TableHead>当前存储</TableHead><TableHead>待处理上传</TableHead><TableHead>所选月份流量</TableHead></TableRow></TableHeader>
        <TableBody>{list.data.map((row) => <TableRow key={row.id}>
          <TableCell><strong>{row.name}</strong><small>{row.accountCount} 个账号</small><small>{row.id}</small></TableCell>
          <TableCell><strong title={exactBytes(row.storage.usedBytes)}>{bytes(row.storage.usedBytes)}</strong><small>本地 {bytes(row.storage.localBytes)} · OSS {bytes(row.storage.ossBytes)}</small><small>{row.storage.objectCount} 个文件</small>{row.storage.unknownSizeCount > 0 && <small className="error">{row.storage.unknownSizeCount} 个大小未确认</small>}</TableCell>
          <TableCell title={exactBytes(row.storage.pendingBytes)}>{bytes(row.storage.pendingBytes)}</TableCell>
          <TableCell><strong title={exactBytes(row.traffic.totalBytes)}>{bytes(row.traffic.totalBytes)}</strong><small>服务器 {bytes(row.traffic.localBytes)}</small><small>OSS 公网 {bytes(row.traffic.ossBytes)}</small></TableCell>
        </TableRow>)}</TableBody>
      </Table></div>
      {!list.data.length && <Empty className="empty">没有匹配的家庭。</Empty>}
      <Pagination {...list} loading={list.refreshing} label="家庭用量分页" />
    </>}
  </Card>;
}
