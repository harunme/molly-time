import { useEffect, useRef, useState } from 'react';
import { browserMediaUrl, browserRequest } from './api';

type Playback = { mediaId: string; url: string; mime: string; subtitles: { index: number; url: string; language: string; label: string; isDefault: boolean }[] };
export function BrowserPlaybackHost() {
  const [target, setTarget] = useState<{ episodeId: string }>();
  useEffect(() => {
    const open = (event: Event) => setTarget((event as CustomEvent).detail);
    window.addEventListener('molly:browserPlay', open);
    return () => window.removeEventListener('molly:browserPlay', open);
  }, []);
  const close = () => { setTarget(undefined); window.dispatchEvent(new CustomEvent('molly:playbackClosed', { detail: { episodeId: target?.episodeId } })); };
  return target ? <BrowserPlayback key={target.episodeId} episode={target.episodeId} close={close} /> : null;
}
function BrowserPlayback({ episode, close }: { episode: string; close: () => void }) {
  const [info, setInfo] = useState<Playback>(), [error, setError] = useState('');
  const completed = useRef(false), stopped = useRef(false), closed = useRef(false);
  const video = useRef<HTMLVideoElement>(null), session = useRef(''), position = useRef(0);
  const [serial, setSerial] = useState(0);
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
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!session.current) {
        const watch = await browserRequest<{ sessionId: string }>('/api/playback/sessions', 'POST', { episodeId: episode });
        session.current = watch.sessionId; start.current = performance.now(); last.current = 0;
        const resume = await browserRequest<{ positionMs: number; completed: boolean }>(`/api/episodes/${episode}/progress`);
        if (!resume.completed) position.current = resume.positionMs / 1000;
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
          if (event.key === 'ArrowDown') video.current?.focus();
          else document.querySelector<HTMLButtonElement>('.player-close')?.focus();
        }
      }
      if (['Escape', 'Backspace'].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); finish(); } };
    const timer = setInterval(() => {
      sample();
      void browserRequest('/api/me').catch((e) => { if (e.status === 401 || e.status === 403) finish(); });
    }, 15000);
    window.addEventListener('keydown', key, true);
    return () => { sample(true); window.mollyBack = oldBack; clearInterval(timer); window.removeEventListener('keydown', key, true); };
  }, []);
  return <div role="dialog" aria-label="视频播放" style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#000', display: 'grid', placeItems: 'center' }}>
    {info && <video key={serial} ref={video} src={browserMediaUrl(info.url)} controls autoPlay crossOrigin="anonymous" style={{ width: '100%', height: '100%' }}
      onLoadedMetadata={() => { if (video.current) video.current.currentTime = position.current; }}
      onPlaying={() => { sample(); playing.current = true; }} onPause={() => { sample(); playing.current = false; }}
      onWaiting={() => { sample(); playing.current = false; }} onSeeking={() => { completed.current = false; }} onTimeUpdate={() => { position.current = video.current?.currentTime ?? position.current; }}
      onEnded={() => { completed.current = true; sample(); playing.current = false; finish(); }}
      onError={() => {
        sample(); playing.current = false;
        if (info.mime === 'video/mp4' && !video.current?.canPlayType('video/mp4; codecs="avc1.42E01E"')) {
          setError('浏览器不支持此视频编码，请使用电视客户端播放');
        } else if (retries.current++ < 2) setSerial((v) => v + 1);
        else setError('无法播放，请返回重试');
      }}>
      {info.subtitles.map((sub) => <track key={sub.index} kind="subtitles" src={browserMediaUrl(sub.url)} srcLang={sub.language} label={sub.label} default={sub.isDefault} />)}
    </video>}
    <button className="player-close" onClick={finish} style={{ position: 'absolute', top: 20, right: 20 }}>返回视频列表</button>
    {error && <p role="alert" style={{ position: 'absolute', color: '#fff' }}>{error}</p>}
  </div>;
}
