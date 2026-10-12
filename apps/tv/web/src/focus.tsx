import { useEffect, type ReactNode, type RefObject } from 'react';
import { FocusContext, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';

export function FocusRegion({ focusKey, children, className = '', boundary = false, scrollRef, hidden = false }: {
  focusKey: string; children: ReactNode; className?: string; boundary?: boolean; hidden?: boolean;
  scrollRef?: RefObject<HTMLDivElement | null>;
}) {
  const { ref, hasFocusedChild } = useFocusable({ focusKey, focusable: !hidden, trackChildren: true,
    saveLastFocusedChild: true, isFocusBoundary: boundary });
  useEffect(() => {
    if (scrollRef) scrollRef.current = ref.current;
    return () => { if (scrollRef) scrollRef.current = null; };
  }, [ref, scrollRef]);
  return <FocusContext.Provider value={focusKey}>
    <div ref={ref} className={`${className} ${hasFocusedChild ? 'has-focus' : ''}`} data-focus-region={focusKey} aria-hidden={hidden || undefined} inert={hidden || undefined}>{children}</div>
  </FocusContext.Provider>;
}

type ScrollAnimation = { frame: number; left: number; top: number };
const scrolling = new WeakMap<HTMLElement, ScrollAnimation>();

function glide(node: HTMLElement, left: number, top: number) {
  const previous = scrolling.get(node);
  if (previous) cancelAnimationFrame(previous.frame);
  const startLeft = node.scrollLeft, startTop = node.scrollTop;
  const endLeft = Math.max(0, Math.min(left, node.scrollWidth - node.clientWidth));
  const endTop = Math.max(0, Math.min(top, node.scrollHeight - node.clientHeight));
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(endLeft - startLeft) + Math.abs(endTop - startTop) < 1) {
    node.scrollLeft = endLeft; node.scrollTop = endTop; scrolling.delete(node); return;
  }
  const started = performance.now();
  const state = { frame: 0, left: endLeft, top: endTop };
  scrolling.set(node, state);
  const tick = (now: number) => {
    const progress = Math.min(1, (now - started) / 220);
    const eased = 1 - (1 - progress) ** 3;
    node.scrollLeft = startLeft + (endLeft - startLeft) * eased;
    node.scrollTop = startTop + (endTop - startTop) * eased;
    if (progress < 1) state.frame = requestAnimationFrame(tick);
    else scrolling.delete(node);
  };
  state.frame = requestAnimationFrame(tick);
}

// Settle before saving/restoring a route so a late frame cannot overwrite its position.
export function finishScrolls(root: HTMLElement | null) {
  if (!root) return;
  [root, ...root.querySelectorAll<HTMLElement>('.rail-track')].forEach((node) => {
    const state = scrolling.get(node);
    if (!state) return;
    cancelAnimationFrame(state.frame); node.scrollLeft = state.left; node.scrollTop = state.top;
    scrolling.delete(node);
  });
}

// Use untransformed offsets, rather than animated card bounds, for stable targets.
export function revealCard(node: HTMLElement) {
  const rail = node.closest<HTMLElement>('.rail-track');
  if (rail) glide(rail, node.offsetLeft, 0);
  const shelf = node.closest<HTMLElement>('.shelf');
  const viewport = node.closest<HTMLElement>('.shelves-scroll');
  if (viewport && node.closest('.topbar')) glide(viewport, 0, 0);
  if (shelf && viewport) {
    let top = shelf.offsetTop, bottom = top + shelf.offsetHeight;
    if (node.closest('.episode-grid')) {
      top = 0;
      for (let element: HTMLElement | null = node; element && element !== viewport; element = element.offsetParent as HTMLElement | null) top += element.offsetTop;
      bottom = top + node.offsetHeight;
    }
    const current = scrolling.get(viewport)?.top ?? viewport.scrollTop;
    const inset = Math.max(12, parseFloat(getComputedStyle(viewport).scrollPaddingTop) || 0);
    if (top < current + inset) glide(viewport, 0, !node.closest('.episode-grid') && shelf === viewport.querySelector('.shelf') ? 0 : top - inset);
    else if (bottom > current + viewport.clientHeight - 12) glide(viewport, 0, bottom - viewport.clientHeight + 12);
  }
  const panel = node.closest<HTMLElement>('.overlay-panel');
  if (panel) {
    const card = node.getBoundingClientRect(), area = panel.getBoundingClientRect();
    if (card.top < area.top + 12) glide(panel, 0, panel.scrollTop + card.top - area.top - 12);
    else if (card.bottom > area.bottom - 12) glide(panel, 0, panel.scrollTop + card.bottom - area.bottom + 12);
  }
}

export function FocusButton({ focusKey, children, onClick, className = '', disabled = false, onFocus, onArrow, ariaLabel, selected }: {
  focusKey: string; children: ReactNode; onClick: () => void; className?: string; disabled?: boolean;
  onFocus?: () => void; onArrow?: (direction: string) => boolean; ariaLabel?: string; selected?: boolean;
}) {
  const { ref, focused, focusSelf } = useFocusable({ focusKey, focusable: !disabled, onEnterPress: onClick,
    onArrowPress: (direction) => {
      if (onArrow?.(direction) === false) return false;
      const node = ref.current as HTMLButtonElement | null;
      const grid = node?.closest<HTMLElement>('.episode-grid');
      if (grid) {
        const cards = Array.from(grid.querySelectorAll<HTMLButtonElement>('button[data-focus]:not(:disabled)'));
        const index = cards.indexOf(node!);
        const columns = cards.filter((card) => card.offsetTop === cards[0].offsetTop).length;
        const row = Math.floor(index / columns);
        let next = index;
        if (direction === 'left' && index % columns > 0) next--;
        if (direction === 'right' && index % columns < columns - 1 && index + 1 < cards.length) next++;
        if (direction === 'up' && row === 0) return true;
        if (direction === 'up' && row > 0) next -= columns;
        if (direction === 'down' && (row + 1) * columns < cards.length) next = Math.min(index + columns, cards.length - 1);
        if (next !== index) setFocus(cards[next].dataset.focus!);
        return false;
      }
      const rail = node?.closest<HTMLElement>('.rail-track');
      if (rail && (direction === 'left' || direction === 'right')) {
        const cards = Array.from(rail.querySelectorAll<HTMLButtonElement>('button[data-focus]:not(:disabled)'));
        const index = cards.indexOf(node!);
        const next = cards[index + (direction === 'right' ? 1 : -1)];
        if (next?.dataset.focus) setFocus(next.dataset.focus);
        return false; // Fast keys never use temporarily scaled/scrolling geometry.
      }
      return true;
    },
    onFocus: () => { if (ref.current) revealCard(ref.current); onFocus?.(); } });
  return <button type="button" ref={ref} data-focus={focusKey} aria-label={ariaLabel} aria-pressed={selected}
    className={`${className} ${focused ? 'focused' : ''}`} disabled={disabled}
    onFocus={() => focusSelf()} onClick={onClick}>{children}</button>;
}
