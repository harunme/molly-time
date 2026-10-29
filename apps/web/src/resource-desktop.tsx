import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronRight, FileVideo, FolderOpen, X } from 'lucide-react';
import type { Resource } from './api';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from './components/ui/dialog';
import { Button } from './components/ui/button';
import { Skeleton } from './components/ui/skeleton';
import './styles/resource-desktop.css';

type Drag = { id: string; x: number; y: number; width: number; height: number; offsetX: number; offsetY: number; keyboard?: boolean };
type FolderContext = {
  id: string; name: string; parentId: string | null; parentName: string;
  background: Resource[]; backgroundLoading: boolean; backgroundError: string;
  backgroundToolbar: ReactNode; backgroundLeadingTile?: ReactNode; backgroundFooter: ReactNode; close: () => void;
  path: { id: string; name: string }[]; open: (id: string | null) => void; dismiss: () => void;
};
type Props = {
  items: Resource[]; enabled: boolean; canArrange: boolean;
  render: (item: Resource) => ReactNode;
  reorder: (id: string, beforeId: string | null, afterId: string | null) => Promise<void>;
  move: (id: string, folderId: string | null) => Promise<void>;
  folder?: FolderContext;
  toolbar?: ReactNode; input?: ReactNode; leadingTile?: ReactNode; footer?: ReactNode; empty?: ReactNode;
  feedback?: ReactNode;
  loading?: boolean; loadError?: string;
  suspended?: boolean;
  exitSelection?: () => void;
};

