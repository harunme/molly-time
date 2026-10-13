import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { FocusContext, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { imageSource, type Episode, type Series } from './api';

export function Icon({ name }: { name: 'home' | 'people' | 'settings' | 'back' | 'play' | 'check' | 'menu' }) {
  const paths = {
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    home: <><path d="m3 10 9-7 9 7v10H3Z" /><path d="M9 20v-7h6v7" /></>,
    people: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M19 15a5 5 0 0 1 2 5" /></>,
    settings: <><path d="M19.727 9.929L21.877 10.436L21.877 13.564L19.727 14.071L18.928 16.000L20.090 17.878L17.878 20.090L16.000 18.928L14.071 19.727L13.564 21.877L10.436 21.877L9.929 19.727L8.000 18.928L6.122 20.090L3.910 17.878L5.072 16.000L4.273 14.071L2.123 13.564L2.123 10.436L4.273 9.929L5.072 8.000L3.910 6.122L6.122 3.910L8.000 5.072L9.929 4.273L10.436 2.123L13.564 2.123L14.071 4.273L16.000 5.072L17.878 3.910L20.090 6.122L18.928 8.000Z" /><circle cx="12" cy="12" r="3" /></>,
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
  const grid = kind === 'episode-shelf' || kind === 'library-shelf';
  const rail = useRef<HTMLDivElement>(null);
  const [directions, setDirections] = useState({ left: false, right: false, center: 0 });
  useEffect(() => {
    const node = rail.current;
    if (!node) return;
    const cover = node.querySelector<HTMLElement>('.cover');
    let center = 0, maxScroll = 0;
    let previous: typeof directions | undefined;
    const updateDirections = () => {
      const left = node.scrollLeft > 2, right = node.scrollLeft < maxScroll - 2;
      if (previous?.left === left && previous.right === right && previous.center === center) return;
      previous = { left, right, center };
      setDirections(previous);
    };
    // Scroll frames only read the position. Measure fixed geometry on resize,
    // and render only when an arrow's availability or position actually changes.
    const measure = () => {
      center = (cover?.offsetHeight ?? 0) / 2;
      for (let element: HTMLElement | null = cover; element && element !== node.parentElement; element = element.offsetParent as HTMLElement | null) center += element.offsetTop;
      maxScroll = Math.max(0, node.scrollWidth - node.clientWidth);
      updateDirections();
    };
    measure();
    node.addEventListener('scroll', updateDirections, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (cover) observer.observe(cover);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => { node.removeEventListener('scroll', updateDirections); observer.disconnect(); };
  }, [children, grid]);
  return <FocusContext.Provider value={focusKey}><section ref={ref} className={`shelf ${hasFocusedChild ? 'active-shelf' : ''} ${kind}`}>
    <div className="shelf-heading"><h2>{title}</h2></div>
    {grid ? <div className="episode-grid" data-grid={focusKey}>{children}</div> :
      <div className={`rail-shell ${directions.left ? 'fade-left' : ''} ${directions.right ? 'fade-right' : ''}`} style={{ '--rail-arrow-top': `${directions.center}px` } as CSSProperties}>
        <div ref={rail} className="rail-track" data-rail={focusKey}><div className="rail-content">{children}</div></div>
        <span aria-hidden="true" className={`rail-direction rail-direction-left ${directions.left ? 'available' : ''}`}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 6-6 6 6 6" /></svg></span>
        <span aria-hidden="true" className={`rail-direction rail-direction-right ${directions.right ? 'available' : ''}`}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg></span>
      </div>}
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
