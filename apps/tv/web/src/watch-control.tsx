import { demoEnabled } from './demo';
import { useEffect, useRef, useState } from 'react';
import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { ApiError, browserRequest, request, type Capabilities } from './api';
import { FocusButton, FocusRegion } from './focus';

export type Watching = { warningPath?: string | null; farewellPath?: string | null; supported: boolean; pinSet?: boolean; enabled: boolean; mode: 'episodes' | 'minutes'; amount: number; version: number; acknowledged: number; status: 'off' | 'resting' | 'allowed'; round: null | { id: string; mode: 'episodes' | 'minutes'; amount: number; limitMs: number; playlist: string[]; cursor: number; playedMs: number; remainingMs: number | null; ended: boolean; stopAfter: boolean; episodeId: string | null; episodeName: string | null } };
export const watchLabel = (state: Watching) => {
  const round = state.round;
  if (!state.enabled) return '观看管理未开启';
  if (state.status === 'resting') return '看完啦，休息一下吧。';
  if (round?.mode === 'minutes') return `还能看 ${round.remainingMs! < 60000 ? '不到 1' : Math.ceil(round.remainingMs! / 60000)} 分钟`;
  if (round?.playlist.length) return round.cursor + 1 === round.playlist.length ? '这是最后一集啦。' : `正在看第 ${round.cursor + 1} 集，共 ${round.playlist.length} 集`;
  return `可以看 ${round?.amount ?? state.amount} 集，选一个视频吧。`;
};
const localKey = (id: string) => `mollytime.watch-control.${id}`;
function saved(id: string): { playedMs: number; cursor: number } {
  try { const value = JSON.parse(localStorage.getItem(localKey(id)) || '{}'); return { playedMs: Math.max(0, Number(value.playedMs) || 0), cursor: Math.max(0, Number(value.cursor) || 0) }; }
  catch { return { playedMs: 0, cursor: 0 }; }
}
const unavailable = (): Watching => ({ supported: false, enabled: false, mode: 'episodes', amount: 2, version: 0, acknowledged: 0, status: 'off', round: null });
export async function readWatchControl(): Promise<Watching> {
  if (demoEnabled) return unavailable();
  const state = await request<Watching>('/api/watch-control');
  if (!state || typeof state.enabled !== 'boolean' || !Number.isInteger(state.version)) return unavailable();
  if (window.MollyBridge) return state;
  const local = state.round ? saved(state.round.id) : { playedMs: 0, cursor: 0 };
  return { pinSet: state.pinSet, ...await browserRequest<Watching>('/api/watch-control/sync', 'POST', { supported: true, acknowledged: state.version, roundId: state.round?.id, ...local }) };
}

/** Browser-only counter. Native playback uses a persisted prepaid monotonic clock. */
export class BrowserWatchGuard {
  state?: Watching;
  private at = performance.now();
  private playing = false;
  private syncing?: Promise<void>;
  async open() { this.state = await readWatchControl().catch(e => { if (e instanceof ApiError && e.status === 404) return undefined; throw e; }); this.at = performance.now(); }
  sample(playing: boolean): boolean {
    const now = performance.now(), round = this.state?.round;
    if (this.playing && round && this.state?.enabled && this.state.status === 'allowed') {
      round.playedMs += Math.max(0, Math.round(now - this.at));
      if (round.mode === 'minutes') round.remainingMs = Math.max(0, round.limitMs - round.playedMs);
      try { this.persist(); } catch { this.playing = false; return false; }
    }
    this.at = now; this.playing = playing;
    return !this.state?.enabled || (this.state.status === 'allowed' && !round?.ended && (round?.mode !== 'minutes' || round.remainingMs! > 0));
  }
  private persist() { const round = this.state?.round; if (round) localStorage.setItem(localKey(round.id), JSON.stringify({ playedMs: round.playedMs, cursor: round.cursor })); }
  complete(episode: string) {
    const round = this.state?.round;
    if (this.state?.enabled && round?.mode === 'episodes' && round.playlist[round.cursor] === episode) { round.cursor++; this.persist(); }
  }
  sync() {
    if (demoEnabled || (this.state && !this.state.supported && !this.state.enabled)) return Promise.resolve();
    if (this.syncing) return this.syncing;
    const before = this.state, round = before?.round;
    if (!before) return Promise.resolve();
    const snapshot = { supported: true, acknowledged: before.version, roundId: round?.id, playedMs: round?.playedMs ?? 0, cursor: round?.cursor ?? 0 };
    this.syncing = browserRequest<Watching>('/api/watch-control/sync', 'POST', snapshot).then(next => {
      if (next.round && round && next.round.id === round.id) {
        next.round.playedMs = Math.max(next.round.playedMs, round.playedMs);
        next.round.cursor = Math.max(next.round.cursor, round.cursor);
        if (next.round.mode === 'minutes') next.round.remainingMs = Math.max(0, next.round.limitMs - next.round.playedMs);
      }
      this.state = next;
    }).finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
}

export function useWatchControl(authenticated: boolean, capabilities?: Capabilities) {
  const [state, setState] = useState<Watching>();
  const supported = !demoEnabled && authenticated && (!window.MollyBridge || !!capabilities?.watchControl);
  useEffect(() => {
    if (!supported) { setState(undefined); return; }
    let alive = true, busy = false;
    const reload = async () => { if (busy) return; busy = true; try { const next = await readWatchControl(); if (alive) setState(next); } catch { /* The player enforces its persisted policy when disconnected. */ } finally { busy = false; } };
    void reload(); const timer = setInterval(() => { void reload(); }, 3000);
    const returned = () => { void reload(); };
    window.addEventListener('molly:playbackClosed', returned);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('molly:playbackClosed', returned); };
  }, [supported]);
  return { state, setState };
}

