import { SelectField } from "./components/ui/select";
import { Switch } from "./components/ui/switch";
import { Link } from "react-router";
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './components/ui/dialog';

type Device = { deviceId: string; name: string; online: boolean; supported: boolean; enabled: boolean; mode: 'episodes' | 'minutes'; amount: number; version: number; acknowledged: number; status: string; round: null | { mode: string; cursor: number; playlist: string[]; episodeName: string | null; remainingMs: number | null; ended: boolean } };
type Data = { pinSet: boolean; devices: Device[] };
export function WatchControls({ readonly, compact = false }: { readonly: boolean; compact?: boolean }) {
  const [data, setData] = useState<Data>(), [error, setError] = useState('');
  const [editing, setEditing] = useState<Device>(), [mode, setMode] = useState<Device['mode']>('episodes'), [amount, setAmount] = useState(2);
  const [customAmount, setCustomAmount] = useState(false);
  const [enabled, setEnabled] = useState(true), [pin, setPin] = useState(''), [pinOpen, setPinOpen] = useState(false), [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const reload = async () => { const result = await api<Data>('/watch-control'); setData(result); };
  useEffect(() => {
    let alive = true, loading = false;
    const read = async () => { if (loading) return; loading = true; try { const result = await api<Data>('/watch-control'); if (alive) { setData(result); } } catch (e) { if (alive) setError((e as Error).message); } finally { loading = false; } };
    void read(); const timer = setInterval(() => { void read(); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const execute = async (work: () => Promise<void>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await work(); await reload(); window.dispatchEvent(new Event('molly:watch-controlChanged')); } catch (e) { setError((e as Error).message); await reload().catch(() => {}); }
    finally { lock.current = false; setBusy(false); }
  };
  const command = (device: Device, action: string, extra = {}) => api(`/watch-control/${device.deviceId}/commands`, 'POST', { requestId: crypto.randomUUID(), version: device.version, action, ...extra });
  const act = (device: Device, action: string) => { void execute(async () => { await command(device, action); }); };
  const edit = (device: Device) => { setEditing(device); setMode(device.mode); setAmount(device.amount); setCustomAmount(!(device.mode === 'episodes' ? [1, 2, 3] : [15, 30, 45, 60]).includes(device.amount)); setEnabled(true); setPin(''); };
  const save = () => { if (editing) void execute(async () => {
    if (enabled && !data?.pinSet) { await api('/watch-control/pin', 'PUT', { pin }); }
    await command(editing, 'settings', { enabled, mode: enabled ? mode : editing.mode, amount: enabled ? amount : editing.amount }); setEditing(undefined);
  }); };
  return <Card className={`watch-controls${compact ? " watch-controls-compact" : ""}`}>
    <div className="section-heading"><div><h2>观看安排</h2><p className="muted">{compact ? '允许观看、临时加看或安排休息。' : '设置平时看几集或看多久，家长允许后观看。'}</p></div>
      {compact && <Button variant="ghost" asChild><Link to="/family/watching">观看设置</Link></Button>}
      {!compact && !readonly && data?.pinSet && <Button variant="ghost" onClick={() => { setPin(''); setPinOpen(true); }}>重设家长密码</Button>}</div>
    {error && !editing && !pinOpen && <p role="alert" className="error">{error}</p>}
    {!data && !error && <p role="status">正在读取电视状态…</p>}
    {data && !data.devices.length && <p className="muted">绑定电视后，可以在这里安排观看。</p>}
    <div className="watch-control-devices">{data?.devices.map(device => <section key={device.deviceId} className="watch-control-device" aria-label={device.name + '观看安排'}>
      <div><h3>{device.name}<span className="muted"> · {device.online ? '在线' : '离线'}</span></h3>
        <p>{device.enabled && (!device.supported || device.version > device.acknowledged) ? '观看管理已开启，等待电视同步' : !device.enabled ? '观看管理未开启' : device.status === 'resting' ? '正在休息' : device.round?.mode === 'minutes' ? `还能看 ${device.round.remainingMs! < 60000 ? '不到 1' : Math.ceil(device.round.remainingMs! / 60000)} 分钟` : device.round?.playlist.length ? `正在看第 ${device.round.cursor + 1} 集，共 ${device.round.playlist.length} 集` : `可以看 ${device.round?.mode === 'episodes' ? device.amount + ' 集' : ''}，选一个视频吧`}</p>
        {device.round?.episodeName && device.status === 'allowed' && <p className="muted">{device.round.episodeName}</p>}
        {device.enabled && <p className="muted">平时每次看 {device.amount} {device.mode === 'episodes' ? '集' : '分钟'}</p>}
        {device.version > device.acknowledged && <p className="muted" role="status">已保存 · {device.online ? (!device.supported ? '等待兼容客户端确认' : '等待电视确认') : '电视离线，开机后同步'}</p>}
        {!device.supported && <p className="muted">可以先保存设置，电视开机后同步；旧版客户端需升级后执行。</p>}
      </div>
      {!readonly && <div className="watch-control-actions">
        {device.enabled && device.status === 'resting' && <Button disabled={busy} onClick={() => act(device, 'allow')}>允许观看</Button>}
        {device.enabled && device.round && <Button disabled={busy} variant={device.status === 'allowed' ? 'default' : 'bordered'} onClick={() => act(device, 'add')}>{device.round.mode === 'episodes' ? '再看一集' : '再看 10 分钟'}</Button>}
        {device.enabled && device.status === 'allowed' && <Button variant="bordered" disabled={busy} onClick={() => act(device, device.round?.mode === 'episodes' ? 'finish-current' : 'stop')}>{device.round?.mode === 'episodes' ? (device.round.playlist.length ? '看完这集休息' : '再看一集就休息') : '现在休息'}</Button>}
        {!compact && <Button variant={device.enabled ? "bordered" : "default"} disabled={busy} onClick={() => edit(device)}>{device.enabled ? '观看设置' : '开启观看管理'}</Button>}
        {device.enabled && <details><summary>更多</summary><div className="watch-control-more">
          {device.enabled && device.status === 'allowed' && device.round?.mode === 'episodes' && <Button variant="ghost" disabled={busy} onClick={() => act(device, 'stop')}>现在休息</Button>}
          {device.enabled && <Button variant="ghost" disabled={busy} onClick={() => act(device, 'reselect')}>重新选片</Button>}

        </div></details>}
      </div>}
    </section>)}</div>
    <Dialog open={!!editing} onOpenChange={open => { if (!open && !busy) setEditing(undefined); }}>
      <DialogContent className="watch-settings-dialog">
        <DialogHeader>
          <DialogTitle>{editing?.name} · 观看设置</DialogTitle>
          <DialogDescription>设置每次看多少，电视开机后同步。</DialogDescription>
        </DialogHeader>
        <DialogBody className="watch-settings-body">
          {error && <p role="alert" className="error">{error}</p>}
          <div className="watch-settings-enable">
            <Label htmlFor="watch-enabled">开启观看管理</Label>
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
              <Label htmlFor="watch-preset">{mode === 'episodes' ? '每次看几集' : '每次看多久'}
                <SelectField id="watch-preset" aria-label={mode === 'episodes' ? '每次看几集' : '每次看多久'} value={customAmount ? 'custom' : String(amount)} disabled={busy} onValueChange={value => { setCustomAmount(value === 'custom'); if (value !== 'custom') setAmount(Number(value)); }} options={[
                  ...(mode === 'episodes' ? [1, 2, 3] : [15, 30, 45, 60]).map(value => ({ value: String(value), label: `${value} ${mode === 'episodes' ? '集' : '分钟'}` })),
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
              <span className="watch-settings-help">在电视上允许观看或加看时使用。</span>
            </Label>}
          </>}
          <p className="watch-settings-preview" aria-live="polite">{enabled ? `每次看 ${amount || '—'} ${mode === 'episodes' ? '集，看完后休息。' : '分钟，时间到暂停并保存进度。'}` : '关闭后，电视可以自由播放。'}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="bordered" disabled={busy} onClick={() => setEditing(undefined)}>取消</Button>
          <Button disabled={busy || (enabled && (!Number.isInteger(amount) || amount < 1 || amount > (mode === 'episodes' ? 99 : 600) || (!data?.pinSet && pin.length !== 4)))} onClick={save}>{busy ? '正在保存…' : '保存设置'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={pinOpen} onOpenChange={open => { if (!busy) setPinOpen(open); }}><DialogContent><DialogHeader><DialogTitle>重设家长密码</DialogTitle><DialogDescription>家庭内的电视共用这个四位数字密码。</DialogDescription></DialogHeader><DialogBody>{error && <p role="alert" className="error">{error}</p>}<Label htmlFor="reset-watch-pin">新密码</Label><Input id="reset-watch-pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} /></DialogBody><DialogFooter><Button disabled={busy || pin.length !== 4} onClick={() => { void execute(async () => { await api('/watch-control/pin', 'PUT', { pin }); setPinOpen(false); setPin(''); }); }}>保存密码</Button></DialogFooter></DialogContent></Dialog>
  </Card>;
}
