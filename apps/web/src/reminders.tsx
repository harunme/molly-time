import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, dateTime } from './api';
import { enqueue } from './uploads';
import type { Run } from './main';
import { Card } from './components/ui/card';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { NativeSelect } from './components/ui/native-select';

type Kind = 'warning' | 'farewell';
type Clip = { itemId: string | null; ready: boolean; name: string; previewUrl: string | null };
type Device = { id: string; name: string; phase: string; requestId: string | null; online: boolean; lastSeen: string };
type Settings = { enabled: boolean; warning: Clip; farewell: Clip };

function useReminderData(includeDevices = false) {
  const [settings, setSettings] = useState<Settings>();
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const reload = async () => {
    try {
      const [data, rows] = await Promise.all([
        api<Settings>('/reminders'),
        includeDevices ? api<Device[]>('/reminders/devices') : Promise.resolve([]),
      ]);
      if (alive.current) { setSettings(data); setDevices(rows); setError(''); }
    } catch (failure) { if (alive.current) setError((failure as Error).message); }
  };
  useEffect(() => {
    alive.current = true;
    void reload();
    const timer = setInterval(() => { void reload(); }, 5000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [includeDevices]);
  return { settings, devices, error, reload };
}

export function ParentReminderActions({ readonly, run, notify }: {
  readonly: boolean; run: Run; notify: (value: string) => void;
}) {
  const { settings, devices, error, reload } = useReminderData(true);
  const [deviceId, setDeviceId] = useState(''), [busy, setBusy] = useState(false);
  const selectedDevice = devices.find((device) => device.id === deviceId);
  return <Card className="report-section parent-reminder-actions">
    <h2>播放控制</h2>
    <p className="muted">发起提醒后只看完当前这一集，结束时播放告别视频并停止。没有正在播放时，接下来的一集就是最后一集。</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!settings && !error && <p role="status">正在加载…</p>}
    {settings && <>
      <label htmlFor="reminder-device">提醒哪台电视</label>
      <NativeSelect id="reminder-device" value={deviceId} disabled={readonly || busy} onChange={(event) => setDeviceId(event.target.value)}>
        <option value="">选择电视设备</option>
        {devices.map((device) => <option key={device.id} value={device.id} disabled={!device.online && !device.requestId}>
          {device.name} · {device.online ? '在线' : '离线'} · 最近连接 {dateTime(device.lastSeen)}
        </option>)}
      </NativeSelect>
      {devices.length === 0 && <p className="muted">请先绑定电视设备。</p>}
      {devices.length > 0 && !devices.some((device) => device.online) && <p className="muted">当前没有在线电视，请先打开电视上的 MollyTime。已有的播放限制仍可解除。</p>}
      {selectedDevice && <p className="muted">{selectedDevice.online ? '电视在线' : '电视离线，暂时不能发起提醒'} · 最近连接 {dateTime(selectedDevice.lastSeen)}</p>}
      {deviceId && <p role="status">{({ pending: '已发起，等待电视播放提醒', watching: '提醒已播放，只能看完当前这一集', done: '最后一集已结束，等待家长恢复播放', idle: '尚未发起提醒' } as Record<string, string>)[devices.find((device) => device.id === deviceId)?.phase || 'idle']}</p>}
      {!readonly && <div className="reminder-actions">
        <Button type="button" disabled={busy || !!error || !selectedDevice?.online || !settings.warning.ready || !settings.farewell.ready || !!selectedDevice.requestId}
          onClick={() => { setBusy(true); void run(async () => {
            await api('/reminders/requests', 'POST', { deviceId }); await reload();
            notify('已发起提醒，当前这一集看完就结束。');
          }).finally(() => setBusy(false)); }}>发起提醒：只剩 1 集</Button>
        <Button type="button" variant="outline" disabled={busy || !devices.find((device) => device.id === deviceId)?.requestId}
          onClick={() => { setBusy(true); void run(async () => {
            await api(`/reminders/devices/${deviceId}`, 'DELETE'); await reload(); notify('已恢复播放，可以重新选择视频。');
          }).finally(() => setBusy(false)); }}>恢复播放</Button>
      </div>}
      {(!settings.warning.ready || !settings.farewell.ready) && <p className="muted">请先在<Link to="/family">家庭设置</Link>上传提醒和告别视频，处理完成后即可发起提醒。</p>}
    </>}
  </Card>;
}

export function ParentReminders({ readonly, run, notify }: {
  readonly: boolean; run: Run; notify: (value: string) => void;
}) {
  const { settings, error, reload } = useReminderData();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Kind>();
  const upload = async (kind: Kind, file: File) => {
    setBusy(true);
    try {
      await run(async () => {
        const target = await api<{ itemId: string }>(`/reminders/${kind}/upload-target`, 'POST');
        await enqueue(file, target.itemId, 'video');
        notify('已加入上传任务，处理完成后可预览和发起提醒。');
        await reload();
      });
    } finally { setBusy(false); }
  };
  return <Card className="settings-card parent-reminders">
    <h2>家长视频提醒</h2>
    <p className="muted">上传提醒与告别视频，可在这里预览。需要发起提醒或恢复播放时，请前往<Link to="/overview">概览</Link>。</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!settings && !error && <p role="status">正在加载…</p>}
    {settings && <>
      {(['warning', 'farewell'] as const).map((kind) => <div className="reminder-clip" key={kind}>
        <label htmlFor={`reminder-${kind}`}>{kind === 'warning' ? '剩 1 集提醒视频' : '结束告别视频'}</label>
        <p className="muted">{settings[kind].ready ? '视频已就绪' : '请上传视频，等待处理完成'} · {kind === 'warning' ? '后台发起后主动出现' : '最后一集看完后出现，随后停止播放'}</p>
        {!readonly && <Input id={`reminder-${kind}`} type="file" accept="video/mp4,.mp4" disabled={busy}
          aria-label={kind === 'warning' ? '上传剩 1 集提醒视频' : '上传结束告别视频'}
          onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(kind, file); }} />}
        {settings[kind].ready && <Button type="button" variant="outline" onClick={() => setPreview(preview === kind ? undefined : kind)}>
          {preview === kind ? '关闭预览' : `预览${kind === 'warning' ? '提醒' : '告别'}`}
        </Button>}
        {preview === kind && settings[kind].previewUrl && <video key={settings[kind].previewUrl} src={settings[kind].previewUrl!} controls autoPlay aria-label="家长提醒预览" />}
      </div>)}
      <p className="muted">上传 MP4 视频，可在上传任务中查看进度或重试。两段视频就绪后，可在概览中发起提醒或恢复播放。提醒不计入观看记录。</p>
    </>}
  </Card>;
}
