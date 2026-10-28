import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { FocusContext, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { imageSource, imagePreview, type Episode, type Series } from './api';
import { observeCoverPreview } from '../../../shared/cover-preview';
import { FocusButton, observeNavigation } from './focus';
import { VirtualGrid, VirtualRail } from './virtual-grid';

// One observer for the entire catalog, rather than one observer per cover.
const visibleCovers = new Map<Element, () => void>();
let coverObserver: IntersectionObserver | undefined;
function observeCover(node: Element, reveal: () => void) {
  coverObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) {
      visibleCovers.get(entry.target)?.();
      visibleCovers.delete(entry.target);
      coverObserver!.unobserve(entry.target);
    }
  }, { rootMargin: '160px' });
  visibleCovers.set(node, reveal);
  coverObserver.observe(node);
  return () => { visibleCovers.delete(node); coverObserver!.unobserve(node); };
}

export function LoadMore({ focusKey, loading, error, disabled, onLoad, onRetry, onFocus }: {
  focusKey: string; loading?: boolean; error?: string; disabled: boolean;
  onLoad: () => void; onRetry: () => void; onFocus: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || disabled || loading || error) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) onLoad(); },
      { root: ref.current.closest('.shelves-scroll'), rootMargin: '240px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [disabled, loading, error, onLoad]);
  return <div ref={ref} className="load-more">
    {error && <p role="alert">{error}</p>}
    <FocusButton focusKey={focusKey} className="text-button" disabled={disabled} onFocus={() => { onFocus(); if (!error) onLoad(); }} onClick={onRetry}>
      {loading ? '正在加载更多…' : error ? '重试加载' : '加载更多'}
    </FocusButton>
  </div>;
}

