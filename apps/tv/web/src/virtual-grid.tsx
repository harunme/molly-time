import { Children, isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getCurrentFocusKey, setFocus } from '@noriginmedia/norigin-spatial-navigation';

/** Logical navigation includes unmounted cards; stable spacers preserve scroll and focus snapshots. */
export function VirtualGrid({ children, focusKey, initialFocusKey }: { children: ReactNode; focusKey: string; initialFocusKey?: string }) {
  const items = Children.toArray(children);
  const keys = useMemo(() => items.map((child) => isValidElement<{ focusKey?: string }>(child) ? child.props.focusKey : undefined), [children]);
  const node = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({ columns: 4, stride: 280, gap: 27, start: 0, end: 7 });
  const initial = Math.max(0, keys.indexOf(initialFocusKey ?? getCurrentFocusKey()));
  const [active, setActive] = useState(initial), [target, setTarget] = useState(initial);
  const pending = useRef<number | undefined>(undefined), focusFrame = useRef(0);
  useLayoutEffect(() => {
    const grid = node.current!, viewport = grid.closest<HTMLElement>('.shelves-scroll')!;
    let frame = 0;
    const measure = () => {
      const columns = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);
      const gap = parseFloat(getComputedStyle(grid).rowGap) || 0;
      const card = grid.querySelector<HTMLElement>('.poster');
      const stride = (card?.offsetHeight || 250) + gap;
      let top = 0;
      for (let element: HTMLElement | null = grid; element && element !== viewport; element = element.offsetParent as HTMLElement | null) top += element.offsetTop;
      const start = Math.max(0, Math.floor((viewport.scrollTop - top) / stride) - 2);
      const end = Math.max(0, Math.ceil((viewport.scrollTop + viewport.clientHeight - top) / stride) + 2);
      setGeometry((old) => old.columns === columns && old.stride === stride && old.gap === gap && old.start === start && old.end === end ? old : { columns, stride, gap, start, end });
    };
    const scroll = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(grid);
    const card = grid.querySelector<HTMLElement>('.poster'); if (card) observer.observe(card);
    viewport.addEventListener('scroll', scroll, { passive: true });
    return () => { observer.disconnect(); viewport.removeEventListener('scroll', scroll); cancelAnimationFrame(frame); };
  }, [items.length]);
  useEffect(() => () => cancelAnimationFrame(focusFrame.current), []);
  const { columns, stride, gap, start, end } = geometry;
  const totalRows = Math.ceil(items.length / columns);
  const rows = new Set<number>();
  for (let row = start; row <= Math.min(totalRows - 1, end); row++) rows.add(row);
  rows.add(Math.floor(active / columns)); rows.add(Math.floor(target / columns));
  const rendered: ReactNode[] = [];
  let previous = -1;
  for (const row of [...rows].filter((row) => row < totalRows).sort((a, b) => a - b)) {
    if (row > previous + 1) rendered.push(<div key={`space-${previous + 1}`} aria-hidden="true" style={{ gridColumn: '1 / -1', height: (row - previous - 1) * stride - gap }} />);
    for (let index = row * columns; index < Math.min(items.length, (row + 1) * columns); index++) rendered.push(items[index]);
    previous = row;
  }
  if (previous < totalRows - 1) rendered.push(<div key="space-end" aria-hidden="true" style={{ gridColumn: '1 / -1', height: (totalRows - previous - 1) * stride - gap }} />);
  return <div ref={node} className="episode-grid virtual-grid" data-grid={focusKey} data-total-items={items.length}
    data-first-row-keys={JSON.stringify(keys.slice(0, columns))}
    onFocusCapture={(event) => {
      const key = (event.target as HTMLElement).closest<HTMLElement>('button[data-focus]')?.dataset.focus;
      const index = keys.indexOf(key);
      if (index >= 0) { setActive(index); if (pending.current === index) pending.current = undefined; }
    }}
    onKeyDownCapture={(event) => {
      if (!event.key.startsWith('Arrow')) return;
      const current = pending.current ?? keys.indexOf(getCurrentFocusKey());
      if (current < 0) return;
      let next = current;
      if (event.key === 'ArrowUp' && current < columns) return;
      if (event.key === 'ArrowUp') next -= columns;
      if (event.key === 'ArrowDown' && (Math.floor(current / columns) + 1) * columns < items.length) next = Math.min(current + columns, items.length - 1);
      if (event.key === 'ArrowLeft' && current % columns > 0) next--;
      if (event.key === 'ArrowRight' && current % columns < columns - 1 && current + 1 < items.length) next++;
      event.preventDefault(); event.stopPropagation();
      if (next !== current && keys[next]) {
        pending.current = next; setTarget(next);
        cancelAnimationFrame(focusFrame.current);
        focusFrame.current = requestAnimationFrame(() => setFocus(keys[next]!));
      }
    }}>{rendered}</div>;
}

