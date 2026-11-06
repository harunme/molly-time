import { Card } from "@/components/ui/card";
import { Loading } from "@/components/ui/loading";
import { Empty } from "@/components/ui/empty";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { bytes, dateTime } from "./api";
import { Pagination, usePagedData } from "./pagination";
import { useState } from "react";
import { SelectField } from "@/components/ui/select";

const sources = [
  { value: "", label: "全部客户端" }, { value: "android-parent", label: "安卓家长端" },
  { value: "ios-parent", label: "iOS 家长端" }, { value: "web-parent", label: "网页管理端" },
  { value: "tv-android", label: "安卓电视端" }, { value: "tv-web", label: "电视网页" },
];
type ClientError = {
  id: string; occurredAt: string; createdAt: string; source: string; familyName: string;
  deviceName: string | null; code: string; fatal: boolean; errorType: string; stack: string[];
  breadcrumbs: { name: string; at: string }[]; screen: string; appVersion: string;
  osVersion: string; deviceModel: string;
};

function ClientErrorLogs() {
  const [source, setSource] = useState("");
  const [severity, setSeverity] = useState("");
  const params = new URLSearchParams();
  if (source) params.set("source", source);
  if (severity) params.set("fatal", severity);
  const logs = usePagedData<ClientError>(`/client-error-logs?${params}`, 0, 10);
  return <Card className="settings-card">
    <h2>客户端异常</h2>
    <p className="muted">最近 30 天的崩溃和运行时错误。崩溃记录可在客户端再次启动并登录后补传。</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <SelectField aria-label="日志客户端" value={source} onValueChange={setSource} options={sources} />
      <SelectField aria-label="日志级别" value={severity} onValueChange={setSeverity} options={[
        { value: "", label: "全部异常" }, { value: "true", label: "崩溃或未捕获异常" }, { value: "false", label: "已捕获错误" },
      ]} />
    </div>
    {logs.error && <Alert variant="destructive"><AlertDescription>{logs.error}</AlertDescription></Alert>}
    {logs.loading && <Loading variant="list" label="正在加载客户端异常…" />}
    {!logs.loading && !logs.error && logs.data.length === 0 && <Empty className="empty">暂无客户端异常</Empty>}
    <div className="grid gap-3">
      {logs.data.map((log) => <article key={log.id} className="min-w-0 rounded-lg border border-border p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className="break-all font-mono">{log.errorType}</strong>
          <span className="text-muted-foreground">{dateTime(log.occurredAt)}</span>
        </div>
        <p className="mt-1">{sources.find((item) => item.value === log.source)?.label || log.source} · {log.familyName}{log.deviceName ? ` · ${log.deviceName}` : ""}</p>
        <p className="mt-1 break-words text-muted-foreground">{log.appVersion} · {log.osVersion} · {log.deviceModel}</p>
        <p className="mt-1 break-words text-muted-foreground">{log.fatal ? "崩溃或未捕获异常" : "已捕获错误"} · {log.code}{log.screen ? ` · ${log.screen}` : ""}</p>
        <details className="mt-3">
          <summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">查看异常栈和最近操作</summary>
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">{log.stack.join("\n") || "未提供异常栈"}</pre>
          <ol className="mt-3 grid gap-1 font-mono text-xs" aria-label="最近操作">
            {log.breadcrumbs.map((entry, index) => <li key={index} className="break-all">{dateTime(entry.at)} · {entry.name}</li>)}
          </ol>
          <p className="mt-3 text-xs text-muted-foreground">接收时间 {dateTime(log.createdAt)} · 记录 {log.id}</p>
        </details>
      </article>)}
    </div>
    <Pagination {...logs} loading={logs.refreshing} label="客户端异常分页" />
  </Card>;
}

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
      <div><h1>系统日志</h1><p>查看各端异常和电视播放错误，仅平台超管可访问。</p></div>
    </div>
    <ClientErrorLogs />
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
