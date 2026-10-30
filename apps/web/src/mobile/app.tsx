import { MobileError, MobileTitle, useMobileData } from './common';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { ArrowUpRight, ChevronRight, Clock3, Folder, House, ListVideo, Monitor, Plus, Settings2, Shield, Trash2, Users } from 'lucide-react';
import { api, bytes, type Session } from '../api';
import { usePairing } from '../pairing';
import { WatchHistoryDialog } from '../watch-history';
import { dateKey } from '../lib/date-only';
import type { OverviewData } from '../overview';
import type { useReminderData } from '../reminders';
import { ParentReminderActions } from '../reminders';
import { InstallApp } from '../pwa';
import { DeviceNotifications } from '../device-notifications';
import { LibraryDataProvider } from '../library-data';
import { MobileLibrary, type ResourceEditor } from './library';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody } from '../components/ui/dialog';
import './mobile-app.css';

type Reminders = ReturnType<typeof useReminderData>;
type Props = { session: Session; readonly: boolean; reminders: Reminders; run: (work: () => Promise<void>) => Promise<void>; logout: () => void; family: ReactNode; televisions: ReactNode; trash: ReactNode; operations: ReactNode; logs: ReactNode; uploads: ReactNode; deviceControls: (deviceId: string) => ReactNode; editor: ResourceEditor };
export function MobileApp(props: Props) {
  const location = useLocation(), navigate = useNavigate();
  const [message, setMessage] = useState('');
  const section = location.pathname.split('/')[1];

  useEffect(() => setMessage(''), [location.pathname]);
  return <div className="m-app">
    <div className="m-notification-observer" aria-hidden="true"><DeviceNotifications devices={props.reminders.devices} familyId={props.session.family.id} /></div>
    <main className="m-main">
      <Routes>
        <Route path="overview" element={<MobileHome {...props} notify={setMessage} />} />
        <Route path="library" element={<LibraryDataProvider key={`${props.session.user.id}:${props.session.family.id}`} />}>
          <Route index element={<MobileLibrary readonly={props.readonly} editor={props.editor} uploads={props.uploads} />} />
          <Route path=":folderId" element={<MobileLibrary readonly={props.readonly} editor={props.editor} uploads={props.uploads} />} />
        </Route>
        <Route path="devices" element={<MobileDevices {...props} notify={setMessage} />} />
        <Route path="devices/settings" element={<><MobileTitle title="播放与提醒" back="/devices" /><div className="m-shared-form m-preference-form">{props.televisions}</div></>} />
        <Route path="family" element={<MobileFamily {...props} />} />
        <Route path="family/edit" element={<><MobileTitle title="家庭与账号" back="/family" /><div className="m-shared-form">{props.family}</div></>} />
        <Route path="family/devices" element={<Navigate to="/devices" replace />} />
        <Route path="family/watching" element={<Navigate to="/devices/settings" replace />} />
        <Route path="trash" element={<><MobileTitle title="最近删除" back="/family" /><div className="m-shared-form">{props.trash}</div></>} />
        <Route path="operations/*" element={props.session.user.role === 'superadmin' ? <><MobileTitle title="运营管理" back="/family" /><div className="m-shared-form">{props.operations}</div></> : <Navigate to="/overview" replace />} />
        <Route path="logs" element={props.session.user.role === 'superadmin' ? <><MobileTitle title="系统日志" back="/family" /><div className="m-shared-form">{props.logs}</div></> : <Navigate to="/overview" replace />} />
        <Route path="pair" element={<Navigate to={`/devices?pair=1&code=${encodeURIComponent(new URLSearchParams(location.search).get('code') || '')}`} replace />} />
        <Route path="watch" element={<Navigate to="/overview?watch=1" replace />} />
        <Route path="upload" element={<Navigate to="/library?uploads=1" replace />} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Routes>
      {message && <button className="m-notice" role="status" onClick={() => setMessage('')}>{message}</button>}
    </main>
    <nav className="m-tabs" aria-label="手机导航">{[
      { id: 'overview', title: '今天', icon: House }, { id: 'library', title: '内容', icon: ListVideo }, { id: 'devices', title: '电视', icon: Monitor }, { id: 'family', title: '家庭', icon: Users },
    ].map(tab => <NavLink key={tab.id} to={`/${tab.id}`} aria-label={tab.title} onClick={event => { if (location.pathname === `/${tab.id}`) { event.preventDefault(); window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); } }} className={section === tab.id ? 'm-tab selected' : 'm-tab'}><tab.icon size={23} strokeWidth={section === tab.id ? 2 : 1.65} /><span>{tab.title}</span></NavLink>)}</nav>
  </div>;
}
function time(ms: number) { const minutes = Math.floor(ms / 60000); return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`; }
function MobileHome({ session, reminders, readonly, run, notify }: Props & { notify: (message: string) => void }) {
  const overview = useMobileData<OverviewData>('/overview', 0, 30000);
  const location = useLocation(), navigate = useNavigate(), pairing = usePairing();
  const watch = overview.data?.watch;
  const playing = reminders.devices?.filter(device => device.online && device.currentWatch) ?? [];
  const days = watch?.days.slice(-7) ?? [];
  const peak = Math.max(60000, ...days.map(day => day.playedMs));
  const today = watch?.days.slice(-1)[0]?.date ?? dateKey(new Date());
  const historyOpen = new URLSearchParams(location.search).get('watch') === '1';
  const opener = useRef<HTMLButtonElement>(null);
  return <>
    <MobileTitle title="今天" subtitle={new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())} action={<Link className="m-avatar" to="/family" aria-label="家庭与账号">{session.user.name.slice(0, 1).toUpperCase()}</Link>} />
    <MobileError message={overview.error || reminders.error} />
    <section className="m-live" aria-label="现在的观看状态">
      <div className="m-live-top"><span className="m-live-symbol"><Monitor size={25} strokeWidth={1.5} /></span><span className={`m-presence ${playing.length ? 'active' : ''}`}>{playing.length ? '正在播放' : '此刻没有播放'}</span><Link to="/devices" aria-label="查看电视"><ArrowUpRight size={19} /></Link></div>
      {playing.length ? playing.map(device => <div className="m-playing" key={device.id}><h2>{device.currentWatch!.name}</h2><p>{device.name}<span> · 已看 {time(device.currentWatch!.playedMs)}</span></p></div>) : <div className="m-playing"><h2>好故事，慢慢看。</h2><p>{reminders.devices?.length ? '下一次在电视播放时，状态会显示在这里。' : '连接家里的电视，为孩子准备下一段故事。'}</p></div>}
      {!reminders.devices?.length && <button className="m-primary" onClick={() => pairing.open()}>{readonly ? '查看连接方式' : '连接第一台电视'}<ChevronRight size={17} /></button>}
      {playing.length > 0 && <div className="m-rest-action"><ParentReminderActions data={reminders} readonly={readonly} run={run} notify={notify} /></div>}
    </section>
    <section className="m-activity" aria-label="观看用量">
      <div className="m-section-heading"><h2>观看时光</h2><button ref={opener} onClick={() => navigate('/overview?watch=1')}>查看记录<ChevronRight size={15} /></button></div>
      <div className="m-activity-body"><div><p>今天</p><strong>{watch ? time(watch.todayPlayedMs) : '—'}</strong><span>本周 {watch ? time(watch.weekPlayedMs) : '—'}</span></div><div className="m-week" role="img" aria-label={days.map(day => `${day.date} ${time(day.playedMs)}`).join('；')}>{days.map((day, index) => <div key={day.date}><i style={{ height: `${Math.max(4, day.playedMs / peak * 58)}px` }} data-today={index === days.length - 1} /><span>{['日', '一', '二', '三', '四', '五', '六'][new Date(`${day.date}T12:00:00`).getDay()]}</span></div>)}</div></div>
    </section>
    <div className="m-section-heading"><h2>家里的电视</h2><Link to="/devices">管理<ChevronRight size={15} /></Link></div>
    <div className="m-group">{reminders.devices?.length ? reminders.devices.map(device => <Link key={device.id} className="m-row" to="/devices"><span className="m-row-icon"><Monitor size={20} /></span><span><strong>{device.name}</strong><small>{device.online ? '已连接' : '离线'}</small></span><span className={`m-status-dot ${device.online ? 'active' : ''}`} /><ChevronRight size={16} /></Link>) : <button className="m-row" onClick={() => pairing.open()}><span className="m-row-icon"><Plus size={20} /></span><span><strong>添加电视</strong><small>扫码或输入配对码</small></span><ChevronRight size={16} /></button>}</div>
    <Link className="m-library-link" to="/library"><span className="m-library-icon"><Folder size={28} strokeWidth={1.5} /></span><span><strong>为下一次观看准备</strong><small>{overview.data ? `${overview.data.resources.series} 部动画 · ${overview.data.resources.episodes} 个已发布视频` : '打开家庭内容库'}</small></span><ChevronRight size={18} /></Link>
    <WatchHistoryDialog open={historyOpen} onClose={() => navigate('/overview', { replace: true })} today={today} watch={watch} restoreFocus={() => opener.current?.focus()} />
  </>;
}
function MobileDevices(props: Props & { notify: (message: string) => void }) {
  const pairing = usePairing(), navigate = useNavigate(), location = useLocation();
  const [serial, setSerial] = useState(0), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const controls = useMobileData<{ devices: { deviceId: string; enabled: boolean; mode: string; amount: number; version: number; round?: { remainingMs?: number; remainingEpisodes?: number; episodeName?: string } | null }[] }>('/watch-control', serial + pairing.revision, 5000);
  const devices = props.reminders.devices;
  const selectedDeviceId = new URLSearchParams(location.search).get('controls') || '';
  const selectedDevice = devices?.find(device => device.id === selectedDeviceId);
  const settings = !!selectedDeviceId && !props.readonly;
  useEffect(() => { if (selectedDeviceId && devices && !selectedDevice) navigate('/devices', { replace: true }); }, [selectedDeviceId, devices, selectedDevice, navigate]);
  return <><MobileTitle title="电视" subtitle="观看有安排，陪伴有分寸。" action={!props.readonly && <button className="m-circle-action" aria-label="连接电视" onClick={() => pairing.open()}><Plus size={23} /></button>} />
    <MobileError message={error || controls.error || props.reminders.error} />
    {!devices && !props.reminders.error && <p className="m-loading" role="status">正在连接家里的电视…</p>}
    {devices?.length === 0 && <section className="m-empty"><Monitor size={48} strokeWidth={1} /><h2>让故事在大屏幕上发生</h2><p>在电视上打开 MollyTime，扫码即可连接。</p><button className="m-primary" onClick={() => pairing.open()}>连接电视</button><button className="m-text-action" onClick={() => pairing.open(true)}>电视还没安装？</button></section>}
    {devices?.map(device => { const control = controls.data?.devices.find(row => row.deviceId === device.id); return <section className="m-tv-card" key={device.id}>
      <div className="m-tv-top"><span className="m-tv-illustration"><Monitor size={42} strokeWidth={1.25} /></span><span className={`m-presence ${device.online ? 'active' : ''}`}>{device.online ? '在线' : '离线'}</span></div>
      <h2>{device.name}</h2><p>{device.currentWatch?.name || (device.online ? '已准备好下一段故事' : '电视开机并联网后自动连接')}</p>
      <div className="m-tv-quota"><Clock3 size={17} /><span>{control ? control.enabled ? `每日 ${control.amount} ${control.mode === 'minutes' ? '分钟' : '集'}` : '自由观看' : controls.data ? '暂未读取到观看安排' : '正在读取观看安排…'}</span>{!props.readonly && <button onClick={() => navigate(`/devices?controls=${encodeURIComponent(device.id)}`)}>调整<ChevronRight size={14} /></button>}</div>
      {!props.readonly && <div className="m-tv-actions"><button className="m-primary" disabled={!control?.enabled || !!busy} onClick={() => { if (!control || busy) return; setBusy(device.id); setError(''); void api(`/watch-control/${device.id}/commands`, 'POST', { requestId: crypto.randomUUID(), version: control.version, action: 'add' }).then(() => { setSerial(value => value + 1); props.notify('已为今天加看，等待电视确认。'); window.dispatchEvent(new Event('molly:watch-controlChanged')); }).catch(failure => setError(failure.message)).finally(() => setBusy('')); }}>{busy === device.id ? '正在安排…' : control?.mode === 'minutes' ? '加看 10 分钟' : '加看 1 集'}</button><button className="m-secondary" onClick={() => navigate(`/devices?controls=${encodeURIComponent(device.id)}`)}>观看安排</button></div>}
    </section>; })}
    <Link className="m-row m-standalone-row" to="/devices/settings"><span className="m-row-icon"><Settings2 size={20} /></span><span><strong>播放与提醒</strong><small>字幕偏好、家长提醒视频</small></span><ChevronRight size={16} /></Link>
    {settings && <div className="m-shared-form m-native-device-editor">{props.deviceControls(selectedDeviceId)}</div>}
  </>;
}
function MobileFamily(props: Props) {
  const usage = useMobileData<{ storage: { usedBytes: number } }>('/settings');
  const row = (to: string, label: string, icon: ReactNode, detail?: string) => <Link className="m-row" to={to}><span className="m-row-icon">{icon}</span><span><strong>{label}</strong>{detail && <small>{detail}</small>}</span><ChevronRight size={16} /></Link>;
  return <><MobileTitle title="家庭" subtitle="一起观看，也一起成长。" />
    <Link className="m-profile" to="/family/edit"><span>{props.session.user.name.slice(0, 1).toUpperCase()}</span><div><h2>{props.session.family.name}</h2><p>{props.session.user.email}</p></div><ChevronRight size={18} /></Link>
    <div className="m-section-heading"><h2>家庭管理</h2></div><div className="m-group">{row('/family/edit', '家庭与账号', <Users size={20} />, '家庭名称、账号安全与时区')}{row('/devices/settings', '播放与提醒', <Monitor size={20} />)}{row('/trash', '最近删除', <Trash2 size={20} />, '保留期内随时恢复')}</div>
    <div className="m-storage"><span>家庭内容占用</span><strong>{usage.data ? bytes(usage.data.storage.usedBytes) : '—'}</strong><Link to="/family/edit">管理存储<ChevronRight size={14} /></Link></div>
    <div className="m-section-heading"><h2>此应用</h2></div><div className="m-group m-app-options"><InstallApp /><DeviceNotifications devices={undefined} familyId={props.session.family.id} /></div>
    {props.session.user.role === 'superadmin' && <><div className="m-section-heading"><h2>管理工具</h2></div><div className="m-group">{row('/operations', '运营管理', <Shield size={20} />)}{row('/logs', '系统日志', <ListVideo size={20} />)}</div></>}
    <button className="m-signout" onClick={props.logout}>退出账号</button><p className="m-footnote">MollyTime · 把时间留给好故事</p>
  </>;
}
