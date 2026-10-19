import { Loading } from "@/components/ui/loading";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "./api";

type BackupConfig = { enabled: boolean; hour: number; minute: number; local_retention_days: number };
type BackupStatus = {
  last_checked_at?: string;
  last_started_at?: string;
  last_finished_at?: string;
  last_result?: "running" | "success" | "failed";
  last_error?: string;
  last_object_key?: string;
};
type BackupData = { config: BackupConfig; status: BackupStatus; timezone: string; oss_retention: string };

function timestamp(value?: string) {
  return value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "暂无记录";
}

export function BackupSettings({ notify }: { notify: (message: string) => void }) {
  const [data, setData] = useState<BackupData>();
  const [config, setConfig] = useState<BackupConfig>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api<BackupData>("/operations/backups")
      .then((value) => { if (alive) { setData(value); setConfig(value.config); } })
      .catch((cause) => { if (alive) setError(cause.message); });
    return () => { alive = false; };
  }, []);
  const save = async () => {
    if (!config) return;
    setBusy(true);
    setError("");
    try {
      const value = await api<BackupData>("/operations/backups", "PUT", config);
      setData(value);
      setConfig(value.config);
      notify("数据库备份设置已保存");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };
  if (!data || !config) return error ? <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : <Loading variant="form" label="正在加载备份设置…" className="rounded-card bg-card p-6" />;
  const checked = data.status.last_checked_at ? Date.parse(data.status.last_checked_at) : 0;
  const schedulerActive = checked > Date.now() - 5 * 60_000;
  const result = data.status.last_result;
  return (
    <Card className="settings-card operations-card">
      <h2>数据库备份</h2>
      <p className="muted">MySQL 数据库压缩加密后上传到私有 OSS。这里的保留天数只清理服务器本地副本，OSS 副本目前长期保留。</p>
      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy}>
          <Label><input type="checkbox" checked={config.enabled} onChange={(event) => setConfig({ ...config, enabled: event.target.checked })} /> 启用每日自动备份</Label>
          <div className="form-grid">
            <Label>备份时间（北京时间）
              <Input aria-label="备份时间（北京时间）" type="time" value={`${String(config.hour).padStart(2, "0")}:${String(config.minute).padStart(2, "0")}`} onChange={(event) => {
                const [hour, minute] = event.target.value.split(":").map(Number);
                if (Number.isInteger(hour) && Number.isInteger(minute)) setConfig({ ...config, hour, minute });
              }} required />
            </Label>
            <Label>服务器本地保留天数
              <Input type="number" min={1} max={90} value={config.local_retention_days} onChange={(event) => setConfig({ ...config, local_retention_days: Number(event.target.value) })} required />
            </Label>
          </div>
          <div className="actions"><Button type="submit" className="primary">{busy ? "正在保存…" : "保存备份设置"}</Button></div>
        </fieldset>
      </form>
      <section className="backup-status" aria-labelledby="backup-status-heading">
        <h3 id="backup-status-heading">备份状态</h3>
        <dl className="backup-status-details">
          <div>
            <dt>定时任务</dt>
            <dd>
              <Badge variant="secondary" className={schedulerActive ? "backup-status-success" : "backup-status-warning"}>{schedulerActive ? "运行中" : "待检查"}</Badge>
              {!schedulerActive && <p className="backup-status-note">未检测到最近运行，请检查服务器定时任务</p>}
            </dd>
          </div>
          <div>
            <dt>最近执行</dt>
            <dd className="backup-status-execution">
              {data.status.last_started_at && <time dateTime={data.status.last_started_at}>{timestamp(data.status.last_started_at)}</time>}
              <Badge variant={result === "failed" ? "destructive" : "secondary"} className={result === "success" ? "backup-status-success" : undefined}>
                {result === "success" ? "成功" : result === "failed" ? "失败" : result === "running" ? "进行中" : "暂无自动备份记录"}
              </Badge>
            </dd>
          </div>
          {data.status.last_error && <div className="backup-status-wide"><dt>失败原因</dt><dd className="backup-status-error">{data.status.last_error}</dd></div>}
          {data.status.last_object_key && <div className="backup-status-wide"><dt>OSS 路径</dt><dd><code className="backup-object-key">{data.status.last_object_key}</code></dd></div>}
        </dl>
      </section>
    </Card>
  );
}
