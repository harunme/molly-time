import { demoEnabled } from './demo';
import { useEffect, useRef, useState } from 'react';
import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { ApiError, browserRequest, request, type Capabilities } from './api';
import { FocusButton, FocusRegion } from './focus';

export type Watching = { warningPath?: string | null; farewellPath?: string | null; supported: boolean; pinSet?: boolean; enabled: boolean; mode: 'episodes' | 'minutes'; amount: number; version: number; acknowledged: number; status: 'off' | 'resting' | 'allowed'; round: null | { id: string; mode: 'episodes' | 'minutes'; amount: number; remainingEpisodes?: number | null; limitMs: number; playlist: string[]; cursor: number; playedMs: number; remainingMs: number | null; ended: boolean; stopAfter: boolean; episodeId: string | null; episodeName: string | null } };
export const watchLabel = (state: Watching) => {
  const round = state.round;
  if (!state.enabled) return '观看管理未开启';
  if (state.status === 'resting') return '看完啦，休息一下吧。';
  if (round?.mode === 'minutes') return `还能看 ${round.remainingMs! < 60000 ? '不到 1' : Math.ceil(round.remainingMs! / 60000)} 分钟`;
  if (round) { const left = Math.max(0, round.amount - round.cursor - (round.episodeId ? 1 : 0)); return round.episodeId ? (left ? `本集看完后，还能看 ${left} 集` : '这是最后一集啦。') : `还能看 ${left} 集`; }
  return `可以看 ${state.amount} 集，选一个视频吧。`;
};
const localKey = (id: string) => `mollytime.watch-control.${id}`;
function saved(id: string): { playedMs: number; cursor: number; episodeId?: string | null } {
  try { const value = JSON.parse(localStorage.getItem(localKey(id)) || '{}'); return { playedMs: Math.max(0, Number(value.playedMs) || 0), cursor: Math.max(0, Number(value.cursor) || 0), episodeId: typeof value.episodeId === 'string' ? value.episodeId : null }; }
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
  private completed = false;
  async open() { this.completed = false; this.state = await readWatchControl().catch(e => { if (e instanceof ApiError && e.status === 404) return undefined; throw e; }); this.at = performance.now(); }
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
  private persist() { const round = this.state?.round; if (round) localStorage.setItem(localKey(round.id), JSON.stringify({ playedMs: round.playedMs, cursor: round.cursor, episodeId: round.episodeId })); }
  complete(_episode: string) {
    const round = this.state?.round;
    if (this.state?.enabled && round?.mode === 'episodes' && !this.completed) { this.completed = true; round.cursor++; round.episodeId = null; round.ended = round.cursor >= round.amount; this.persist(); }
  }
  sync() {
    if (demoEnabled || (this.state && !this.state.supported && !this.state.enabled)) return Promise.resolve();
    if (this.syncing) return this.syncing;
    const before = this.state, round = before?.round;
    if (!before) return Promise.resolve();
    const snapshot = { supported: true, acknowledged: before.version, roundId: round?.id, playedMs: round?.playedMs ?? 0, cursor: round?.cursor ?? 0, episodeId: round?.episodeId ?? null };
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

const choices = [
  { mode: 'episodes', amount: 1, label: '1 集' },
  { mode: 'episodes', amount: 2, label: '2 集' },
  { mode: 'episodes', amount: 3, label: '3 集' },
  { mode: 'minutes', amount: 15, label: '15 分钟' },
  { mode: 'minutes', amount: 30, label: '30 分钟' },
  { mode: 'minutes', amount: 60, label: '60 分钟' },
] as const;

export function WatchControlPanel({ state, changed, close, backLabel }: { state?: Watching; changed: (state: Watching) => void; close: () => void; backLabel: string }) {
  const initial = choices.find(choice => choice.mode === state?.mode && choice.amount === state.amount) ?? choices[1];
  const [selection, setSelection] = useState<{ mode: Watching['mode']; amount: number }>({ mode: initial.mode, amount: initial.amount });
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current) return;
    const previous = choices.find(choice => choice.mode === state?.mode && choice.amount === state.amount) ?? choices[1];
    setSelection({ mode: previous.mode, amount: previous.amount });
  }, [state?.mode, state?.amount]);
  const [pinAction, setPinAction] = useState<'start' | 'add' | 'stop'>('start');
  const [enteringPin, setEnteringPin] = useState(false), [pin, setPin] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const pinRef = useRef(''), lock = useRef(false), pinKnown = useRef(!!state?.pinSet), version = useRef(state?.version ?? 0);
  version.current = Math.max(state?.version ?? 0, version.current);
  const attempt = useRef<{ requestId: string; version: number; mode: Watching['mode']; amount: number } | undefined>(undefined);
  const perform = async () => {
    if (!state || pinRef.current.length !== 4 || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      if (!pinKnown.current && !state.pinSet) { await request('/api/watch-control/pin', 'POST', { pin: pinRef.current }); pinKnown.current = true; }
      attempt.current ??= { requestId: crypto.randomUUID(), version: version.current, ...selection };
      const next = await request<Watching>('/api/watch-control/commands', 'POST', { ...attempt.current, action: pinAction, pin: pinRef.current });
      changed({ ...next, pinSet: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : '请连接网络后再试');
      pinRef.current = ''; setPin('');
      // Keep an uncertain request id for safe retry; version conflicts require a fresh attempt.
      if (e instanceof ApiError && e.status === 409) {
        attempt.current = undefined;
        const next = await readWatchControl().catch(() => undefined);
        if (next) { version.current = next.version; pinKnown.current = !!next.pinSet; }
      }
    } finally { lock.current = false; setBusy(false); }
  };
  const performRef = useRef(perform); performRef.current = perform;
  const digit = (value: string) => {
    if (lock.current || pinRef.current.length >= 4) return;
    pinRef.current += value; setPin(pinRef.current);
    if (pinRef.current.length === 4) void performRef.current();
  };
  const digitRef = useRef(digit); digitRef.current = digit;
  useEffect(() => {
    if (!enteringPin) return;
    requestAnimationFrame(() => setFocus('watch-digit-1'));
    const key = (event: KeyboardEvent) => {
      if (/^[0-9]$/.test(event.key) && !event.repeat) {
        event.preventDefault(); event.stopImmediatePropagation(); digitRef.current(event.key);
      } else if (event.key === 'Backspace') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!lock.current) { pinRef.current = pinRef.current.slice(0, -1); setPin(pinRef.current); }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [enteringPin]);
  if (!state) return <section className="watch-parent-panel"><p role="status">请连接网络后设置观看数量。</p><FocusButton focusKey="close-overlay" className="settings-action settings-secondary" onClick={close}>{backLabel}</FocusButton></section>;
  const label = `${selection.amount} ${selection.mode === 'episodes' ? '集' : '分钟'}`;
  if (enteringPin) return <FocusRegion focusKey="watch-pin" boundary className="watch-parent-panel watch-pin-view">
    <h2>{state.pinSet || pinKnown.current ? '输入家长密码' : '设置家长密码'}</h2>
    <p className="watch-pin-summary">{pinAction === 'start' ? `这次看 ${label}` : pinAction === 'add' ? `加看 ${state.round?.mode === 'episodes' ? '1 集' : '10 分钟'}` : '结束本次观看'}</p>
    <div aria-label={`已输入 ${pin.length} 位密码`} className="watch-pin-dots">{[0, 1, 2, 3].map(index => <span key={index} className={index < pin.length ? 'filled' : ''} />)}</div>
    <div className="watch-pin-pad">{[1, 2, 3, 4, 5, 6, 7, 8, 9].map(value => <FocusButton key={value} focusKey={`watch-digit-${value}`} disabled={busy} onClick={() => digit(String(value))}>{value}</FocusButton>)}
      <FocusButton focusKey="watch-pin-delete" disabled={busy} onClick={() => { pinRef.current = pinRef.current.slice(0, -1); setPin(pinRef.current); }}>删除</FocusButton>
      <FocusButton focusKey="watch-digit-0" disabled={busy} onClick={() => digit('0')}>0</FocusButton>
      <FocusButton focusKey="watch-pin-cancel" disabled={busy} onClick={() => { setEnteringPin(false); setPin(''); pinRef.current = ''; attempt.current = undefined; setError(''); requestAnimationFrame(() => setFocus('watch-parent-main')); }}>返回</FocusButton>
    </div>
    <div className="watch-pin-feedback" aria-live="polite">{error ? <p role="alert" className="error">{error}</p> : <p role="status">{busy ? '正在处理…' : pinAction === 'start' ? '输入 4 位数字后自动开始' : '输入 4 位数字后自动确认'}</p>}</div>
  </FocusRegion>;
  if (state.enabled && state.status === 'allowed' && state.round) return <section className="watch-parent-panel watch-quantity-view">
    <h2>本次观看</h2><p>{watchLabel(state)}</p>
    {state.round.episodeName && <p className="watch-current">当前一集：{state.round.episodeName}（可继续）</p>}
    <div className="watch-parent-actions">
      <FocusButton focusKey="watch-parent-main" className="primary settings-action" onClick={() => { setPinAction('add'); attempt.current = undefined; setEnteringPin(true); setError(''); }}>{state.round.mode === 'episodes' ? '加看 1 集' : '加看 10 分钟'}</FocusButton>
      <FocusButton focusKey="watch-end" className="settings-action settings-secondary" onClick={() => { setPinAction('stop'); attempt.current = undefined; setEnteringPin(true); setError(''); }}>结束观看</FocusButton>
    </div>
    <FocusButton focusKey="close-overlay" className="settings-action settings-secondary" onClick={close}>{backLabel}</FocusButton>
  </section>;
  return <section className="watch-parent-panel watch-quantity-view">
    <h2>这次看多少</h2>
    <p>选一个数量，看完自动休息。</p>
    <div className="watch-amount-grid" role="group" aria-label="观看数量">{choices.map(choice => <FocusButton key={choice.label} ariaLabel={choice.label} focusKey={`watch-choice-${choice.mode}-${choice.amount}`} selected={selection.mode === choice.mode && selection.amount === choice.amount} className={selection.mode === choice.mode && selection.amount === choice.amount ? 'primary' : ''} onClick={() => { touched.current = true; setSelection({ mode: choice.mode, amount: choice.amount }); }}>{choice.label}</FocusButton>)}</div>
    <p className="watch-current">{selection.mode === 'episodes' ? '开始一个视频计 1 集，续播不重复计数。' : '只计算播放时间，暂停和选片不计时。'}</p>
    <div className="watch-parent-actions"><FocusButton focusKey="watch-parent-main" className="primary settings-action" onClick={() => { touched.current = true; setPinAction('start'); attempt.current = undefined; setEnteringPin(true); setError(''); }}>开始观看</FocusButton></div>
    {state.enabled && state.status === 'allowed' && <p className="watch-current">{watchLabel(state)} · 返回后可继续看</p>}
    <FocusButton focusKey="close-overlay" className="settings-action settings-secondary" onClick={close}>{backLabel}</FocusButton>
  </section>;
}
