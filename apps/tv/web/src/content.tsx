import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { FocusContext, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { imageSource, type Episode, type Series } from './api';

export function Icon({ name }: { name: 'home' | 'people' | 'settings' | 'back' | 'play' | 'check' }) {
  const paths = {
    home: <><path d="m3 10 9-7 9 7v10H3Z" /><path d="M9 20v-7h6v7" /></>,
    people: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M19 15a5 5 0 0 1 2 5" /></>,
    settings: <><path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 3 3 3-1 1-3 3-1 2-3-2-2 1-3-2-3-3 1-3-3Z" /><circle cx="12" cy="12" r="3" /></>,
    back: <path d="m14 5-7 7 7 7M7 12h14" />,
    play: <path d="m8 4 12 8-12 8Z" />,
    check: <path d="m5 12 4 4 10-10" />,
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const tones = ['#7950d8', '#a383fa', '#603dc2', '#9065e9', '#b49afc'];
export function tone(id: string) { return tones[Array.from(id).reduce((sum, c) => sum + c.charCodeAt(0), 0) % tones.length]; }

export function Cover({ item, large = false }: { item: Series | Episode; large?: boolean }) {
  const [src, setSrc] = useState('');
  const [visible, setVisible] = useState(large);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (visible || !ref.current) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } }, { rootMargin: '160px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    let canceled = false, objectUrl = '';
    setSrc('');
    if (visible && item.image?.url) imageSource(item.image.url, large ? 960 : 480).then((url) => {
      objectUrl = url;
      if (canceled && url.startsWith('blob:')) URL.revokeObjectURL(url);
      else if (!canceled) setSrc(url);
    }).catch(() => {});
    return () => { canceled = true; if (objectUrl.startsWith('blob:')) URL.revokeObjectURL(objectUrl); };
  }, [item.image?.url, visible, large]);
  return <div ref={ref} className={`cover ${large ? 'cover-large' : ''}`} style={{ '--cover-tone': tone(item.id) } as CSSProperties}>
    {src ? <img src={src} alt="" decoding="async" onError={() => setSrc('')} /> : <div className="cover-fallback" aria-hidden="true">
      <span className="cover-letter">{item.name.slice(0, 2)}</span><span className="cover-name">{item.name}</span>
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

export function Feature({ item, eyebrow, description, meta, label, action, loading = false }: {
  item?: Series | Episode; eyebrow: string; description: string; meta: string; label: string; action: string; loading?: boolean;
}) {
  return <section className="feature" aria-label="选中内容预览">
    <div className="feature-copy" key={`${item?.id}-${loading}`}><p className="eyebrow">{eyebrow}</p>
      <h1>{loading ? '正在打开媒体库…' : item?.name ?? '家庭放映室'}</h1>
      {meta && !loading && <p className="feature-meta"><span className="media-tag">{label}</span>{meta}</p>}
      <p className="feature-description">{loading ? '稍等一下，故事就来了。' : description}</p>
      {item && !loading && <div className="feature-action"><span className="keycap">确定</span><span>{action}</span><Icon name="play" /></div>}
    </div>
    <div className="feature-art">{item && <Cover item={item} large />}<span className="art-caption">MollyTime · 家庭放映室</span></div>
  </section>;
}
