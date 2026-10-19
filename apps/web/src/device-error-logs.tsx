import { Card } from "@/components/ui/card";
import { Loading } from "@/components/ui/loading";
import { Empty } from "@/components/ui/empty";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { bytes, dateTime } from "./api";
import { Pagination, usePagedData } from "./pagination";

type DeviceError = {
  id: string;
  createdAt: string;
  familyName: string;
  deviceName: string;
  category: string;
  code: string;
  causeTypes: string[];
  episodeName: string | null;
  mediaId: string | null;
  positionMs: number | null;
  availableBytes: number | null;
  httpStatus: number | null;
  appVersion: string;
};

export function DeviceErrorLogs() {
  const logs = usePagedData<DeviceError>("/device-error-logs", 0, 10);
  return <>
    <div className="page-title">
      <div><h1>系统日志</h1><p>查看所有家庭的电视错误上报，仅平台超管可访问。</p></div>
    </div>
    <Card className="settings-card">
    <h2>设备错误日志</h2>
    <p className="muted">最近 30 天的播放错误，不包含视频地址和登录信息。</p>
    {logs.error && <Alert variant="destructive"><AlertDescription>{logs.error}</AlertDescription></Alert>}
    {logs.loading && <Loading variant="list" label="正在加载设备错误日志…" />}
    {!logs.loading && !logs.error && logs.data.length === 0 && <Empty className="empty">暂无设备错误</Empty>}
    <div className="grid gap-3">
      {logs.data.map((log) => <div key={log.id} className="rounded-lg border border-border p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className="break-all font-mono">{log.code}</strong>
          <span className="text-muted-foreground">{dateTime(log.createdAt)}</span>
        </div>
        <p className="mt-1">{log.familyName} · {log.deviceName}{log.episodeName ? ` · ${log.episodeName}` : ""}</p>
        <p className="mt-1 break-all text-muted-foreground">{log.causeTypes.join(" → ") || "未提供异常类型"}</p>
        <p className="mt-1 text-muted-foreground">
          {log.positionMs !== null ? `位置 ${Math.round(log.positionMs / 1000)} 秒 · ` : ""}
          {log.httpStatus !== null ? `HTTP ${log.httpStatus} · ` : ""}
          {log.availableBytes !== null ? `电视剩余 ${bytes(log.availableBytes)} · ` : ""}
          客户端 {log.appVersion}
        </p>
      </div>)}
    </div>
    <Pagination {...logs} loading={logs.refreshing} label="设备错误日志分页" />
    </Card>
  </>;
}
