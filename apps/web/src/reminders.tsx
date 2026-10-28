import { FileUploadStatus, useItemUploads } from "./upload-status";
import { Loading } from "@/components/ui/loading";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, bytes } from './api';
import { enqueue } from './uploads';
import { getUploadLimits, useUploadLimits, validateUploadSize } from './upload-limits';
import type { Run } from './main';
import { Card } from './components/ui/card';
import { Button } from './components/ui/button';
import { FileUploadField } from './components/ui/upload';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Kind = 'warning' | 'farewell';
type Clip = { itemId: string | null; ready: boolean; name: string; previewUrl: string | null; };
type Device = { watchManagement?: boolean; id: string; name: string; phase: string; requestId: string | null; online: boolean; lastSeen: string; bootId?: string | null; bootPlayedMs?: number | null; currentWatch?: { sessionId: string; name: string; playedMs: number; } | null; };
type Settings = { enabled: boolean; warning: Clip; farewell: Clip; };

export function useReminderData(includeDevices = false, enabled = true) {
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
    if (!enabled) { setSettings(undefined); setDevices(undefined); setError(''); return; }
    alive.current = true;
    void reload();
    const timer = setInterval(() => { void reload(); }, 5000);
    const changed = () => { void reload(); };
    window.addEventListener('molly:watch-controlChanged', changed);
    return () => { alive.current = false; clearInterval(timer); window.removeEventListener('molly:watch-controlChanged', changed); };
  }, [includeDevices, enabled]);
  return { settings, devices, error, reload };
}

const phases: Record<string, string> = {
  pending: '已安排，这集看完休息', watching: '提醒已播放，这集看完休息',
  done: '本次观看已结束，再次选片可继续', idle: '仅提醒本次观看，不影响每日剩余额度',
};

