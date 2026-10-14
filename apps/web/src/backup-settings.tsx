import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
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
  if (!data || !config) return error ? <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : <Empty>正在加载备份设置…</Empty>;
  const checked = data.status.last_checked_at ? Date.parse(data.status.last_checked_at) : 0;
  const schedulerActive = checked > Date.now() - 5 * 60_000;
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
      <p className="muted">定时任务：{schedulerActive ? "运行中" : "未检测到最近运行，请检查服务器定时任务"}</p>
      <p className="muted">最近执行：{timestamp(data.status.last_started_at)} · {data.status.last_result === "success" ? "成功" : data.status.last_result === "failed" ? "失败" : data.status.last_result === "running" ? "进行中" : "暂无自动备份记录"}</p>
      {data.status.last_error && <p className="muted">失败原因：{data.status.last_error}</p>}
      {data.status.last_object_key && <p className="muted">OSS 路径：{data.status.last_object_key}</p>}
    </Card>
  );
}
