import { useEffect, useRef, useState } from 'react';
import { browserMediaUrl, browserRequest } from './api';

type Playback = { mediaId: string; url: string; mime: string; subtitles: { index: number; url: string; language: string; label: string; isDefault: boolean }[] };
export function BrowserPlaybackHost() {
  const [target, setTarget] = useState<{ episodeId: string; fromStart?: boolean }>();
  useEffect(() => {
    const open = (event: Event) => setTarget((event as CustomEvent).detail);
    window.addEventListener('molly:browserPlay', open);
    return () => window.removeEventListener('molly:browserPlay', open);
  }, []);
  const close = () => { setTarget(undefined); window.dispatchEvent(new CustomEvent('molly:playbackClosed', { detail: { episodeId: target?.episodeId } })); };
  return target ? <BrowserPlayback key={target.episodeId} episode={target.episodeId} fromStart={!!target.fromStart} playNext={(episodeId) => setTarget({ episodeId, fromStart: true })} close={close} /> : null;
}
type EpisodeProps = { episode: string; fromStart: boolean; playNext: (episodeId: string) => void; close: () => void };
function ParentClip({ path, label, done, close }: { path: string; label: string; done: () => void; close: () => void }) {
  const [info, setInfo] = useState<Playback>(), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const ended = useRef(false), retryButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let alive = true;
    setInfo(undefined); setError(''); ended.current = false;
    void browserRequest<Playback>(path).then((result) => { if (alive) setInfo(result); })
      .catch(() => { if (alive) setError('家长视频加载失败，请重试或返回'); });
    return () => { alive = false; };
  }, [path, retry]);
  useEffect(() => {
    document.querySelector<HTMLButtonElement>('.parent-clip-player .player-close')?.focus();
    const key = (event: KeyboardEvent) => {
      if (['Escape', 'Backspace', 'BrowserBack'].includes(event.key) || [461, 10009].includes(event.keyCode)) {
        event.preventDefault(); event.stopImmediatePropagation(); close();
      } else if (event.key.startsWith('Arrow')) {
        event.preventDefault(); event.stopImmediatePropagation();
        (retryButton.current || document.querySelector<HTMLButtonElement>('.player-close'))?.focus();
      }
    };
    const timer = setInterval(() => { void browserRequest('/api/me').catch((failure) => { if ([401, 403].includes(failure.status)) close(); }); }, 15000);
    window.addEventListener('keydown', key, true);
    return () => { clearInterval(timer); window.removeEventListener('keydown', key, true); };
  }, []);
  useEffect(() => { if (error) retryButton.current?.focus(); }, [error]);
  return <div role="dialog" aria-label="家长视频提醒" className="parent-clip-player" data-parent-clip={label}>
    {info && <video key={retry} src={browserMediaUrl(info.url)} autoPlay controls aria-label={label}
      onEnded={() => { if (!ended.current) { ended.current = true; done(); } }}
      onError={() => setError('家长视频播放失败，请重试或返回')} />}
    {!info && !error && <p role="status">正在加载{label}…</p>}
    {error && <div className="parent-clip-error"><p role="alert">{error}</p><button ref={retryButton} onClick={() => setRetry((v) => v + 1)}>重试家长视频</button></div>}
    <button className="player-close" onClick={close}>返回视频列表</button>
  </div>;
}

