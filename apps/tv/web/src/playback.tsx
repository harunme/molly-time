import { useEffect, useRef, useState } from 'react';
import { browserMediaUrl, browserRequest } from './api';

type Playback = { mediaId: string; url: string; mime: string; subtitles: { index: number; url: string; language: string; label: string; isDefault: boolean }[] };
export function BrowserPlaybackHost() {
  const [episode, setEpisode] = useState('');
  useEffect(() => {
    const open = (event: Event) => setEpisode((event as CustomEvent<string>).detail);
    window.addEventListener('molly:browserPlay', open);
    return () => window.removeEventListener('molly:browserPlay', open);
  }, []);
  const close = () => { setEpisode(''); window.dispatchEvent(new Event('molly:playbackClosed')); };
  return episode ? <BrowserPlayback key={episode} episode={episode} close={close} /> : null;
}
function BrowserPlayback({ episode, close }: { episode: string; close: () => void }) {
  const [info, setInfo] = useState<Playback>(), [error, setError] = useState('');
  const video = useRef<HTMLVideoElement>(null), session = useRef(''), position = useRef(0);
  const [serial, setSerial] = useState(0);
  const seq = useRef(0), start = useRef(performance.now()), last = useRef(0), playing = useRef(false), retries = useRef(0);
  const chain = useRef(Promise.resolve());
  const sample = (stopped = false) => {
    if (!session.current) return;
    const end = Math.round(performance.now() - start.current), begin = last.current;
    position.current = video.current?.currentTime || position.current;
    last.current = end;
    // Split intervals after background throttling; server accepts at most 60 seconds.
    for (let a = begin; a < end || (stopped && a === end); a += 60000) {
      const b = Math.min(a + 60000, end), final = b === end;
      const body = { seq: seq.current++, startMs: a, endMs: b, playedMs: playing.current && !document.hidden ? b - a : 0,
        positionMs: Math.round(position.current * 1000), completed: !!video.current?.ended, stopped: stopped && final };
      const id = session.current;
      chain.current = chain.current.then(() => browserRequest(`/api/playback/sessions/${id}/events`, 'POST', body).then(() => {})).catch(() => {});
      if (final) break;
    }
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
    window.mollyBack = () => { close(); return true; };
    const key = (event: KeyboardEvent) => { if (['Escape', 'Backspace'].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); close(); } };
    const timer = setInterval(() => {
      sample();
      void browserRequest('/api/me').catch((e) => { if (e.status === 401 || e.status === 403) close(); });
    }, 15000);
    window.addEventListener('keydown', key, true);
    return () => { sample(true); window.mollyBack = oldBack; clearInterval(timer); window.removeEventListener('keydown', key, true); };
  }, []);
  return <div role="dialog" aria-label="视频播放" style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#000', display: 'grid', placeItems: 'center' }}>
    {info && <video key={serial} ref={video} src={browserMediaUrl(info.url)} controls autoPlay crossOrigin="anonymous" style={{ width: '100%', height: '100%' }}
      onLoadedMetadata={() => { if (video.current) video.current.currentTime = position.current; }}
      onPlaying={() => { sample(); playing.current = true; }} onPause={() => { sample(); playing.current = false; }}
      onWaiting={() => { sample(); playing.current = false; }} onEnded={close}
      onError={() => {
        sample(); playing.current = false;
        if (info.mime === 'video/mp4' && !video.current?.canPlayType('video/mp4; codecs="avc1.42E01E"')) {
          setError('浏览器不支持此视频编码，请使用电视客户端播放');
        } else if (retries.current++ < 2) setSerial((v) => v + 1);
        else setError('无法播放，请返回重试');
      }}>
      {info.subtitles.map((sub) => <track key={sub.index} kind="subtitles" src={browserMediaUrl(sub.url)} srcLang={sub.language} label={sub.label} default={sub.isDefault} />)}
    </video>}
    <button onClick={close} style={{ position: 'absolute', top: 20, right: 20 }}>返回媒体库</button>
    {error && <p role="alert" style={{ position: 'absolute', color: '#fff' }}>{error}</p>}
  </div>;
}