export function WatchControlPanel({ state, changed }: { state?: Watching; changed: (state: Watching) => void }) {
  const [action, setAction] = useState<string>(), [pin, setPin] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false), [mode, setMode] = useState<Watching['mode']>(state?.mode ?? 'episodes'), [amount, setAmount] = useState(state?.amount ?? 2), [custom, setCustom] = useState(false), [customValue, setCustomValue] = useState('');
  const pinRef = useRef(''), lock = useRef(false);
  const choose = (value: string) => { setAction(value); setPin(''); pinRef.current = ''; setError(''); };
  const perform = async () => {
    if (!state || pinRef.current.length !== 4 || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      if (!state.pinSet) await request('/api/watch-control/pin', 'POST', { pin: pinRef.current });
      const next = await request<Watching>('/api/watch-control/commands', 'POST', { requestId: crypto.randomUUID(), version: state.version, action, pin: pinRef.current,
        ...(action === 'settings' ? { enabled: !state.enabled || settings, mode, amount } : {}) });
      changed({ ...next, pinSet: true }); setAction(undefined); setSettings(false); setPin(''); pinRef.current = '';
      requestAnimationFrame(() => setFocus('watch-parent-main'));
    } catch (e) { setError(e instanceof Error ? e.message : '请连接网络后再试'); setPin(''); pinRef.current = ''; const next = await readWatchControl().catch(() => undefined); if (next) changed(next); }
    finally { lock.current = false; setBusy(false); }
  };
  useEffect(() => {
    if (!settings || !custom || action) return;
    const key = (event: KeyboardEvent) => {
      if ((!/^[0-9]$/.test(event.key) && event.key !== 'Backspace') || event.repeat) return;
      event.preventDefault(); event.stopImmediatePropagation();
      setCustomValue(previous => { const next = event.key === 'Backspace' ? previous.slice(0, -1) : (previous + event.key).slice(-3); setAmount(Number(next)); return next; });
    };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, [settings, custom, action]);
  const performRef = useRef(perform); performRef.current = perform;
  useEffect(() => {
    if (!action) return;
    requestAnimationFrame(() => setFocus('watch-digit-1'));
    const key = (event: KeyboardEvent) => {
      if (/^[0-9]$/.test(event.key) && !event.repeat) { event.preventDefault(); event.stopImmediatePropagation(); if (!lock.current && pinRef.current.length < 4) { pinRef.current += event.key; setPin(pinRef.current); } }
      if (event.key === 'Backspace') { event.preventDefault(); event.stopImmediatePropagation(); if (!lock.current) { pinRef.current = pinRef.current.slice(0, -1); setPin(pinRef.current); } }
      if (event.key === 'Enter' && pinRef.current.length === 4 && !event.repeat) { event.preventDefault(); event.stopImmediatePropagation(); void performRef.current(); }
    };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, [action]);
  if (!state) return <p role="status">请连接网络读取观看安排；旧客户端需要升级。</p>;
  if (action) return <FocusRegion focusKey="watch-pin" boundary className="watch-parent-panel">
    <h2>{state.pinSet ? '请输入家长密码' : '设置四位数字家长密码'}</h2><p>家长操作需要联网</p>
    <div aria-label={`已输入 ${pin.length} 位密码`} className="watch-pin-dots">{[0, 1, 2, 3].map(index => <span key={index}>{index < pin.length ? '●' : '○'}</span>)}</div>
    <div className="watch-pin-pad">{[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map(digit => <FocusButton key={digit} focusKey={`watch-digit-${digit}`} disabled={busy} onClick={() => { if (pinRef.current.length < 4) { pinRef.current += digit; setPin(pinRef.current); } }}>{digit}</FocusButton>)}<FocusButton focusKey="watch-pin-delete" disabled={busy} onClick={() => { pinRef.current = pinRef.current.slice(0, -1); setPin(pinRef.current); }}>删除</FocusButton></div>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="watch-parent-actions"><FocusButton focusKey="watch-pin-confirm" className="primary" disabled={busy || pin.length !== 4} onClick={() => { void perform(); }}>{busy ? '正在办理…' : '确定'}</FocusButton><FocusButton focusKey="watch-pin-cancel" disabled={busy} onClick={() => { setAction(undefined); setPin(''); pinRef.current = ''; requestAnimationFrame(() => setFocus('watch-parent-main')); }}>取消</FocusButton></div>
  </FocusRegion>;
  if (settings) return <section className="watch-parent-panel"><h2>平时每次看多少</h2><div className="watch-parent-actions">{(['episodes', 'minutes'] as const).map(value => <FocusButton key={value} focusKey={`watch-mode-${value}`} className={mode === value ? 'primary' : ''} onClick={() => { setMode(value); setAmount(value === 'episodes' ? 2 : 30); setCustom(false); }}>{value === 'episodes' ? '按集数' : '按时间'}</FocusButton>)}</div>
    <div className="watch-parent-actions">{(mode === 'episodes' ? [1, 2, 3] : [15, 30, 45, 60]).map(value => <FocusButton key={value} focusKey={`watch-amount-${value}`} className={!custom && amount === value ? 'primary' : ''} onClick={() => { setAmount(value); setCustom(false); }}>{value} {mode === 'episodes' ? '集' : '分钟'}</FocusButton>)}<FocusButton focusKey="watch-custom" onClick={() => { setCustom(true); setCustomValue(''); setAmount(0); requestAnimationFrame(() => setFocus('watch-custom-plus')); }}>自定义</FocusButton></div>
    {custom && <div><p>用遥控器数字键输入{mode === 'episodes' ? '集数（1～99）' : '分钟（1～600）'}：<output aria-label="自定义观看数量">{customValue || '—'}</output></p><div className="watch-parent-actions"><FocusButton focusKey="watch-custom-minus" onClick={() => { const next = Math.max(1, amount - 1); setAmount(next); setCustomValue(String(next)); }}>减少</FocusButton><FocusButton focusKey="watch-custom-plus" onClick={() => { const next = Math.min(mode === 'episodes' ? 99 : 600, amount + 1); setAmount(next); setCustomValue(String(next)); }}>增加</FocusButton></div></div>}
    <p>每次看 {amount} {mode === 'episodes' ? '集，看完休息。' : '分钟，时间到休息。'}下次允许观看时生效。</p>
    <FocusButton focusKey="watch-parent-main" className="primary" disabled={!Number.isInteger(amount) || amount < 1 || amount > (mode === 'episodes' ? 99 : 600)} onClick={() => choose('settings')}>保存设置</FocusButton>
    <FocusButton focusKey="watch-settings-back" onClick={() => { setSettings(false); requestAnimationFrame(() => setFocus('watch-parent-main')); }}>返回</FocusButton></section>;
  return <section className="watch-parent-panel"><h2>观看安排</h2><p role="status">{watchLabel(state)}</p><p>平时每次看 {state.amount} {state.mode === 'episodes' ? '集' : '分钟'}</p>
    <div className="watch-parent-actions">
      {!state.enabled ? <FocusButton focusKey="watch-parent-main" className="primary" onClick={() => { setSettings(true); requestAnimationFrame(() => setFocus('watch-mode-episodes')); }}>开启观看管理</FocusButton> : <>
        <FocusButton focusKey="watch-parent-main" className="primary" onClick={() => choose(state.status === 'resting' ? 'allow' : 'add')}>{state.status === 'resting' ? '允许观看' : state.round?.mode === 'episodes' ? '再看一集' : '再看 10 分钟'}</FocusButton>
        {state.round && state.status === 'resting' && <FocusButton focusKey="watch-add-rest" onClick={() => choose('add')}>{state.round.mode === 'episodes' ? '再看一集' : '再看 10 分钟'}</FocusButton>}
        {state.status === 'allowed' && <FocusButton focusKey="watch-finish" onClick={() => choose(state.round?.mode === 'episodes' ? 'finish-current' : 'stop')}>{state.round?.mode === 'episodes' ? (state.round.playlist.length ? '看完这集休息' : '再看一集就休息') : '现在休息'}</FocusButton>}
      </>}
    </div>
    {state.enabled && <div className="watch-parent-actions"><FocusButton focusKey="watch-settings" onClick={() => { setMode(state.mode); setAmount(state.amount); setSettings(true); requestAnimationFrame(() => setFocus('watch-mode-' + state.mode)); }}>观看设置</FocusButton><FocusButton focusKey="watch-reselect" onClick={() => choose('reselect')}>重新选片</FocusButton>{state.status === 'allowed' && state.round?.mode === 'episodes' && <FocusButton focusKey="watch-stop" onClick={() => choose('stop')}>现在休息</FocusButton>}<FocusButton focusKey="watch-disable" onClick={() => { setSettings(false); choose('settings'); }}>关闭观看管理</FocusButton></div>}
  </section>;
}