export function Icon({ name }: { name: 'home' | 'people' | 'settings' | 'back' | 'play' | 'check' | 'menu' }) {
  const paths = {
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    home: <><path d="m3 10 9-7 9 7v10H3Z" /><path d="M9 20v-7h6v7" /></>,
    people: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M19 15a5 5 0 0 1 2 5" /></>,
    settings: <><path d="M19.727 9.929L21.877 10.436L21.877 13.564L19.727 14.071L18.928 16.000L20.090 17.878L17.878 20.090L16.000 18.928L14.071 19.727L13.564 21.877L10.436 21.877L9.929 19.727L8.000 18.928L6.122 20.090L3.910 17.878L5.072 16.000L4.273 14.071L2.123 13.564L2.123 10.436L4.273 9.929L5.072 8.000L3.910 6.122L6.122 3.910L8.000 5.072L9.929 4.273L10.436 2.123L13.564 2.123L14.071 4.273L16.000 5.072L17.878 3.910L20.090 6.122L18.928 8.000Z" /><circle cx="12" cy="12" r="3" /></>,
    back: <path d="m12 5-7 7 7 7M5 12h14" />,
    play: <path d="m8 4 12 8-12 8Z" />,
    check: <path d="m5 12 4 4 10-10" />,
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const tones = ['#526b80', '#85735e', '#5b7772', '#756782', '#7e6269'];
export function tone(id: string) { return tones[Array.from(id).reduce((sum, c) => sum + c.charCodeAt(0), 0) % tones.length]; }

export const Cover = memo(function Cover({ item, large = false, folder = false, children }: { item: Series | Episode; large?: boolean; folder?: boolean; children?: ReactNode }) {
  const imagePath = item.image?.url ?? '';
  const directUrl = item.image?.directUrl;
  const [loaded, setLoaded] = useState({ path: '', src: '' });
  const src = loaded.path === imagePath ? loaded.src : '';
  const [visible, setVisible] = useState(large);
  const loadedUrl = useRef('');
  useEffect(() => () => { if (loadedUrl.current.startsWith('blob:')) URL.revokeObjectURL(loadedUrl.current); }, []);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const image = ref.current?.querySelector('img'), host = ref.current?.closest('button');
    if (!image || !host || !src || !item.image?.previewUrl) return;
    const path = item.image.previewUrl;
    return observeCoverPreview(host, image, signal => imagePreview(path, large ? 960 : 480, signal));
  }, [src, item.image?.previewUrl, large]);
  useEffect(() => {
    if (visible || !ref.current) return;
    return observeCover(ref.current, () => setVisible(true));
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
    else if (visible) {
      const load = (useDirect: boolean) => imageSource(imagePath, large ? 960 : 480, useDirect ? directUrl : undefined).then((url) => {
        pendingUrl = url;
        if (canceled) { if (url.startsWith('blob:')) URL.revokeObjectURL(url); return; }
        const image = new Image();
        image.onload = () => replace(url);
        image.onerror = () => {
          if (url.startsWith('blob:')) URL.revokeObjectURL(url);
          if (useDirect && url.startsWith('https://')) void load(false).catch(() => replace(''));
          else replace('');
        };
        image.src = url;
      });
      void load(!!directUrl).catch(() => replace(''));
    }
    return () => {
      canceled = true;
      if (pendingUrl.startsWith('blob:') && pendingUrl !== loadedUrl.current) URL.revokeObjectURL(pendingUrl);
    };
  }, [imagePath, directUrl, visible, large]);
  const position = 'positionMs' in item ? item.positionMs : undefined;
  const runtime = 'runtimeMs' in item ? item.runtimeMs : undefined;
  const progress = !large && position !== undefined && runtime !== undefined &&
    Number.isFinite(position) && Number.isFinite(runtime) && position > 0 && runtime > 0
    ? Math.min(100, Math.max(0, position / runtime * 100)) : undefined;
  return <div ref={ref} className={`cover ${large ? 'cover-large' : ''}`} style={{ '--cover-tone': tone(item.id) } as CSSProperties}>
    {src ? <img src={src} alt="" decoding="async" onError={event => { if (!event.currentTarget.dataset.preview) setLoaded({ path: imagePath, src: '' }); }} /> : <div className="cover-fallback" aria-hidden="true">
      <span className="cover-letter">{item.name.slice(0, 2)}</span><span className="cover-name">{item.name}</span>
    </div>}
    {folder && <span className="folder-badge">文件夹</span>}
    {item.offlineAvailable && <span className="offline-badge">可离线播放</span>}
    {children && <div className="cover-action">{children}</div>}
    {progress !== undefined && <div className="watch-progress" role="progressbar" aria-label="观看进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
      <span style={{ width: `${progress}%` }} />
    </div>}
  </div>;
});

// Keep catalog-wide loading/update state from re-rendering every cover and
// re-registering every focus callback. Only changed cards need React work.
export const CatalogCard = memo(function CatalogCard({ item, focusKey, disabled, firstRow, nearEnd, rowId,
  playable, subtitle, onActivate, onRemember, onLoad, onArrow }: {
  item: Series; focusKey: string; disabled: boolean; firstRow: boolean; nearEnd: boolean; rowId: string;
  playable: boolean; subtitle: string;
  onActivate: (item: Series) => void; onRemember: (key: string) => void;
  onLoad: (rowId: string) => void; onArrow: (direction: string, firstRow: boolean) => boolean;
}) {
  return <FocusButton focusKey={focusKey} className="poster" disabled={disabled}
    onArrow={(direction) => onArrow(direction, firstRow)}
    onFocus={() => { onRemember(focusKey); if (nearEnd) onLoad(rowId); }} onClick={() => onActivate(item)}>
    <div className="card-art"><Cover item={item} folder={!playable}>{playable && <><span>{subtitle}</span><Icon name="play" /></>}</Cover></div>
    <div className="card-copy"><strong>{item.name}</strong>{!playable && <span>{item.episodeCount === 0 ? '暂无视频' : item.episodeCount === undefined ? '' : `${item.episodeCount} 个视频`}</span>}</div>
  </FocusButton>;
});

