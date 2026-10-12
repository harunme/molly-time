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

export function Cover({ item, large = false }: { item: Series | Episode; large?: boolean }) {
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
    {progress !== undefined && <div className="watch-progress" role="progressbar" aria-label="观看进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
      <span style={{ width: `${progress}%` }} />
    </div>}
  </div>;
}

export function Shelf({ focusKey, title, total, position, children, kind = '' }: {
  focusKey: string; title: string; total: number; position?: number; children: ReactNode; kind?: string;
}) {
  const { ref, hasFocusedChild } = useFocusable({ focusKey, saveLastFocusedChild: true, trackChildren: true });
  return <FocusContext.Provider value={focusKey}><section ref={ref} className={`shelf ${hasFocusedChild ? 'active-shelf' : ''} ${kind}`}>
    <div className="shelf-heading"><h2>{title}</h2><span className="row-position">{hasFocusedChild && position ? `${position} / ${total}` : `${total} ${kind === 'season-shelf' ? '季' : kind === 'episode-shelf' ? '集' : '部'}`}</span></div>
    <div className="rail-track" data-rail={focusKey}><div className="rail-content">{children}</div></div>
  </section></FocusContext.Provider>;
}

export function Feature({ item, eyebrow, description, meta, label, loading = false }: {
  item?: Series | Episode; eyebrow: string; description: string; meta: string; label: string; loading?: boolean;
}) {
  const [settled, setSettled] = useState({ item, eyebrow, description, meta, label });
  useEffect(() => {
    const timer = setTimeout(() => setSettled({ item, eyebrow, description, meta, label }), 150);
    return () => clearTimeout(timer);
  }, [item, eyebrow, description, meta, label, loading]);
  const shown = !item?.image?.url || loading ? { item, eyebrow, description, meta, label } : settled;
  return <section className="feature" aria-label="选中内容预览">
    <div className="feature-art" aria-hidden="true">{shown.item && <Cover item={shown.item} large />}</div>
    <div className="feature-copy">{shown.eyebrow && <p className="eyebrow">{shown.eyebrow}</p>}
      <h1>{loading ? '正在打开媒体库…' : shown.item?.name ?? '媒体库'}</h1>
      {shown.meta && !loading && <p className="feature-meta"><span className="media-tag">{shown.label}</span>{shown.meta}</p>}
      <p className="feature-description">{loading ? '' : shown.description}</p>
    </div>
  </section>;
}


export function DetailHeader({ series, title, total, kind, selected, meta, loading }: {
  series: Series; title: string; total: number; kind: 'series' | 'season';
  selected?: Series | Episode; meta: string; loading: boolean;
}) {
  return <section className="detail-header" aria-label="片单详情">
    <div className="detail-context">
      <p className="eyebrow">{kind === 'series' ? '系列' : series.name}</p>
      <h1>{title}</h1>
      <p className="detail-count">{loading ? '正在加载…' : `${total} ${kind === 'series' ? '季' : '集'}`}</p>
      {!loading && selected && <div className="detail-selection">
        <span>{kind === 'series' ? '当前选中' : '当前剧集'}</span>
        <strong>{selected.name}</strong>{meta && <small>{meta}</small>}
      </div>}
    </div>
    <div className="detail-cover" aria-hidden="true"><Cover item={series} /></div>
  </section>;
}