type ReminderState = { requestId: string | null; phase: 'idle' | 'pending' | 'watching' | 'done'; episodeId: string | null; warningPath?: string; farewellPath?: string };
function BrowserPlayback({ episode, fromStart, playNext, close }: EpisodeProps) {
  const [clip, setClip] = useState<{ path: string; label: string; after: boolean; requestId: string }>();
  const activeClip = useRef(false), shownReminder = useRef('');
  const readReminder = async () => {
    const state = await browserRequest<ReminderState>('/api/reminders/state').catch((failure) => {
      if (failure.status === 404) return { requestId: null, phase: 'idle', episodeId: null } as ReminderState;
      throw failure;
    });
    return state;
  };
  const showWarning = (state: ReminderState) => {
    if (closed.current || activeClip.current || !state.requestId || state.phase !== 'pending' || state.episodeId !== episode || shownReminder.current === state.requestId) return;
    shownReminder.current = state.requestId;
    menuOpen.current = false; setMenu(false);
    sample(); playing.current = false; video.current?.pause();
    activeClip.current = true;
    setClip({ path: state.warningPath!, label: '茉莉，还剩 1 集哦', after: false, requestId: state.requestId });
  };
  const clipDone = async () => {
    if (!clip || closed.current) return;
    if (clip.after) { finish(); return; }
    try {
      await browserRequest(`/api/reminders/requests/${clip.requestId}/ack`, 'POST');
      if (closed.current) return;
      activeClip.current = false; setClip(undefined);
      if (completed.current) void advance(); else void video.current?.play().catch(() => {});
    } catch (failure) {
      if ((failure as { status?: number }).status === 404) { activeClip.current = false; setClip(undefined); void video.current?.play().catch(() => {}); }
      else finish();
    }
  };
  const [info, setInfo] = useState<Playback>(), [error, setError] = useState('');
  const completed = useRef(false), stopped = useRef(false), closed = useRef(false);
  const video = useRef<HTMLVideoElement>(null), session = useRef(''), position = useRef(0);
  const [serial, setSerial] = useState(0), [nextPending, setNextPending] = useState(false), [nextError, setNextError] = useState(false);
  const advancing = useRef(false), retryButton = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false), menuOpen = useRef(false);
  const [subtitle, setSubtitle] = useState<number | null | undefined>(), selectedSubtitle = useRef<number | null | undefined>(undefined);
  const [speed, setSpeed] = useState(1), selectedSpeed = useRef(1);
  const menuPanel = useRef<HTMLDivElement>(null), menuButton = useRef<HTMLButtonElement>(null);
  const showMenu = (open: boolean) => {
    menuOpen.current = open; setMenu(open);
    if (!open) menuButton.current?.focus();
  };
  useEffect(() => {
    if (menu) (menuPanel.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') || menuPanel.current?.querySelector<HTMLButtonElement>('button'))?.focus();
  }, [menu]);
  const applySubtitle = () => {
    const media = video.current;
    if (!media || !info) return;
    const index = selectedSubtitle.current === undefined ? info.subtitles.find((sub) => sub.isDefault)?.index ?? null : selectedSubtitle.current;
    Array.from(media.textTracks).forEach((track, offset) => { track.mode = info.subtitles[offset]?.index === index ? 'showing' : 'disabled'; });
  };
  useEffect(() => {
    if (info && selectedSubtitle.current === undefined) {
      selectedSubtitle.current = info.subtitles.find((sub) => sub.isDefault)?.index ?? null;
      setSubtitle(selectedSubtitle.current);
    }
    applySubtitle();
  }, [info]);
  useEffect(() => { if (nextError) retryButton.current?.focus(); }, [nextError]);
  const seq = useRef(0), start = useRef(performance.now()), last = useRef(0), playing = useRef(false), retries = useRef(0);
  const chain = useRef(Promise.resolve());
  const sample = (stoppedEvent = false) => {
    if (!session.current || stopped.current) return;
    if (stoppedEvent) stopped.current = true;
    const end = Math.round(performance.now() - start.current), begin = last.current;
    position.current = video.current?.currentTime ?? position.current;
    last.current = end;
    // Split intervals after background throttling; server accepts at most 60 seconds.
    for (let a = begin; a < end || (stoppedEvent && a === end); a += 60000) {
      const b = Math.min(a + 60000, end), final = b === end;
      const body = { seq: seq.current++, startMs: a, endMs: b, playedMs: playing.current && !document.hidden ? b - a : 0,
        positionMs: Math.round(position.current * 1000), completed: completed.current || !!video.current?.ended, stopped: stoppedEvent && final };
      const id = session.current;
      chain.current = chain.current.then(() => browserRequest(`/api/playback/sessions/${id}/events`, 'POST', body).then(() => {})).catch(() => {});
      if (final) break;
    }
  };
  const finish = () => {
    if (closed.current) return;
    closed.current = true;
    // Read the media position while the video is still mounted.
    sample(true); playing.current = false; video.current?.pause(); close();
  };
  const advance = async () => {
    if (advancing.current || closed.current) return;
    advancing.current = true; setNextPending(true); setNextError(false); setError('');
    sample(true); playing.current = false;
    try {
      // Finish the old viewing session before starting the next episode.
      await chain.current;
      if (closed.current) return;
      const state = await readReminder();
      if (closed.current) return;
      if (state.requestId && state.episodeId === episode && state.phase !== 'idle') {
        activeClip.current = true;
        setClip({ path: state.farewellPath!, label: '休息提醒', after: true, requestId: state.requestId });
        return;
      }
      const next = await browserRequest<{ episodeId: string | null }>(`/api/episodes/${episode}/next`);
      if (closed.current) return;
      if (next.episodeId) { closed.current = true; playNext(next.episodeId); }
      else finish();
    } catch (failure) {
      if (closed.current) return;
      const status = (failure as { status?: number }).status;
      if (status === 401 || status === 403 || status === 404) finish();
      else { setNextError(true); setError('下一集加载失败，请重试或返回视频列表'); }
    } finally {
      if (!closed.current) { advancing.current = false; setNextPending(false); }
    }
  };
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!session.current) {
        const watch = await browserRequest<{ sessionId: string }>('/api/playback/sessions', 'POST', { episodeId: episode });
        session.current = watch.sessionId; start.current = performance.now(); last.current = 0;
        const resume = await browserRequest<{ positionMs: number; completed: boolean }>(`/api/episodes/${episode}/progress`);
        if (!fromStart && !resume.completed) position.current = resume.positionMs / 1000;
      }
      const query = new URLSearchParams({ sessionId: session.current });
      if (info?.mediaId) query.set('mediaId', info.mediaId);
      const source = await browserRequest<Playback>(`/api/episodes/${episode}/playback?${query}`);
      const state = await readReminder();
      if (alive && !closed.current) { showWarning(state); setInfo(source); setError(''); }
    };
    void load().catch((e) => { if (alive) setError(e.status === 403 ? '最后一集已经安排或看完了，请家长在后台恢复播放' : e.message); });
    return () => { alive = false; };
  }, [episode, serial]);
  useEffect(() => {
    const oldBack = window.mollyBack;
    window.mollyBack = () => { if (menuOpen.current) showMenu(false); else finish(); return true; };
    const key = (event: KeyboardEvent) => {
      if (activeClip.current) return;
      if (event.key === 'ContextMenu' || event.key === 'Menu' || event.keyCode === 93) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat) showMenu(!menuOpen.current);
        return;
      }
      if (['Escape', 'Backspace', 'BrowserBack'].includes(event.key) || [461, 10009].includes(event.keyCode)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (menuOpen.current) showMenu(false); else finish();
        return;
      }
      if (menuOpen.current) {
        event.stopImmediatePropagation();
        if (event.key.startsWith('Arrow')) {
          event.preventDefault();
          const buttons = Array.from(menuPanel.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const direction = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1;
          buttons[(index + direction + buttons.length) % buttons.length]?.focus();
        } else if (event.key === 'Enter') {
          event.preventDefault(); if (!event.repeat) (document.activeElement as HTMLButtonElement)?.click();
        }
        return;
      }
      if (event.key.startsWith('Arrow')) {
        event.stopImmediatePropagation();
        if (event.key === 'ArrowUp') { event.preventDefault(); document.querySelector<HTMLButtonElement>('.player-close')?.focus(); }
        else if (document.activeElement?.tagName === 'BUTTON') {
          event.preventDefault();
          if (event.key === 'ArrowDown') (retryButton.current || video.current)?.focus();
          else (document.activeElement === menuButton.current ? document.querySelector<HTMLButtonElement>('.player-close') : menuButton.current)?.focus();
        }
      }
      if (event.key === 'Enter' && document.activeElement?.tagName === 'BUTTON') {
        event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) (document.activeElement as HTMLButtonElement).click();
      }
    };
    let checking = false;
    const reminderTimer = setInterval(() => {
      if (checking || closed.current || advancing.current) return;
      checking = true;
      void readReminder().then(showWarning).catch((failure) => {
        if ([401, 403].includes(failure.status)) finish();
      }).finally(() => { checking = false; });
    }, 2000);
    const timer = setInterval(() => {
      sample();
      void browserRequest('/api/me').catch((e) => { if (e.status === 401 || e.status === 403) finish(); });
    }, 15000);
    window.addEventListener('keydown', key, true);
    return () => { closed.current = true; sample(true); window.mollyBack = oldBack; clearInterval(timer); clearInterval(reminderTimer); window.removeEventListener('keydown', key, true); };
  }, []);
  return <div role="dialog" aria-label="视频播放" style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#000', display: 'grid', placeItems: 'center' }}>
    {info && <video key={serial} ref={video} src={browserMediaUrl(info.url)} controls autoPlay={!clip} crossOrigin="anonymous" style={{ width: '100%', height: '100%' }}
      onLoadedMetadata={() => { if (video.current) { video.current.currentTime = position.current; video.current.playbackRate = selectedSpeed.current; } applySubtitle(); }}
      onPlaying={() => { if (activeClip.current) { video.current?.pause(); return; } sample(); playing.current = true; }} onPause={() => { sample(); playing.current = false; }}
      onWaiting={() => { sample(); playing.current = false; }} onSeeking={() => { completed.current = false; }} onTimeUpdate={() => { position.current = video.current?.currentTime ?? position.current; }}
      onEnded={() => { completed.current = true; void advance(); }}
      onError={() => {
        if (advancing.current || nextError) return;
        sample(); playing.current = false;
        if (info.mime === 'video/mp4' && !video.current?.canPlayType('video/mp4; codecs="avc1.42E01E"')) {
          setError('浏览器不支持此视频编码，请使用电视客户端播放');
        } else if (retries.current++ < 2) setSerial((v) => v + 1);
        else setError('无法播放，请返回重试');
      }}>
      {info.subtitles.map((sub) => <track key={sub.index} kind="subtitles" src={browserMediaUrl(sub.url)} srcLang={sub.language} label={sub.label} default={sub.isDefault} onLoad={applySubtitle} />)}
    </video>}
    {clip && <ParentClip key={clip.requestId + String(clip.after)} path={clip.path} label={clip.label} done={() => { void clipDone(); }} close={finish} />}
    <button ref={menuButton} className="player-menu-trigger" onClick={() => showMenu(!menuOpen.current)}>播放设置 · 菜单键</button>
    <button className="player-close" onClick={finish} style={{ position: 'absolute', top: 20, right: 20 }}>返回视频列表</button>
    {menu && <div ref={menuPanel} className="player-menu" role="dialog" aria-label="播放设置">
      <h2>播放设置</h2><p>仅影响当前视频</p>
      <h3>字幕</h3>
      <button aria-pressed={subtitle === null} onClick={() => { selectedSubtitle.current = null; setSubtitle(null); applySubtitle(); }}>关闭字幕</button>
      {info?.subtitles.map((sub) => <button key={sub.index} aria-pressed={subtitle === sub.index} onClick={() => { selectedSubtitle.current = sub.index; setSubtitle(sub.index); applySubtitle(); }}>{({ zh: '中文', en: '英文', 'zh-en': '中英文' } as Record<string, string>)[sub.language] || sub.language} · {sub.label}</button>)}
      {!info?.subtitles.length && <p>此视频没有可用字幕</p>}
      <h3>播放速度</h3>
      <div className="player-speeds">{[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => <button key={rate} aria-pressed={speed === rate} onClick={() => { selectedSpeed.current = rate; setSpeed(rate); if (video.current) video.current.playbackRate = rate; }}>{rate}×</button>)}</div>
      <button onClick={() => showMenu(false)}>返回播放</button>
    </div>}
    {nextPending && <p role="status" style={{ position: 'absolute', color: '#fff' }}>正在准备下一集…</p>}
    {nextError && <button ref={retryButton} className="player-next-retry" onClick={() => { void advance(); }} style={{ position: 'absolute', bottom: 80 }}>重试下一集</button>}
    {error && <p role="alert" style={{ position: 'absolute', color: '#fff' }}>{error}</p>}
  </div>;
}