export function Shelf({ focusKey, title, children, kind = '', virtualize = false, initialFocusKey }: {
  focusKey: string; title: string; children: ReactNode; kind?: string; virtualize?: boolean; initialFocusKey?: string;
}) {
  const { ref, hasFocusedChild } = useFocusable({ focusKey, saveLastFocusedChild: true, trackChildren: true });
  const grid = kind === 'episode-shelf' || kind === 'library-shelf';
  const rail = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = grid ? gridRef.current : rail.current;
    if (node) return observeNavigation(node);
  }, [grid]);
  const [directions, setDirections] = useState({ left: false, right: false, center: 0 });
  useEffect(() => {
    const node = rail.current;
    if (!node) return;
    let observedCover: HTMLElement | null = null;
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
      // Virtual rails replace offscreen cards. Never measure a detached cover
      // or keep listening to its size after it leaves the rendered window.
      const cover = node.querySelector<HTMLElement>('.cover');
      if (cover !== observedCover) {
        if (observedCover) observer.unobserve(observedCover);
        observedCover = cover;
        if (cover) observer.observe(cover);
      }
      center = (cover?.offsetHeight ?? 0) / 2;
      for (let element: HTMLElement | null = cover; element && element !== node.parentElement; element = element.offsetParent as HTMLElement | null) {
        center += element.offsetTop + ((element.offsetParent as HTMLElement | null)?.clientTop ?? 0);
      }
      maxScroll = Math.max(0, node.scrollWidth - node.clientWidth);
      updateDirections();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    measure();
    node.addEventListener('scroll', updateDirections, { passive: true });
    return () => { node.removeEventListener('scroll', updateDirections); observer.disconnect(); };
  }, [children, grid]);
  return <FocusContext.Provider value={focusKey}><section ref={ref} className={`shelf ${hasFocusedChild ? 'active-shelf' : ''} ${kind}`}>
    <div className="shelf-heading"><h2>{title}</h2></div>
    {grid ? virtualize ? <VirtualGrid focusKey={focusKey} initialFocusKey={initialFocusKey}>{children}</VirtualGrid> : <div ref={gridRef} className="episode-grid" data-grid={focusKey}>{children}</div> :
      <div className={`rail-shell ${directions.left ? 'fade-left' : ''} ${directions.right ? 'fade-right' : ''}`} style={{ '--rail-arrow-top': `${directions.center}px` } as CSSProperties}>
        <div ref={rail} className="rail-track" data-rail={focusKey}><>{virtualize ? <VirtualRail>{children}</VirtualRail> : <div className="rail-content">{children}</div>}</></div>
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

export function DetailHeader({ series, path = [], total, loading, onBack, onDown }: {
  series: Series; path?: Series[]; total?: number; loading: boolean; onBack: () => void; onDown: () => void;
}) {
  return <section className="detail-header" aria-label="文件夹详情">
    <div className="detail-navigation">
      <FocusButton focusKey="folder-back" className="folder-back" onClick={onBack}
        onArrow={direction => { if (direction === 'down') onDown(); return false; }}
        ariaLabel={`返回${path[path.length - 1]?.name ?? '媒体库'}`}><Icon name="back" /></FocusButton>
      <div className="detail-context">
        <p className="folder-path" aria-label="文件夹路径">我的媒体库{path.map(parent => <span key={parent.id}> / {parent.name}</span>)}</p>
        <h1>{series.name}</h1>
        <p className="detail-count">{loading ? '正在加载…' : total === undefined ? '目录暂未加载' : `${total} 个视频`}</p>
        {series.overview && <p className="detail-description">{series.overview}</p>}
      </div>
    </div>
    {series.image?.url && <div className="detail-art" aria-hidden="true"><Cover item={series} large /></div>}
  </section>;
}
