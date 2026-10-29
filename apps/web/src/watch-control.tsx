import { useRevalidation } from "./lifecycle";
import { SelectField } from "./components/ui/select";
import { Switch } from "./components/ui/switch";
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, dateTime } from './api';
import { MoreHorizontal } from 'lucide-react';
import { Empty } from './components/ui/empty';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './components/ui/dropdown-menu';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './components/ui/dialog';

type Device = { deviceId: string; name: string; online: boolean; supported: boolean; enabled: boolean; mode: 'episodes' | 'minutes'; amount: number; version: number; acknowledged: number; status: string; round: null | { mode: string; amount: number; remainingEpisodes?: number | null; cursor: number; playlist: string[]; episodeId: string | null; episodeName: string | null; remainingMs: number | null; ended: boolean } };
type Data = { pinSet: boolean; devices: Device[] };
type PairedDevice = { id: string; name: string; lastSeen: string | null };
export function WatchControls({ readonly, devices, total, serial, pairing, listState, empty, footer, rename, revoke }: {
  readonly: boolean; devices: PairedDevice[]; total: number; serial: number; pairing: ReactNode; listState: ReactNode; empty: boolean; footer: ReactNode;
  rename: (device: PairedDevice) => Promise<void>; revoke: (device: PairedDevice) => Promise<void>;
}) {
  const [data, setData] = useState<Data>(), [error, setError] = useState('');
  const [editing, setEditing] = useState<Device>(), [mode, setMode] = useState<Device['mode']>('episodes'), [amount, setAmount] = useState(2);
  const [customAmount, setCustomAmount] = useState(false);
  const [enabled, setEnabled] = useState(true), [pin, setPin] = useState(''), [pinOpen, setPinOpen] = useState(false), [busy, setBusy] = useState(false);
  const revision = useRevalidation();
  const lock = useRef(false);
  const reload = async () => { const result = await api<Data>('/watch-control'); setData(result); };
  useEffect(() => {
    let alive = true, loading = false;
    const read = async () => { if (loading) return; loading = true; try { const result = await api<Data>('/watch-control'); if (alive) { setData(result); setError(''); } } catch (e) { if (alive) setError((e as Error).message); } finally { loading = false; } };
    void read(); const timer = setInterval(() => { if (!document.hidden && navigator.onLine) void read(); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [serial, revision]);
  const execute = async (work: () => Promise<void>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await work(); await reload(); window.dispatchEvent(new Event('molly:watch-controlChanged')); } catch (e) { setError((e as Error).message); await reload().catch(() => {}); }
    finally { lock.current = false; setBusy(false); }
  };
  const command = (device: Device, action: string, extra = {}) => api(`/watch-control/${device.deviceId}/commands`, 'POST', { requestId: crypto.randomUUID(), version: device.version, action, ...extra });
  const act = (device: Device, action: string) => { void execute(async () => { await command(device, action); }); };
  const edit = (device: Device) => { setEditing(device); setMode(device.mode); setAmount(device.amount); setCustomAmount(!(device.mode === 'episodes' ? [1, 2, 3] : [15, 30, 60]).includes(device.amount)); setEnabled(device.enabled || !device.version); setPin(''); };
  const save = () => { if (editing) void execute(async () => {
    if (enabled && !data?.pinSet) { await api('/watch-control/pin', 'PUT', { pin }); }
    await command(editing, 'settings', { enabled, mode: enabled ? mode : editing.mode, amount: enabled ? amount : editing.amount }); setEditing(undefined);
  }); };
  return <Card className="watch-controls">
    <div className="section-heading"><div><h2>我的电视<span className="watch-device-count">{total} 台</span></h2><p className="muted">每台电视独立设置每日额度，北京时间每天 0 点恢复。</p></div>{pairing}</div>
    {error && !editing && !pinOpen && <p role="alert" className="error">{error}</p>}
    {listState}
    {empty && <Empty className="empty">还没有绑定电视，请输入电视上的配对码或扫码绑定。</Empty>}
    <div className="watch-control-devices">{devices.map(paired => {
      const device = data?.devices.find(device => device.deviceId === paired.id);
      const active = device?.enabled && device.status === 'allowed' && !!device.round;
      const round = device?.round;
      const left = round ? round.remainingEpisodes ?? Math.max(0, round.amount - round.cursor - (round.episodeId ? 1 : 0)) : 0;
      return <section key={paired.id} className="watch-control-device" aria-label={paired.name + '观看安排'}>
        <div className="watch-device-info">
          <div className="watch-device-title"><h3>{paired.name}</h3>{device && <span className="watch-device-presence" data-online={device.online}>{device.online ? '在线' : '离线'}</span>}</div>
          {device && !device.online && <p className="watch-device-last-seen muted">最近连接：{dateTime(paired.lastSeen)}</p>}
        </div>
        <div className="watch-device-viewing">
          {device ? <>
            <div className="watch-device-quota"><p>{!device.enabled ? '未限制观看' : !active ? '今日观看已结束' : round?.mode === 'minutes' ? `今日还能看 ${round.remainingMs! < 60000 ? '不到 1' : Math.ceil(round.remainingMs! / 60000)} 分钟` : round?.episodeId ? (left ? `本集之后，还能看 ${left} 集` : '这是今天最后一集') : `今日还能看 ${left} 集`}</p>
              {device.enabled && <span className="muted">每日 {device.amount} {device.mode === 'episodes' ? '集' : '分钟'}{!active ? ' · 明天恢复' : ''}</span>}
            </div>
            {active && round?.episodeName && <p className="muted watch-device-episode" title={`当前一集：${round.episodeName}（可继续）`}>当前一集：{round.episodeName}（可继续）</p>}
            {device.version > device.acknowledged ? <p className="muted" role="status">已安排 · {device.online ? (!device.supported ? '等待兼容客户端确认' : '等待电视确认') : '电视离线，开机联网后生效'}</p> : null}
            {!device.supported && <p className="muted">观看限制需升级电视客户端。</p>}
          </> : <p className="muted" role="status">{error || data ? '暂时无法读取观看额度' : '正在读取电视状态…'}</p>}
        </div>
        {!readonly && <div className="watch-control-actions">
          {device?.enabled && <Button disabled={busy} onClick={() => act(device, 'add')}>{(round?.mode ?? device.mode) === 'episodes' ? '加看 1 集' : '加看 10 分钟'}</Button>}
          <Button variant="bordered" disabled={busy || !device} onClick={() => { if (device) edit({ ...device, name: paired.name }); }}>观看设置</Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`${paired.name}的更多操作`} disabled={busy}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="watch-device-menu">
              <DropdownMenuItem onSelect={() => { void execute(() => rename(paired)); }}>重命名</DropdownMenuItem>
              {active && device && <DropdownMenuItem onSelect={() => act(device, 'stop')}>结束今日观看</DropdownMenuItem>}
              <DropdownMenuItem variant="destructive" onSelect={() => { void execute(() => revoke(paired)); }}>取消配对</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>}
      </section>;
    })}</div>
    {footer}
    {data?.pinSet && <div className="watch-family-pin"><p className="muted">家长密码 · 所有电视共用</p>
      {!readonly && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setPin(''); setPinOpen(true); }}>重设家长密码</Button>}
    </div>}
    <Dialog open={!!editing} onOpenChange={open => { if (!open && !busy) setEditing(undefined); }}>
      <DialogContent className="watch-settings-dialog">
        <DialogHeader>
          <DialogTitle>{editing?.name} · 观看设置</DialogTitle>
          <DialogDescription>首次保存后今天即可观看；修改从明天起生效，不改变今日剩余。加看仅限当天，未用额度不结转；电视离线时也能保存。</DialogDescription>
        </DialogHeader>
        <DialogBody className="watch-settings-body">
          {error && <p role="alert" className="error">{error}</p>}
          <div className="watch-settings-enable">
            <Label htmlFor="watch-enabled">启用观看限制</Label>
            <Switch id="watch-enabled" checked={enabled} onCheckedChange={setEnabled} disabled={busy} />
          </div>
          {enabled && <>
            <div className="form-grid">
              <Label htmlFor="watch-mode">观看方式
                <SelectField id="watch-mode" aria-label="观看方式" value={mode} disabled={busy} onValueChange={value => { const next = value as Device['mode']; setMode(next); setAmount(next === 'episodes' ? 2 : 30); setCustomAmount(false); }} options={[
                  { value: 'episodes', label: '按集数' },
                  { value: 'minutes', label: '按时间' },
                ]} />
              </Label>
              <Label htmlFor="watch-preset">{mode === 'episodes' ? '每天看几集' : '每天看多久'}
                <SelectField id="watch-preset" aria-label={mode === 'episodes' ? '每天看几集' : '每天看多久'} value={customAmount ? 'custom' : String(amount)} disabled={busy} onValueChange={value => { setCustomAmount(value === 'custom'); if (value !== 'custom') setAmount(Number(value)); }} options={[
                  ...(mode === 'episodes' ? [1, 2, 3] : [15, 30, 60]).map(value => ({ value: String(value), label: `${value} ${mode === 'episodes' ? '集' : '分钟'}` })),
                  { value: 'custom', label: '自定义' },
                ]} />
              </Label>
            </div>
            {customAmount && <Label htmlFor="watch-amount">{mode === 'episodes' ? '自定义集数' : '自定义分钟'}
              <Input id="watch-amount" aria-label={mode === 'episodes' ? '自定义集数' : '自定义分钟'} type="number" inputMode="numeric" min={1} max={mode === 'episodes' ? 99 : 600} autoFocus value={amount || ''} disabled={busy} onChange={e => setAmount(Number(e.target.value))} />
              <span className="watch-settings-help">{mode === 'episodes' ? '可设置 1–99 集。' : '可设置 1–600 分钟。'}</span>
            </Label>}
            {!data?.pinSet && <Label htmlFor="watch-pin">家长密码
              <Input id="watch-pin" aria-label="设置四位数字家长密码" type="password" inputMode="numeric" autoComplete="new-password" placeholder="设置 4 位数字密码" maxLength={4} value={pin} disabled={busy} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} />
              <span className="watch-settings-help">家长在电视上加看或修改设置时使用，日常观看无需密码。</span>
            </Label>}
          </>}
          {enabled && <p className="watch-settings-help">{mode === 'episodes' ? '开始一个视频计 1 集，续播同一集不重复计算。' : '只计算实际播放时间，暂停和选片不计时。'}</p>}
          <p className="watch-settings-preview" aria-live="polite">{enabled ? `每日可看 ${amount || '—'} ${mode === 'episodes' ? '集，看完后休息。' : '分钟，时间到暂停并保存进度。'}` : '关闭后，电视可以自由播放。'}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="bordered" disabled={busy} onClick={() => setEditing(undefined)}>取消</Button>
          <Button disabled={busy || (enabled && (!Number.isInteger(amount) || amount < 1 || amount > (mode === 'episodes' ? 99 : 600) || (!data?.pinSet && pin.length !== 4)))} onClick={save}>{busy ? '正在处理…' : '保存设置'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={pinOpen} onOpenChange={open => { if (!busy) setPinOpen(open); }}><DialogContent><DialogHeader><DialogTitle>重设家长密码</DialogTitle><DialogDescription>家庭内的电视共用这个四位数字密码。</DialogDescription></DialogHeader><DialogBody>{error && <p role="alert" className="error">{error}</p>}<Label htmlFor="reset-watch-pin">新密码</Label><Input id="reset-watch-pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} /></DialogBody><DialogFooter><Button disabled={busy || pin.length !== 4} onClick={() => { void execute(async () => { await api('/watch-control/pin', 'PUT', { pin }); setPinOpen(false); setPin(''); }); }}>保存密码</Button></DialogFooter></DialogContent></Dialog>
  </Card>;
}