export function ResourceDesktop({ items, enabled, canArrange, render, reorder, move, folder, toolbar, input, leadingTile, feedback, footer, empty, loading, loadError, suspended, exitSelection }: Props) {
  const [order, setOrder] = useState(items);
  const [drag, setDrag] = useState<Drag>();
  const [dropId, setDropId] = useState<string>();
  const [hoverId, setHoverId] = useState<string>();
  const hoverRef = useRef<{ id: string; since: number; center: boolean } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const grid = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const cancelZone = useRef<HTMLButtonElement>(null);
  const [overCancel, setOverCancel] = useState(false);
  const orderRef = useRef(order); orderRef.current = order;
  const dragRef = useRef(drag); dragRef.current = drag;
  const dropRef = useRef(dropId); dropRef.current = dropId;
  const [escaped, setEscaped] = useState(false);
  const escapedRef = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const folderPath = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (folderPath.current) folderPath.current.scrollLeft = folderPath.current.scrollWidth;
  }, [folder?.id]);
  const sourceItems = useRef(items);
  const outsideSince = useRef<number | undefined>(undefined);
  const pending = useRef<{ id: string; x: number; y: number; pointerId: number; touch: boolean } | undefined>(undefined);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activateTouch = useRef<(() => void) | undefined>(undefined);
  const previous = useRef(new Map<string, DOMRect>());
  const suppressClick = useRef(0);
  const saveSequence = useRef(0);
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tiles = () => [...(grid.current?.querySelectorAll<HTMLElement>('[data-resource-id]') ?? [])];
  const snapshot = () => { previous.current = new Map(tiles().map((node) => [node.dataset.resourceId!, node.getBoundingClientRect()])); };
  const arrange = (next: Resource[]) => { snapshot(); orderRef.current = next; setOrder(next); };

  useEffect(() => { if (!dragRef.current && !escapedRef.current) { setOrder(items); orderRef.current = items; sourceItems.current = items; } }, [items]);
  useLayoutEffect(() => {
    if (!reducedMotion()) for (const node of tiles()) {
      const before = previous.current.get(node.dataset.resourceId!);
      node.getAnimations().forEach((animation) => animation.cancel());
      const after = node.getBoundingClientRect();
      if (before && (before.x !== after.x || before.y !== after.y)) {
        node.animate([{ transform: `translate(${before.x - after.x}px, ${before.y - after.y}px)` }, { transform: 'translate(0, 0)' }],
          { duration: 280, easing: 'cubic-bezier(.2,.85,.25,1)' });
      }
    }
    previous.current.clear();
  }, [order]);

  const cancel = () => {
    clearTimeout(pressTimer.current);
    saveSequence.current++;
    suppressClick.current = Date.now() + 400;
    pending.current = undefined; dragRef.current = undefined; dropRef.current = undefined;
    hoverRef.current = undefined; setHoverId(undefined);
    escapedRef.current = false; setEscaped(false); outsideSince.current = undefined;
    setDrag(undefined); setDropId(undefined); setOverCancel(false); arrange(sourceItems.current); setMessage('已取消移动');
  };
  const save = async (active: Drag) => {
    const sequence = ++saveSequence.current;
    pending.current = undefined;
    suppressClick.current = active.keyboard ? 0 : Date.now() + 400;
    const target = dropRef.current;
    const leaving = escapedRef.current;
    const moving = target !== undefined || leaving;
    // Only folders can live at the root. Videos/seasons must land in a folder.
    if (leaving && !target && !folder?.parentId && sourceItems.current.find(item => item.id === active.id)?.type !== 'Series') {
      cancel(); return;
    }
    const current = orderRef.current;
    const index = current.findIndex((item) => item.id === active.id);
    const changed = sourceItems.current.some((item, i) => item.id !== current[i]?.id);
    setBusy(true); setError('');
    // The floating cover settles into the destination cell before it disappears.
    const node = tiles().find((node) => node.dataset.resourceId === (target ?? active.id));
    if (node && ghost.current && !reducedMotion() && !active.keyboard) {
      const box = node.getBoundingClientRect();
      await ghost.current.animate([
        { transform: `translate3d(${active.x}px, ${active.y}px, 0) scale(${moving ? .72 : .88})` },
        { transform: `translate3d(${box.x}px, ${box.y}px, 0) scale(${moving ? .65 : 1})`, opacity: moving ? 0 : 1 },
      ], { duration: 210, easing: 'cubic-bezier(.2,.85,.25,1)', fill: 'forwards' }).finished.catch(() => {});
    }
    if (sequence !== saveSequence.current) { setBusy(false); return; }
    dragRef.current = undefined; dropRef.current = undefined;
    setDrag(undefined); setDropId(undefined); setHoverId(undefined); hoverRef.current = undefined;
    try {
      if (moving) {
        await move(active.id, target ?? folder?.parentId ?? null);
        setMessage('已移动');
        if (leaving) folder?.close();
      }
      else if (changed) {
        const before = current[index + 1]?.id ?? null;
        await reorder(active.id, before, before ? null : current[index - 1]?.id ?? null);
        setMessage('排列已保存');
      }
    } catch (failure) {
      escapedRef.current = false; setEscaped(false); arrange(sourceItems.current); setError((failure as Error).message || '未能保存移动，请重试');
    } finally { setBusy(false); }
  };

  // Global pointer listeners let a cover follow the pointer beyond its original cell.
  const handlers = useRef({ save, cancel, arrange, items, canArrange, folder });
  handlers.current = { save, cancel, arrange, items, canArrange, folder };
  useEffect(() => {
    let frame = 0;
    let pointer = { x: 0, y: 0 };
    const hitsCancel = () => {
      const box = cancelZone.current?.getBoundingClientRect();
      return !!box && pointer.x >= box.left && pointer.x <= box.right && pointer.y >= box.top && pointer.y <= box.bottom;
    };
    const update = () => {
      const active = dragRef.current;
      if (!active || active.keyboard || !grid.current) return;
      const next = { ...active, x: pointer.x - active.offsetX, y: pointer.y - active.offsetY };
      dragRef.current = next;
      if (next.x !== active.x || next.y !== active.y) setDrag(next);
      const cancelling = hitsCancel();
      setOverCancel(cancelling);
      if (cancelling) {
        outsideSince.current = undefined; hoverRef.current = undefined;
        setHoverId(undefined); dropRef.current = undefined; setDropId(undefined);
        setMessage('松开取消移动');
        return;
      }
      const source = orderRef.current.find((row) => row.id === active.id);
      const context = handlers.current.folder;
      if (context && !escapedRef.current && panel.current && !context.backgroundLoading && !context.backgroundError) {
        const box = panel.current.getBoundingClientRect();
        const outside = pointer.x < box.left - 8 || pointer.x > box.right + 8 || pointer.y < box.top - 8 || pointer.y > box.bottom + 8;
        if (outside) {
          outsideSince.current ??= performance.now();
          if (performance.now() - outsideSince.current >= 180) {
            escapedRef.current = true; setEscaped(true);
            hoverRef.current = undefined; setHoverId(undefined); dropRef.current = undefined; setDropId(undefined);
            if (source) handlers.current.arrange([...context.background.filter(item => item.id !== source.id), source]);
            setMessage(`已展开 ${context.parentName}，松开放下或拖入其他文件夹`);
            return;
          }
        } else outsideSince.current = undefined;
      }
      // offsetLeft/Top describe layout cells and ignore the animated transforms.
      const bounds = grid.current.getBoundingClientRect();
      const nodes = tiles();
      const hit = nodes.find((node) => pointer.x >= bounds.x + node.offsetLeft && pointer.x <= bounds.x + node.offsetLeft + node.offsetWidth &&
        pointer.y >= bounds.y + node.offsetTop - (grid.current?.scrollTop ?? 0) && pointer.y <= bounds.y + node.offsetTop - (grid.current?.scrollTop ?? 0) + node.offsetHeight);
      const item = orderRef.current.find((row) => row.id === hit?.dataset.resourceId);
      const center = hit && pointer.x > bounds.x + hit.offsetLeft + hit.offsetWidth * .22 && pointer.x < bounds.x + hit.offsetLeft + hit.offsetWidth * .78 &&
        pointer.y > bounds.y + hit.offsetTop - (grid.current?.scrollTop ?? 0) + 12 && pointer.y < bounds.y + hit.offsetTop - (grid.current?.scrollTop ?? 0) + hit.offsetHeight * .68;
      const canGroup = source && item && source.id !== item.id && item.type !== 'Episode';
      if (canGroup) {
        const central = !!center;
        if (hoverRef.current?.id !== item.id || hoverRef.current.center !== central) {
          hoverRef.current = { id: item.id, since: performance.now(), center: central };
        }
        const elapsed = performance.now() - hoverRef.current.since;
        const armed = central && (source.type === 'Episode' || elapsed >= 450);
        dropRef.current = armed ? item.id : undefined; setDropId(dropRef.current);
        setHoverId(central && !armed ? item.id : undefined);
        if (central) {
          setMessage(armed ? `松开移入 ${item.name}` : `停留以移入 ${item.name}`);
          return;
        }
        // An edge hover rearranges; crossing an edge briefly does not make a
        // folder jump away while the user approaches its grouping center.
        if (elapsed < 140) return;
      } else {
        hoverRef.current = undefined; setHoverId(undefined);
        dropRef.current = undefined; setDropId(undefined);
      }
      if (handlers.current.canArrange && item && item.id !== active.id) {
        const rows = [...orderRef.current];
        const from = rows.findIndex((row) => row.id === active.id), to = rows.findIndex((row) => row.id === item.id);
        rows.splice(to, 0, rows.splice(from, 1)[0]);
        handlers.current.arrange(rows);
        setMessage(`移动到第 ${to + 1} 个位置`);
      }
    };
    const scroll = () => {
      if (!dragRef.current || dragRef.current.keyboard) return;
      // Scroll the list that owns the covers, including a folder's scroll body.
      let scroller: HTMLElement | null = grid.current;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      const box = scroller?.getBoundingClientRect();
      const top = Math.max(0, box?.top ?? 0), bottom = Math.min(innerHeight, box?.bottom ?? innerHeight);
      const amount = hitsCancel() ? 0 : pointer.y < top + 56 ? -12 : pointer.y > bottom - 56 ? 12 : 0;
      if (amount) { if (scroller) scroller.scrollTop += amount; else window.scrollBy(0, amount); }
      update();
      frame = requestAnimationFrame(scroll);
    };
    const lift = () => {
      const start = pending.current;
      if (!start || dragRef.current) return;
      const node = tiles().find((node) => node.dataset.resourceId === start.id);
      if (!node) return;
      const box = node.getBoundingClientRect();
      dragRef.current = { id: start.id, x: box.x, y: box.y, width: box.width, height: box.height, offsetX: start.x - box.x, offsetY: start.y - box.y };
      sourceItems.current = handlers.current.items; outsideSince.current = undefined;
      setDrag(dragRef.current); setError('');
      frame = requestAnimationFrame(scroll);
    };
    activateTouch.current = () => {
      if (!pending.current) return;
      pointer = { x: pending.current.x, y: pending.current.y }; lift();
    };
    const pointerMove = (event: PointerEvent) => {
      const start = pending.current;
      if (!start || event.pointerId !== start.pointerId) return;
      pointer = { x: event.clientX, y: event.clientY };
      if (!dragRef.current) {
        const distance = Math.hypot(pointer.x - start.x, pointer.y - start.y);
        if (start.touch) {
          // A swipe scrolls normally; holding the cover first picks it up.
          if (distance > 8) { clearTimeout(pressTimer.current); pending.current = undefined; }
          return;
        }
        if (distance < 7) return;
        lift();
      }
      event.preventDefault(); update();
    };
    const touchMove = (event: TouchEvent) => {
      if (dragRef.current && !dragRef.current.keyboard) event.preventDefault();
    };
    const pointerUp = (event: PointerEvent) => {
      if (pending.current?.pointerId !== event.pointerId) return;
      cancelAnimationFrame(frame); clearTimeout(pressTimer.current);
      const active = dragRef.current;
      pending.current = undefined;
      if (active && hitsCancel()) { handlers.current.cancel(); return; }
      const hovered = hoverRef.current;
      if (active && hovered && !dropRef.current && handlers.current.canArrange) {
        const rows = [...orderRef.current];
        const from = rows.findIndex((row) => row.id === active.id), to = rows.findIndex((row) => row.id === hovered.id);
        if (from >= 0 && to >= 0 && from !== to) {
          rows.splice(to, 0, rows.splice(from, 1)[0]); handlers.current.arrange(rows);
        }
      }
      if (active) void handlers.current.save(active);
    };
    const abort = () => { clearTimeout(pressTimer.current); cancelAnimationFrame(frame); if (pending.current || dragRef.current) handlers.current.cancel(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && (pending.current || dragRef.current)) { event.preventDefault(); abort(); } };
    window.addEventListener('pointermove', pointerMove, { passive: false });
    window.addEventListener('touchmove', touchMove, { passive: false });
    window.addEventListener('pointerup', pointerUp); window.addEventListener('pointercancel', abort);
    window.addEventListener('blur', abort); window.addEventListener('keydown', escape);
    return () => {
      cancelAnimationFrame(frame); clearTimeout(pressTimer.current); activateTouch.current = undefined;
      window.removeEventListener('touchmove', touchMove);
      window.removeEventListener('pointermove', pointerMove); window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', abort); window.removeEventListener('blur', abort); window.removeEventListener('keydown', escape);
    };
  }, []);

  const start = (event: ReactPointerEvent, item: Resource) => {
    if (!enabled || busy || event.button !== 0 || dragRef.current) return;
    // A fresh press is intentional; only suppress the click emitted by a drop.
    suppressClick.current = 0;
    const target = event.target as HTMLElement;
    if (!target.closest('[data-drag-surface]')) return;
    const touch = event.pointerType === 'touch';
    pending.current = { id: item.id, x: event.clientX, y: event.clientY, pointerId: event.pointerId, touch };
    if (touch) pressTimer.current = setTimeout(() => activateTouch.current?.(), 320);
  };
  const dragged = sourceItems.current.find((item) => item.id === drag?.id);
  const loadingCards = Array.from({ length: 4 }, (_, index) => <div className="resource-skeleton-tile" key={`skeleton-${index}`} aria-hidden="true">
    <div className="desktop-cover"><Skeleton className="h-full w-full rounded-[14px]" /></div>
    <Skeleton className="mx-auto mt-3.5 h-4 w-2/3" />
  </div>);
  const desktop = <>
    {input}
    {error && <p role="alert" className="error">{error}</p>}
    {loadError && <p role="alert" className="error">{loadError}</p>}
    {!loading && !loadError && !order.length && !leadingTile && empty}
    {loading && <span className="sr-only" role="status">正在打开…</span>}
    <div ref={grid} className="resource-desktop" aria-label="资源卡片" aria-busy={busy || loading} data-dragging={!!drag}
      onKeyDown={event => { if (event.key === 'Escape' && exitSelection) { event.preventDefault(); event.stopPropagation(); exitSelection(); } }}>
      {escaped ? folder?.backgroundLeadingTile : leadingTile}
      {loading && loadingCards}
      {order.map((item) => <article key={item.id} data-resource-id={item.id} className={`resource-tile${drag?.id === item.id ? ' is-dragging' : ''}${dropId === item.id ? ' is-drop-target' : ''}${hoverId === item.id ? ' is-group-pending' : ''}`}
        onPointerDown={(event) => start(event, item)}
        onContextMenu={(event) => { if (pending.current?.touch || dragRef.current) event.preventDefault(); }}
        onKeyDown={(event) => {
          if (!enabled || !canArrange || busy || !event.altKey || !event.key.startsWith('Arrow') || !(event.target as HTMLElement).closest('[data-drag-surface]')) return;
          event.preventDefault();
          const rows = [...orderRef.current], from = rows.findIndex((row) => row.id === item.id);
          const columns = Math.max(1, Math.round((grid.current!.clientWidth + 24) / (event.currentTarget.clientWidth + 24)));
          const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -columns : columns;
          const to = Math.max(0, Math.min(rows.length - 1, from + delta));
          if (to === from) return;
          rows.splice(to, 0, rows.splice(from, 1)[0]); arrange(rows);
          const box = event.currentTarget.getBoundingClientRect();
          void save({ id: item.id, x: box.x, y: box.y, width: box.width, height: box.height, offsetX: 0, offsetY: 0, keyboard: true });
        }} onClickCapture={(event) => { if (Date.now() < suppressClick.current) { event.preventDefault(); event.stopPropagation(); } }}>
        {render(item)}
        {hoverId === item.id && <span className="desktop-hover-label">停留以移入</span>}
        {dropId === item.id && <>
          <span className="desktop-group-preview" aria-hidden="true"><FolderOpen />{dragged?.type === 'Episode' ? <FileVideo /> : <FolderOpen />}</span>
          <span className="desktop-drop-label">{item.type === 'Season' ? '松开移入这一季' : '松开移入文件夹'}</span>
        </>}
      </article>)}
    </div>
  </>;
  return <>
    {folder && !escaped ? <div className="folder-parent-desktop" aria-hidden="true" inert>
      {folder.backgroundToolbar}
      {folder.backgroundError && <p className="error">{folder.backgroundError}</p>}
      <div className="desktop-background-grid">
        {folder.backgroundLeadingTile}
        {folder.backgroundLoading && loadingCards}
        {folder.background.map(item => <article key={item.id} className="desktop-background-tile">{render(item)}</article>)}
      </div>
      {folder.backgroundFooter}
    </div> : <>
      {!escaped && <>{toolbar}{feedback}</>}
      {escaped && <div className="desktop-return-label" role="status">{folder?.parentName}<span>{dragged?.type !== 'Series' && !folder?.parentId ? '放入文件夹' : '松开放下'}</span></div>}
      {desktop}
      {escaped ? folder?.backgroundFooter : footer}
    </>}
    {folder && <Dialog modal={!suspended} open={!escaped} onOpenChange={open => { if (!open && !dragRef.current && !busy && !suspended) folder.dismiss(); }}>
      <DialogContent ref={panel} className="library-folder-panel" overlayClassName="library-folder-shade" aria-describedby={undefined} showCloseButton={false}
        onEscapeKeyDown={event => {
          if (exitSelection) { event.preventDefault(); exitSelection(); return; }
          if (event.target instanceof Element && event.target.closest('[data-folder-rename]')) event.preventDefault();
          if (dragRef.current || busy || suspended || !(event.target instanceof Node) || !panel.current?.contains(event.target)) event.preventDefault();
        }}
        onInteractOutside={event => {
          const target = event.detail.originalEvent.target;
          if (dragRef.current || busy || suspended || (target instanceof Element && target.closest('[data-slot="dialog-content"]'))) event.preventDefault();
        }}
        onOpenAutoFocus={event => { if (dragRef.current || suspended) event.preventDefault(); }}
        onCloseAutoFocus={event => event.preventDefault()}>
        {!escaped && <><DialogHeader className="folder-panel-heading">
          <div className="folder-navigation">
            <Button variant="ghost" size="icon" className="folder-back-link" aria-label={`返回${folder.parentName}`} title={`返回${folder.parentName}`} onClick={folder.close}><ArrowLeft /></Button>
            <div className="folder-location">
              <nav ref={folderPath} className="folder-path" aria-label="文件夹路径">
                <button type="button" onClick={() => folder.open(null)}>全部文件夹</button>
                {folder.path.map(ancestor => <span key={ancestor.id}>
                  <ChevronRight aria-hidden="true" />
                  <button type="button" title={ancestor.name} onClick={() => folder.open(ancestor.id)}>{ancestor.name}</button>
                </span>)}
              </nav>
              <DialogTitle title={folder.name}>{folder.name}</DialogTitle>
            </div>
          </div>
          <DialogClose asChild><Button variant="ghost" size="icon" className="folder-dismiss" aria-label="关闭" title="关闭文件夹，返回资源库"><X /></Button></DialogClose>
        </DialogHeader>
        <div className="folder-panel-body">
          {toolbar}
          {feedback}
          {desktop}
          {footer}
        </div></>}
      </DialogContent>
    </Dialog>}
    <span className="sr-only" role="status" aria-live="polite">{message}</span>
    {drag && !drag.keyboard && !busy && createPortal(<button ref={cancelZone} type="button"
      className="desktop-cancel-drop" data-active={overCancel} aria-label="取消移动" onClick={cancel}>
      <span>{overCancel ? '松开取消' : '拖到此处取消'}</span><span className="desktop-cancel-shortcut">Esc</span>
    </button>, document.body)}
    {drag && !drag.keyboard && dragged && createPortal(<div ref={ghost} aria-hidden="true" className={`desktop-drag-ghost resource-tile${dropId ? " is-grouping" : ""}${overCancel ? " is-cancelling" : ""}`}
      style={{ width: drag.width, height: drag.height, transform: `translate3d(${drag.x}px, ${drag.y}px, 0) scale(${dropId ? .72 : .88})` }}>{render(dragged)}</div>, document.body)}
  </>;
}
