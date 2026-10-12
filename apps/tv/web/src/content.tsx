import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { FocusContext, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { imageSource, type Episode, type Series } from './api';

export function Icon({ name }: { name: 'home' | 'people' | 'settings' | 'back' | 'play' | 'check' | 'menu' }) {
  const paths = {
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    home: <><path d="m3 10 9-7 9 7v10H3Z" /><path d="M9 20v-7h6v7" /></>,
    people: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M19 15a5 5 0 0 1 2 5" /></>,
    settings: <><path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 3 3 3-1 1-3 3-1 2-3-2-2 1-3-2-3-3 1-3-3Z" /><circle cx="12" cy="12" r="3" /></>,
    back: <path d="m14 5-7 7 7 7M7 12h14" />,
    play: <path d="m8 4 12 8-12 8Z" />,
    check: <path d="m5 12 4 4 10-10" />,
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const tones = ['#526b80', '#85735e', '#5b7772', '#756782', '#7e6269'];
export function tone(id: string) { return tones[Array.from(id).reduce((sum, c) => sum + c.charCodeAt(0), 0) % tones.length]; }

export function Cover({ item, large = false, children }: { item: Series | Episode; large?: boolean; children?: ReactNode }) {
  const imagePath = item.image?.url ?? '';
  const [loaded, setLoaded] = useState({ path: '', src: '' });
  const src = loaded.path === imagePath ? loaded.src : '';
  const [visible, setVisible] = useState(large);
  const loadedUrl = useRef('');
  useEffect(() => () => { if (loadedUrl.current.startsWith('blob:')) URL.revokeObjectURL(loadedUrl.current); }, []);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (visible || !ref.current) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } }, { rootMargin: '160px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    let canceled = false, pendingUrl = '';
    const replace = (url: string) => {
      if (canceled) return;
      const previous = loadedUrl.current;
      loadedUrl.current = url;
      setLoaded({ path: imagePath, src: url });
      if (previous.startsWith('blob:') && previous !== url) URL.revokeObjectURL(previous);
    };
    if (!item.image?.url) replace('');
    else if (visible) imageSource(item.image.url, large ? 960 : 480).then((url) => {
      pendingUrl = url;
      if (canceled) { if (url.startsWith('blob:')) URL.revokeObjectURL(url); return; }
      const image = new Image();
      image.onload = () => replace(url);
      image.onerror = () => { replace(''); if (url.startsWith('blob:')) URL.revokeObjectURL(url); };
      image.src = url;
    }).catch(() => replace(''));
    return () => {
      canceled = true;
      if (pendingUrl.startsWith('blob:') && pendingUrl !== loadedUrl.current) URL.revokeObjectURL(pendingUrl);
    };
  }, [imagePath, visible, large]);
  const position = 'positionMs' in item ? item.positionMs : undefined;
  const runtime = 'runtimeMs' in item ? item.runtimeMs : undefined;
  const progress = !large && position !== undefined && runtime !== undefined &&
    Number.isFinite(position) && Number.isFinite(runtime) && position > 0 && runtime > 0
    ? Math.min(100, Math.max(0, position / runtime * 100)) : undefined;
  return <div ref={ref} className={`cover ${large ? 'cover-large' : ''}`} style={{ '--cover-tone': tone(item.id) } as CSSProperties}>
    {src ? <img src={src} alt="" decoding="async" onError={() => setLoaded({ path: imagePath, src: '' })} /> : <div className="cover-fallback" aria-hidden="true">
      <span className="cover-letter">{item.name.slice(0, 2)}</span><span className="cover-name">{item.name}</span>
    </div>}
    {children && <div className="cover-action">{children}</div>}
    {progress !== undefined && <div className="watch-progress" role="progressbar" aria-label="观看进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
      <span style={{ width: `${progress}%` }} />
    </div>}
  </div>;
}

export function Shelf({ focusKey, title, children, kind = '' }: {
  focusKey: string; title: string; children: ReactNode; kind?: string;
}) {
  const { ref, hasFocusedChild } = useFocusable({ focusKey, saveLastFocusedChild: true, trackChildren: true });
  return <FocusContext.Provider value={focusKey}><section ref={ref} className={`shelf ${hasFocusedChild ? 'active-shelf' : ''} ${kind}`}>
    <div className="shelf-heading"><h2>{title}</h2></div>
    <div className="rail-track" data-rail={focusKey}><div className="rail-content">{children}</div></div>
  </section></FocusContext.Provider>;
}

export function HomeGreeting({ name }: { name?: string }) {
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const update = () => setHour(new Date().getHours());
    const timer = setInterval(update, 60000);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, []);
  const greeting = hour >= 5 && hour < 12 ? '早上好' : hour >= 12 && hour < 18 ? '下午好' : '晚上好';
  return <section className="home-greeting" aria-label="首页问候">
    <h1>{greeting}{name ? `，${name}` : ''}</h1>
    <p>，一起看个喜欢的故事吧。</p>
  </section>;
}

export function DetailHeader({ series, total, loading }: {
  series: Series; total: number; loading: boolean;
}) {
  return <section className="detail-header" aria-label="文件夹详情">
    <div className="detail-context">
      <p className="eyebrow">我的媒体库</p>
      <h1>{series.name}</h1>
      <p className="detail-count">{loading ? '正在加载…' : `${total} 个视频`}</p>
      {series.overview && <p className="detail-description">{series.overview}</p>}
    </div>
    {series.image?.url && <div className="detail-art" aria-hidden="true"><Cover item={series} large /></div>}
  </section>;
}