export function ParentReminderActions({ data, readonly, run, notify }: {
  data: ReturnType<typeof useReminderData>; readonly: boolean; run: Run; notify: (value: string) => void;
}) {
  const { settings, devices, error, reload } = data;
  const online = devices?.filter((device) => device.online) ?? [];
  const [choosing, setChoosing] = useState(false), [busy, setBusy] = useState(false);
  const clipsReady = !!settings?.warning.ready && !!settings?.farewell.ready;
  const eligible = (device: Device) => clipsReady && !!device.currentWatch && !device.requestId;
  const perform = (device: Device) => {
    if (readonly || busy || error || !eligible(device)) return;
    setBusy(true);
    void run(async () => {
      await api('/reminders/requests', 'POST', { deviceId: device.id });
      notify(`已提醒${device.name}，这集看完休息；再次选片可使用今日剩余额度。`);
      setChoosing(false);
      await reload();
    }).finally(() => setBusy(false));
  };
  const start = () => { if (online.length === 1) perform(online[0]); else setChoosing(true); };
  useEffect(() => {
    if (devices && !devices.some((device) => device.online)) setChoosing(false);
  }, [devices]);
  if (!online.length) return null;
  return <div className="overview-playback-control" role="group" aria-label="播放控制">
    {online.length === 1 && <p className="overview-playback-status" role="status">{online[0].name} · {phases[online[0].phase] ?? phases.idle}</p>}
    {error && <Alert variant="destructive" role="alert" className="error"><AlertDescription>{error}</AlertDescription></Alert>}
    {!readonly && <div className="overview-playback-actions">
      <Button type="button" size="sm" title="提醒当前正在观看的这一集，结束后停止连播；再次选片仍可使用今日剩余额度" disabled={busy || !!error || !online.some(eligible)} onClick={start}>这集看完休息</Button>
    </div>}
    {!clipsReady && <p className="overview-playback-note">请先在<Link to="/devices">我的电视</Link>上传剩余集数提醒和休息提醒视频。</p>}
    <Dialog open={choosing} onOpenChange={(open) => { if (!busy) setChoosing(open); }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>选择要提醒的电视</DialogTitle>
          <DialogDescription>只提醒当前正在观看的这一集，看完后停止连播。再次选片可继续使用当天剩余额度。</DialogDescription>
        </DialogHeader>
        <DialogBody className="overview-playback-devices">
          {online.map((device) => <Button key={device.id} type="button" variant="bordered" className="overview-playback-device" disabled={busy || !!error || readonly || !eligible(device)}
            aria-label={`提醒：${device.name}`} onClick={() => perform(device)}>
            <span><strong>{device.name}</strong><small>{device.currentWatch ? phases[device.phase] ?? phases.idle : '当前没有正在播放的视频'}</small></span><span>这集看完休息</span>
          </Button>)}
        </DialogBody>
        <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => setChoosing(false)}>取消</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

export function ParentReminders({ readonly }: { readonly: boolean }) {
  const { settings, error, reload } = useReminderData();
  const uploadPolicy = useUploadLimits();
  const [starting, setStarting] = useState<Kind>();
  const [targets, setTargets] = useState<Partial<Record<Kind, string>>>({});
  const [uploadErrors, setUploadErrors] = useState<Partial<Record<Kind, string>>>({});
  const [selectedNames, setSelectedNames] = useState<Partial<Record<Kind, string>>>({});
  const uploadLock = useRef(false);
  const uploads = useItemUploads([settings?.warning.itemId, settings?.farewell.itemId, ...Object.values(targets)].filter((id): id is string => !!id), reload);
  const [preview, setPreview] = useState<Kind>();
  const upload = async (kind: Kind, file: File) => {
    if (readonly || uploadLock.current) return;
    uploadLock.current = true; setStarting(kind);
    setSelectedNames(value => ({ ...value, [kind]: file.name }));
    setUploadErrors(value => ({ ...value, [kind]: '' }));
    try {
      validateUploadSize(file, 'video', await getUploadLimits());
      const target = await api<{ itemId: string }>(`/reminders/${kind}/upload-target`, 'POST');
      setTargets(value => ({ ...value, [kind]: target.itemId }));
      await enqueue(file, target.itemId, 'video');
      await reload(); uploads.refresh();
    } catch (failure) { setUploadErrors(value => ({ ...value, [kind]: (failure as Error).message })); }
    finally { uploadLock.current = false; setStarting(undefined); }
  };
  return <Card className="settings-card parent-reminders">
    <h2>家长视频提醒</h2>
    <p className="muted">上传最后一集与休息提醒视频，观看时自动提示，也可在这里预览。在<Link to="/overview">概览</Link>点击“这集看完休息”，仅结束本次观看，不影响今日剩余额度。</p>
    {uploadPolicy.limits && <p className="muted">单个视频上限：{bytes(uploadPolicy.limits.video)}</p>}
    {uploadPolicy.error && <Alert variant="destructive" role="alert"><AlertDescription>{uploadPolicy.error}</AlertDescription></Alert>}
    {error && <Alert variant="destructive" role="alert" className="error"><AlertDescription>{error}</AlertDescription></Alert>}
    {!settings && !error && <Loading variant="form" label="正在加载提醒设置…" />}
    {settings && <>
      {(['warning', 'farewell'] as const).map((kind) => {
        const rows = uploads.forItem(targets[kind] || settings[kind].itemId || '');
        return <div className="reminder-clip" key={kind}>
        <Label htmlFor={`reminder-${kind}`}>{kind === 'warning' ? '剩 1 集提醒视频' : '休息提醒视频'}</Label>
        <p className="muted">{settings[kind].ready ? '视频已就绪' : '请上传视频，等待处理完成'} · {kind === 'warning' ? '最后一集开始时出现，也支持后台手动发起' : '最后一集看完后出现，随后停止播放'}</p>
        {!readonly && <FileUploadField className="rounded-full" inputId={`reminder-${kind}`} accept="video/mp4,.mp4" disabled={!!starting || rows.some(row => ['uploading', 'processing'].includes(row.status)) || !uploadPolicy.limits}
          inputLabel={kind === 'warning' ? '上传剩 1 集提醒视频' : '上传休息提醒视频'} placeholder="选择 MP4 视频" fileName={rows[0]?.filename || selectedNames[kind]}
          onFileSelect={(file) => { void upload(kind, file); }} />}
        {starting === kind && <p className="muted" role="status">正在准备上传 {selectedNames[kind]}…</p>}
        {uploadErrors[kind] && <p className="file-upload-error" role="alert">{uploadErrors[kind]}</p>}
        {rows.map(row => <FileUploadStatus key={row.id} row={row} readonly={readonly} changed={uploads.refresh} showFilename={readonly || rows.length > 1} />)}
        {settings[kind].ready && <Button type="button" variant="bordered" onClick={() => setPreview(preview === kind ? undefined : kind)}>
          {preview === kind ? '关闭预览' : `预览${kind === 'warning' ? '提醒' : '休息提醒'}`}
        </Button>}
        {preview === kind && settings[kind].previewUrl && <video key={settings[kind].previewUrl} src={settings[kind].previewUrl!} controls autoPlay aria-label="家长提醒预览" />}
      </div>; })}
      {uploads.error && <p className="file-upload-error" role="alert">上传状态暂时无法更新：{uploads.error}</p>}
      <p className="muted">上传 MP4 视频，进度和重试会显示在对应文件下方。不上传也能按观看安排休息；两段视频就绪后可手动提醒本次观看。提醒视频不计入观看时长。</p>
    </>}
  </Card>;
}