export function VirtualRail({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  const keys = useMemo(() => items.map((child) => isValidElement<{ focusKey?: string }>(child) ? child.props.focusKey : undefined), [children]);
  const node = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({ stride: 375, gap: 27, start: 0, end: 8 });
  const [active, setActive] = useState(Math.max(0, keys.indexOf(getCurrentFocusKey())));
  const [target, setTarget] = useState(active);
  const pending = useRef<number | undefined>(undefined), focusFrame = useRef(0);
  useLayoutEffect(() => {
    const rail = node.current!, viewport = rail.closest<HTMLElement>('.rail-track')!;
    let frame = 0;
    const measure = () => {
      const gap = parseFloat(getComputedStyle(rail).columnGap) || 0;
      const stride = (rail.querySelector<HTMLElement>('.poster')?.offsetWidth || 348) + gap;
      const start = Math.max(0, Math.floor(viewport.scrollLeft / stride) - 2);
      const end = Math.ceil((viewport.scrollLeft + viewport.clientWidth) / stride) + 2;
      setGeometry((old) => old.stride === stride && old.gap === gap && old.start === start && old.end === end ? old : { stride, gap, start, end });
    };
    const scroll = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    const observer = new ResizeObserver(measure); observer.observe(viewport);
    measure(); viewport.addEventListener('scroll', scroll, { passive: true });
    return () => { observer.disconnect(); viewport.removeEventListener('scroll', scroll); cancelAnimationFrame(frame); };
  }, [items.length]);
  useEffect(() => () => cancelAnimationFrame(focusFrame.current), []);
  const indexes = new Set<number>([active, target]);
  for (let i = geometry.start; i <= Math.min(items.length - 1, geometry.end); i++) indexes.add(i);
  const rendered: ReactNode[] = []; let previous = -1;
  for (const index of [...indexes].filter((i) => i < items.length).sort((a, b) => a - b)) {
    if (index > previous + 1) rendered.push(<div key={`space-${previous}`} aria-hidden="true" style={{ flex: `0 0 ${(index - previous - 1) * geometry.stride - geometry.gap}px` }} />);
    rendered.push(items[index]); previous = index;
  }
  if (previous < items.length - 1) rendered.push(<div key="space-end" aria-hidden="true" style={{ flex: `0 0 ${(items.length - previous - 1) * geometry.stride - geometry.gap}px` }} />);
  return <div ref={node} className="rail-content virtual-rail" data-total-items={items.length}
    onFocusCapture={(event) => {
      const index = keys.indexOf((event.target as HTMLElement).closest<HTMLElement>('button[data-focus]')?.dataset.focus);
      if (index >= 0) { setActive(index); if (pending.current === index) pending.current = undefined; }
    }} onKeyDownCapture={(event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const current = pending.current ?? keys.indexOf(getCurrentFocusKey());
      if (current < 0) return;
      event.preventDefault(); event.stopPropagation();
      const next = Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowLeft' ? -1 : 1)));
      if (next !== current && keys[next]) {
        pending.current = next; setTarget(next); cancelAnimationFrame(focusFrame.current);
        focusFrame.current = requestAnimationFrame(() => setFocus(keys[next]!));
      }
    }}>{rendered}</div>;
}
