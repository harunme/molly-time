import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { ApiError, browserRequest, call, request, type Capabilities } from './api';
import { FocusButton } from './focus';
import { FocusSelect } from './focus-select';

type Channel = { id: string; name: string; group: string };
type Playlist = { enabled: boolean; channels: Channel[] };
type Session = { sessionId: string; url: string; name: string; limitMs: number };
const PAGE_SIZE = 24;

export function LiveTv({ capabilities }: { capabilities?: Capabilities }) {
  const [data, setData] = useState<Playlist>(), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [group, setGroup] = useState('all'), [page, setPage] = useState(0), [active, setActive] = useState<Channel>();
  const [opening, setOpening] = useState(false);
  const [returned, setReturned] = useState(0);
  const launching = useRef(false), lastFocus = useRef('live-refresh');
  useEffect(() => {
    let alive = true;
    void request<Playlist>('/api/live-tv').then(value => {
      if (alive) { setData(value); setGroup('all'); setPage(0); setError(''); }
    }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [reload]);
  useEffect(() => {
    const onReturn = () => { launching.current = false; setOpening(false); setReturned(v => v + 1); };
    window.addEventListener('molly:livePlaybackClosed', onReturn);
    return () => window.removeEventListener('molly:livePlaybackClosed', onReturn);
  }, []);
  useEffect(() => {
    if (!returned) return;
    const frame = requestAnimationFrame(() => {
      setFocus(lastFocus.current);
      document.querySelector<HTMLButtonElement>(`[data-focus="${lastFocus.current}"]`)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [returned]);
  const play = async (channel: Channel) => {
    if (launching.current) return;
    lastFocus.current = `live-${channel.id}`; setError('');
    if (!window.MollyBridge) { setActive(channel); return; }
    if (!capabilities?.liveTv) { setError('请更新电视客户端后观看直播'); return; }
    launching.current = true; setOpening(true);
    try { await call('playLiveChannel', { channelId: channel.id }); }
    catch (e) { launching.current = false; setOpening(false); setError(e instanceof Error ? e.message : '频道打开失败'); }
  };
  const filtered = data?.channels.filter(c => group === 'all' || c.group === group) ?? [];
  const groups = [...new Set(data?.channels.map(c => c.group) ?? [])];
  return <div className="live-tv">
    <p className="live-help">频道由运营管理员统一维护。每次观看最长 30 分钟，家长安排休息后会停止播放。</p>
    <div className="live-toolbar">
      <FocusButton focusKey="live-refresh" className="update-check" disabled={opening} onClick={() => setReload(v => v + 1)}>刷新频道</FocusButton>
      {!!data?.channels.length && <FocusSelect focusKey="live-group" label="频道分组" value={group} options={[{ value: 'all', label: '全部频道' }, ...groups.map(value => ({ value, label: value }))]} onChange={value => { setGroup(value); setPage(0); }} />}
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    {!data && !error && <p role="status">正在加载频道…</p>}
    {data && !data.enabled && <p role="status">电视直播尚未开启，请联系运营管理员导入直播源。</p>}
    {data?.enabled && !data.channels.length && <p role="status">暂无频道，请联系运营管理员。</p>}
    {opening && <p role="status">正在打开直播播放器…</p>}
    {!!filtered.length && <>
      <p className="live-help">{filtered.length} 个频道 · 第 {page + 1} / {Math.ceil(filtered.length / PAGE_SIZE)} 页</p>
      <div className="episode-grid live-grid">{filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(c => <FocusButton key={c.id} focusKey={`live-${c.id}`} className="live-channel" disabled={opening} onClick={() => { void play(c); }}><strong>{c.name}</strong><small>{c.group}</small></FocusButton>)}</div>
      <div className="live-toolbar">
        <FocusButton focusKey="live-previous" disabled={page === 0 || opening} onClick={() => { setPage(p => p - 1); setFocus('live-refresh'); }}>上一页</FocusButton>
        <FocusButton focusKey="live-next" disabled={(page + 1) * PAGE_SIZE >= filtered.length || opening} onClick={() => { setPage(p => p + 1); setFocus('live-refresh'); }}>下一页</FocusButton>
      </div>
    </>}
    {active && <BrowserLive channel={active} channels={filtered} switchChannel={setActive} close={() => { setActive(undefined); requestAnimationFrame(() => setFocus(lastFocus.current)); }} />}
  </div>;
}

function BrowserLive({ channel, channels, switchChannel, close }: { channel: Channel; channels: Channel[]; switchChannel: (channel: Channel) => void; close: () => void }) {
  const video = useRef<HTMLVideoElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState(''), [status, setStatus] = useState('正在连接频道…'), [retry, setRetry] = useState(0);
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const previous = window.mollyBack;
    const back = () => { closeRef.current(); return true; };
    window.mollyBack = back; closeButton.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (['Escape', 'Backspace', 'BrowserBack'].includes(e.key) || [461, 10009].includes(e.keyCode)) {
        e.preventDefault(); e.stopImmediatePropagation(); back();
      } else if (e.key.startsWith('Arrow') || ['Enter', ' '].includes(e.key)) {
        e.stopImmediatePropagation();
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.live-player button:not(:disabled)'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key.startsWith('Arrow')) { e.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 1)))]?.focus(); }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => { if (window.mollyBack === back) window.mollyBack = previous; window.removeEventListener('keydown', key, true); };
  }, []);
  useEffect(() => {
    const media = video.current!;
    let disposed = false, session = '', origin = performance.now(), last = 0, seq = 0, playing = false;
    let destroy = () => {}, deadline: ReturnType<typeof setTimeout> | undefined;
    let chain = Promise.resolve(), checking = false;
    const sample = (next: boolean, stopped = false) => {
      const end = Math.round(performance.now() - origin), begin = last; last = end;
      if (session) {
        for (let start = begin; start < end || (stopped && start === end); start += 60000) {
          const edge = Math.min(end, start + 60000), body = { seq: seq++, startMs: start, endMs: edge, playedMs: playing ? edge - start : 0, positionMs: 0, stopped: stopped && edge === end };
          const id = session;
          chain = chain.then(() => browserRequest(`/api/playback/sessions/${id}/events`, 'POST', body).then(() => {})).catch(() => {});
          if (edge === end) break;
        }
      }
      playing = next;
    };
    const changed = () => sample(!disposed && !media.paused && media.readyState >= 3 && !document.hidden && !media.ended);
    const failed = () => { sample(false); setError('频道暂时无法播放。浏览器还可能受跨域或 HTTP 限制，可在电视客户端尝试。'); };
    const events = ['playing', 'pause', 'waiting', 'ended'] as const;
    events.forEach(name => media.addEventListener(name, changed));
    media.addEventListener('error', failed); document.addEventListener('visibilitychange', changed);
    setError(''); setStatus('正在连接频道…');
    void browserRequest<Session>(`/api/live-tv/channels/${channel.id}/sessions`, 'POST').then(async source => {
      session = source.sessionId; origin = performance.now(); last = 0;
      if (disposed) { sample(false, true); return; }
      deadline = setTimeout(() => closeRef.current(), source.limitMs);
      if (location.protocol === 'https:' && source.url.startsWith('http:')) { setError('此频道使用 HTTP，请在电视客户端观看。'); return; }
      try {
        if (/\.mp4(?:\?|$)/i.test(source.url) || media.canPlayType('application/vnd.apple.mpegurl')) media.src = source.url;
        else {
          const { default: Hls } = await import('hls.js');
          if (disposed) return;
          if (!Hls.isSupported()) { setError('当前浏览器不支持直播，请在电视客户端观看'); return; }
          const hls = new Hls({ maxBufferLength: 20, enableWorker: false }); destroy = () => hls.destroy();
          hls.on(Hls.Events.ERROR, (_event, info) => { if (info.fatal && !disposed) failed(); });
          hls.loadSource(source.url); hls.attachMedia(media);
        }
        setStatus('正在直播');
        await media.play().catch(() => { if (!disposed) setStatus('按播放按钮开始观看'); });
      } catch { if (!disposed) failed(); }
    }).catch(e => { if (!disposed) setError(e instanceof Error ? e.message : '频道加载失败'); });
    const timer = setInterval(() => {
      sample(playing);
      if (!session || checking) return;
      checking = true;
      void browserRequest(`/api/live-tv/sessions/${session}`).catch(e => {
        if (!disposed && e instanceof ApiError && [401, 403, 404].includes(e.status)) closeRef.current();
        else if (!disposed) { media.pause(); setError('网络连接中断，请重试'); }
      }).finally(() => { checking = false; });
    }, 5000);
    return () => {
      disposed = true; sample(false, true); clearInterval(timer); clearTimeout(deadline);
      events.forEach(name => media.removeEventListener(name, changed)); media.removeEventListener('error', failed);
      document.removeEventListener('visibilitychange', changed); media.pause(); destroy(); media.removeAttribute('src'); media.load();
    };
  }, [channel.id, retry]);
  const index = channels.findIndex(c => c.id === channel.id);
  return createPortal(<div className="live-player" role="dialog" aria-modal="true" aria-label={`直播 · ${channel.name}`}>
    <video ref={video} autoPlay playsInline aria-label={channel.name} />
    <div className="live-player-controls"><div><strong>{channel.name}</strong><p role={error ? 'alert' : 'status'}>{error || `${status} · 最长观看 30 分钟`}</p></div>
      <button ref={closeButton} onClick={close}>返回频道</button>
      <button disabled={index <= 0} onClick={() => switchChannel(channels[index - 1])}>上一台</button>
      <button disabled={index < 0 || index >= channels.length - 1} onClick={() => switchChannel(channels[index + 1])}>下一台</button>
      <button onClick={() => { void video.current?.play().catch(() => setError('无法开始播放，请重试')); }}>播放</button>
      <button onClick={() => setRetry(v => v + 1)}>重试</button>
    </div>
  </div>, document.body);
}
