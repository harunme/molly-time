import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { SelectField } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loading } from "@/components/ui/loading";
import { api } from "./api";
import { confirmAction, promptText } from "./feedback";
import type { Run } from "./main";
import { Pagination, usePagedData } from "./pagination";
import { usePairing } from "./pairing";
import { ParentReminders } from "./reminders";
import { WatchControls } from "./watch-control";

export function Televisions({ readonly, run, notify }: { readonly: boolean; run: Run; notify: (value: string) => void }) {
  const pairing = usePairing();
  const [preferencesOpen, setPreferencesOpen] = useState(() => matchMedia("(min-width: 1024px)").matches || new URLSearchParams(window.location.hash.split("?")[1]).get("preferences") === "1");
  const devices = usePagedData<{ id: string; name: string; revoked: boolean; lastSeen: string }>("/devices?activeOnly=true", pairing.revision);
  const [subtitle, setSubtitle] = useState("zh");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api<{ defaultSubtitle: string }>("/settings", "GET", undefined, undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setSubtitle(value.defaultSubtitle ?? "zh"); setLoaded(true); } })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, []);
  return <>
    <div className="page-title"><div><h1>我的电视</h1><p>连接电视，查看设备状态，为每台电视安排观看时间。</p></div></div>
    <WatchControls readonly={readonly} devices={devices.data} total={devices.total} serial={pairing.revision}
      listState={devices.error ? <Alert variant="destructive"><AlertDescription>{devices.error}</AlertDescription></Alert> : devices.loading ? <Loading variant="list" /> : null}
      empty={!devices.loading && !devices.error && !devices.data.length}
      footer={devices.total > devices.pageSize && <Pagination {...devices} loading={devices.refreshing} label="设备分页" />}
      pairing={<Button variant="bordered" onClick={() => pairing.open()}>{readonly ? "如何绑定电视" : "绑定电视"}</Button>}
      rename={async device => {
        const name = await promptText("设备名称", device.name);
        if (name && name !== device.name) { await api(`/devices/${device.id}`, "PATCH", { name }); pairing.refresh(); }
      }}
      revoke={async device => {
        if (await confirmAction(`取消“${device.name}”的配对？电视将无法继续访问家庭媒体库。`)) {
          await api(`/devices/${device.id}/revoke`, "POST"); pairing.refresh();
        }
      }} />
    <button type="button" className="television-preferences-toggle" aria-expanded={preferencesOpen} aria-controls="television-preferences" onClick={() => setPreferencesOpen(open => !open)}>
      <span><strong>播放与提醒设置</strong><small>默认字幕、家长提醒视频</small></span><ChevronDown aria-hidden="true" />
    </button>
    <div id="television-preferences" className="settings-grid television-settings" data-expanded={preferencesOpen}><div className="settings-column">
      <Card className="settings-card"><h2>播放偏好</h2>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {!loaded && !error && <Loading variant="form" />}
        {loaded && <form onSubmit={event => {
          event.preventDefault(); void run(async () => {
            await api("/settings", "PUT", { defaultSubtitle: subtitle }); notify("默认字幕已更新，下一次播放生效。");
          });
        }}>
          <Label htmlFor="default-subtitle">默认字幕</Label>
          <SelectField id="default-subtitle" value={subtitle} onValueChange={setSubtitle} disabled={readonly}
            options={[{ value: "zh", label: "中文" }, { value: "en", label: "英文" }, { value: "zh-en", label: "中英文" }, { value: "off", label: "关闭字幕" }]} />
          <p className="muted">所有视频共用此偏好，与电视设置同步。没有匹配类型时关闭字幕；中英文需要对应的双语字幕文件。</p>
          {!readonly && <Button variant="bordered">保存默认字幕</Button>}
        </form>}
      </Card>
    </div><div className="settings-column"><ParentReminders readonly={readonly} /></div></div>
  </>;
}
