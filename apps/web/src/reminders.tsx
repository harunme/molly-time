import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from './api';
import { enqueue } from './uploads';
import type { Run } from './main';
import { Card } from './components/ui/card';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Kind = 'warning' | 'farewell';
type Clip = { itemId: string | null; ready: boolean; name: string; previewUrl: string | null };
type Device = { id: string; name: string; phase: string; requestId: string | null; online: boolean; lastSeen: string };
type Settings = { enabled: boolean; warning: Clip; farewell: Clip };

export function useReminderData(includeDevices = false) {
  const [settings, setSettings] = useState<Settings>();
  const [devices, setDevices] = useState<Device[]>();
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

const phases: Record<string, string> = {
  pending: '已发起，等待电视播放提醒', watching: '提醒已播放，只能看完当前这一集',
  done: '最后一集已结束，等待恢复播放', idle: '尚未发起提醒',
};

export function ParentReminderActions({ data, readonly, run, notify }: {
  data: ReturnType<typeof useReminderData>; readonly: boolean; run: Run; notify: (value: string) => void;
}) {
  const { settings, devices, error, reload } = data;
  const online = devices?.filter((device) => device.online) ?? [];
  const [action, setAction] = useState<'remind' | 'restore'>();
  const [busy, setBusy] = useState(false);
  const clipsReady = !!settings?.warning.ready && !!settings?.farewell.ready;
  const eligible = (device: Device, operation: 'remind' | 'restore') => device.online &&
    (operation === 'remind' ? clipsReady && !device.requestId : !!device.requestId);
  const perform = (device: Device, operation: 'remind' | 'restore') => {
    if (readonly || busy || error || !eligible(device, operation)) return;
    setBusy(true);
    void run(async () => {
      if (operation === 'remind') {
        await api('/reminders/requests', 'POST', { deviceId: device.id });
        notify(`已向${device.name}发起提醒，当前这一集看完就结束。`);
      } else {
        await api(`/reminders/devices/${device.id}`, 'DELETE');
        notify(`已恢复${device.name}的播放，可以重新选择视频。`);
      }
      setAction(undefined);
      await reload();
    }).finally(() => setBusy(false));
  };
  const start = (operation: 'remind' | 'restore') => {
    if (online.length === 1) perform(online[0], operation);
    else setAction(operation);
  };
  useEffect(() => {
    if (devices && !devices.some((device) => device.online)) setAction(undefined);
  }, [devices]);
  if (!online.length) return null;
  return <div className="overview-playback-control" role="group" aria-label="播放控制">
    {online.length === 1 && <p className="overview-playback-status" role="status">{online[0].name} · {phases[online[0].phase] ?? phases.idle}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {!readonly && <div className="overview-playback-actions">
      <Button type="button" size="sm" title="提醒后只看完当前这一集，结束时播放告别视频并停止" disabled={busy || !!error || !online.some((device) => eligible(device, 'remind'))} onClick={() => start('remind')}>发起提醒</Button>
      <Button type="button" size="sm" variant="outline" disabled={busy || !!error || !online.some((device) => eligible(device, 'restore'))} onClick={() => start('restore')}>恢复播放</Button>
    </div>}
    {!clipsReady && <p className="overview-playback-note">请先在<Link to="/family">家庭设置</Link>上传提醒和告别视频。</p>}
    <Dialog open={!!action} onOpenChange={(open) => { if (!open && !busy) setAction(undefined); }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{action === 'restore' ? '选择要恢复播放的电视' : '选择要提醒的电视'}</DialogTitle>
          <DialogDescription>{action === 'restore' ? '选择电视后解除播放限制，可以重新选择视频。' : '选择电视后立即发起提醒，只看完当前这一集，结束时播放告别视频并停止。没有正在播放时，接下来的一集就是最后一集。'}</DialogDescription>
        </DialogHeader>
        <div className="overview-playback-devices">
          {online.map((device) => <Button key={device.id} type="button" variant="outline" className="overview-playback-device" disabled={busy || !!error || readonly || !action || !eligible(device, action)}
            aria-label={`${action === 'restore' ? '恢复播放' : '提醒'}：${device.name}`} onClick={() => { if (action) perform(device, action); }}>
            <span><strong>{device.name}</strong><small>{phases[device.phase] ?? phases.idle}</small></span><span>{action === 'restore' ? '恢复播放' : '发起提醒'}</span>
          </Button>)}
        </div>
        <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => setAction(undefined)}>取消</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
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
