import { useEffect, useState } from 'react';
import { api, bytes, dateTime, type Resource } from './api';

type Playback = { mediaId: string; url: string; subtitles: { index: number; url: string; language: string; label: string; isDefault: boolean }[] };
export function MediaPreview({ id }: { id: string }) {
  const [source, setSource] = useState<Playback>(), [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch(`/api/episodes/${id}/playback`, { credentials: 'same-origin', cache: 'no-store' }).then(async (r) => {
      if (!r.ok) throw new Error('文件检查完成后才能预览');
      return r.json();
    }).then((data) => { if (alive) { setSource(data); setError(''); } }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [id, refresh]);
  return <>{source && <video key={refresh} src={source.url} controls autoPlay crossOrigin="anonymous" className="video-preview" onError={() => setError('播放地址可能已过期，请重新加载')}>
    {source.subtitles.map((sub) => <track key={sub.index} kind="subtitles" src={sub.url} srcLang={sub.language} label={sub.label} default={sub.isDefault} />)}
  </video>}{error && <p className="error">{error} <button onClick={() => setRefresh((v) => v + 1)}>重新加载</button></p>}</>;
}

type Download = { id: string; mediaId: string; deviceId: string; deviceName: string; status: string; size: number; downloadedBytes: number; error: string; updatedAt: string; desired: string; deviceLastSeen: string };
const statuses: Record<string, string> = { queued: '等待电视连接', downloading: '正在下载', saved: '已保存到电视', failed: '保存失败', removed: '已清理' };
export function TvDownloads({ item, readonly }: { item: Resource; readonly: boolean }) {
  const [devices, setDevices] = useState<{ id: string; name: string; revoked: boolean }[]>([]);
  const [rows, setRows] = useState<Download[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => Promise.all([api<typeof devices>('/devices'), api<Download[]>(`/resources/${item.id}/downloads`)])
      .then(([d, r]) => { if (alive) { setDevices(d); setRows(r); } }).catch((e) => { if (alive) setError(e.message); });
    void load(); const timer = setInterval(() => { void load(); }, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [item.id]);
  const command = async (deviceId: string, desired: string) => {
    setBusy(true); setError('');
    try { await api(`/resources/${item.id}/downloads`, 'POST', { deviceId, desired }); setRows(await api(`/resources/${item.id}/downloads`)); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <section><h3>保存到电视</h3><p className="muted">电视连接后自动下载。保存的视频不会被普通缓存清理，云端原文件仍保留。</p>
    {devices.filter((d) => !d.revoked).map((d) => { const row = rows.find((r) => r.deviceId === d.id && r.mediaId === item.files.find((f) => f.kind === 'video')?.id && r.desired === 'saved'); return <div className="settings-row" key={d.id}><span>{d.name}<small> · {row ? statuses[row.status] : '尚未保存'}</small>{row && <p className="muted">{bytes(row.downloadedBytes)} / {bytes(row.size)} · 最后确认 {dateTime(row.updatedAt)} · 电视最后连接 {dateTime(row.deviceLastSeen)}{row.error && ` · ${row.error}`}</p>}</span>
      {!readonly && <><button type="button" disabled={busy || !item.ready} onClick={() => void command(d.id, 'saved')}>{row?.status === 'failed' ? '重试保存' : '保存到电视'}</button>{row && <button type="button" disabled={busy} onClick={() => void command(d.id, 'removed')}>清理电视副本</button>}</>}
    </div>; })}
    {!devices.some((d) => !d.revoked) && <p className="muted">先在家庭设置中绑定电视。</p>}{error && <p className="error">{error}</p>}
  </section>;
}

export function SubtitleSettings({ item, readonly }: { item: Resource; readonly: boolean }) {
  const [files, setFiles] = useState(item.files.filter((f) => f.kind === 'subtitle'));
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <section><h3>字幕设置</h3>{files.map((file) => <fieldset disabled={readonly || busy} key={file.id}><legend>{file.name}</legend>
    <label>显示名称<input value={file.name} maxLength={256} onChange={(e) => setFiles(files.map((f) => f.id === file.id ? { ...f, name: e.target.value } : f))} /></label>
    <label>语言<input value={file.language} maxLength={16} onChange={(e) => setFiles(files.map((f) => f.id === file.id ? { ...f, language: e.target.value } : f))} /></label>
    <label>时间偏移（毫秒，正值延后）<input type="number" min={-600000} max={600000} value={file.offsetMs} onChange={(e) => setFiles(files.map((f) => f.id === file.id ? { ...f, offsetMs: Number(e.target.value) } : f))} /></label>
    <label className="check-label"><input type="checkbox" checked={file.isDefault} onChange={(e) => setFiles(files.map((f) => ({ ...f, isDefault: f.id === file.id ? e.target.checked : e.target.checked ? false : f.isDefault })))} />默认字幕</label>
    {!readonly && <button type="button" onClick={() => { setBusy(true); setError(''); void api(`/resources/${item.id}/subtitles/${file.id}`, 'PATCH', { language: file.language, label: file.name, offsetMs: file.offsetMs, isDefault: file.isDefault }).catch((e) => setError(e.message)).finally(() => setBusy(false)); }}>保存字幕设置</button>}
  </fieldset>)}{error && <p className="error">{error}</p>}</section>;
}
