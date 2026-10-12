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
function BrowserPlayback({ episode, fromStart, playNext, close }: { episode: string; fromStart: boolean; playNext: (episodeId: string) => void; close: () => void }) {
  const [info, setInfo] = useState<Playback>(), [error, setError] = useState('');
  const completed = useRef(false), stopped = useRef(false), closed = useRef(false);
  const video = useRef<HTMLVideoElement>(null), session = useRef(''), position = useRef(0);
  const [serial, setSerial] = useState(0), [nextPending, setNextPending] = useState(false), [nextError, setNextError] = useState(false);
  const advancing = useRef(false), retryButton = useRef<HTMLButtonElement>(null);
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
      if (alive) { setInfo(source); setError(''); }
    };
    void load().catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [episode, serial]);
  useEffect(() => {
    const oldBack = window.mollyBack;
    window.mollyBack = () => { finish(); return true; };
    const key = (event: KeyboardEvent) => {
      if (event.key.startsWith('Arrow')) {
        event.stopImmediatePropagation();
        if (event.key === 'ArrowUp') { event.preventDefault(); document.querySelector<HTMLButtonElement>('.player-close')?.focus(); }
        else if (document.activeElement?.tagName === 'BUTTON') {
          event.preventDefault();
          if (event.key === 'ArrowDown') (retryButton.current || video.current)?.focus();
          else document.querySelector<HTMLButtonElement>('.player-close')?.focus();
        }
      }
      if (['Escape', 'Backspace'].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); finish(); } };
    const timer = setInterval(() => {
      sample();
      void browserRequest('/api/me').catch((e) => { if (e.status === 401 || e.status === 403) finish(); });
    }, 15000);
    window.addEventListener('keydown', key, true);
    return () => { closed.current = true; sample(true); window.mollyBack = oldBack; clearInterval(timer); window.removeEventListener('keydown', key, true); };
  }, []);
  return <div role="dialog" aria-label="视频播放" style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#000', display: 'grid', placeItems: 'center' }}>
    {info && <video key={serial} ref={video} src={browserMediaUrl(info.url)} controls autoPlay crossOrigin="anonymous" style={{ width: '100%', height: '100%' }}
      onLoadedMetadata={() => { if (video.current) video.current.currentTime = position.current; }}
      onPlaying={() => { sample(); playing.current = true; }} onPause={() => { sample(); playing.current = false; }}
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
      {info.subtitles.map((sub) => <track key={sub.index} kind="subtitles" src={browserMediaUrl(sub.url)} srcLang={sub.language} label={sub.label} default={sub.isDefault} />)}
    </video>}
    <button className="player-close" onClick={finish} style={{ position: 'absolute', top: 20, right: 20 }}>返回视频列表</button>
    {nextPending && <p role="status" style={{ position: 'absolute', color: '#fff' }}>正在准备下一集…</p>}
    {nextError && <button ref={retryButton} className="player-next-retry" onClick={() => { void advance(); }} style={{ position: 'absolute', bottom: 80 }}>重试下一集</button>}
    {error && <p role="alert" style={{ position: 'absolute', color: '#fff' }}>{error}</p>}
  </div>;
}
