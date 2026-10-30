import { useEffect, type FocusEvent, type ReactNode, type RefObject } from 'react';
import { FocusContext, getCurrentFocusKey, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';

type Navigation = { cards: HTMLButtonElement[]; indices: WeakMap<HTMLButtonElement, number>; columns: number };
const navigation = new WeakMap<HTMLElement, Navigation>();

// Geometry changes on resize, and membership changes on append/disable. Neither
// belongs in the remote-key hot path. Cover loading must not invalidate this cache.
export function observeNavigation(root: HTMLElement) {
  const invalidate = () => navigation.delete(root);
  const resize = new ResizeObserver(invalidate);
  resize.observe(root);
  const mutation = new MutationObserver((records) => {
    if (records.some((record) => record.type === 'attributes' ||
      [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element &&
        (node.matches('button[data-focus]') || node.querySelector('button[data-focus]'))))) invalidate();
  });
  mutation.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  return () => { resize.disconnect(); mutation.disconnect(); invalidate(); };
}

function getNavigation(root: HTMLElement): Navigation {
  const cached = navigation.get(root);
  if (cached) return cached;
  const cards = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-focus]:not(:disabled)'));
  const indices = new WeakMap<HTMLButtonElement, number>();
  cards.forEach((card, index) => indices.set(card, index));
  // CSS grid provides the column count without measuring every card's position.
  const columns = root.classList.contains('episode-grid')
    ? Math.max(1, getComputedStyle(root).gridTemplateColumns.split(' ').filter(Boolean).length) : cards.length;
  const value = { cards, indices, columns };
  navigation.set(root, value);
  return value;
}

export function isFirstGridRow(node: HTMLElement) {
  const grid = node.closest<HTMLElement>('.episode-grid');
  if (!grid) return false;
  // Virtual grids may have unmounted all earlier rows. Use logical keys rather
  // than the first mounted card or its position among the remaining buttons.
  if (grid.dataset.firstRowKeys) return (JSON.parse(grid.dataset.firstRowKeys) as string[]).includes(node.dataset.focus ?? '');
  const { indices, columns } = getNavigation(grid);
  const index = indices.get(node as HTMLButtonElement);
  return index !== undefined && index < columns;
}

function restoreContainerFocus(event: FocusEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement;
  if (document.activeElement !== target || !target.matches('[data-focus-region], .shelf, .rail-track, .rail-content, .episode-grid')) return;
  // Native scroll-container focus can bypass spatial navigation. Restore a
  // usable control, keeping an open dialog's focus boundary intact.
  const scope = document.querySelector<HTMLElement>('.overlay-panel') ?? target.closest<HTMLElement>('.shelf') ?? event.currentTarget;
  const buttons = Array.from(scope.querySelectorAll<HTMLButtonElement>('button[data-focus]:not(:disabled)'))
    .filter((button) => !button.closest('[inert], [aria-hidden="true"]') && button.getClientRects().length > 0);
  const current = getCurrentFocusKey();
  const button = buttons.find((item) => item.dataset.focus === current) ?? buttons[0];
  if (button?.dataset.focus) setFocus(button.dataset.focus);
}

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
    <div ref={ref} className={`${className} ${hasFocusedChild ? 'has-focus' : ''}`} data-focus-region={focusKey} aria-hidden={hidden || undefined} inert={hidden || undefined} onFocusCapture={restoreContainerFocus}>{children}</div>
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
  // Native smooth scrolling is cancelled by DOM focus on TV/Chromium. Keep a
  // short, retargetable animation with no geometry measurements in its frames.
  const tick = (now: number) => {
    const progress = Math.min(1, (now - started) / 160);
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
  if (rail) {
    // Keep the row still while the focused card remains visible. Use the
    // animation target so rapid remote presses do not chase intermediate frames.
    const content = node.closest<HTMLElement>('.rail-content');
    const left = node.offsetLeft + (content?.offsetLeft ?? 0);
    const current = scrolling.get(rail)?.left ?? rail.scrollLeft;
    const inset = 20;
    if (left < current + inset) glide(rail, left - inset, 0);
    else if (left + node.offsetWidth > current + rail.clientWidth - inset) {
      glide(rail, left + node.offsetWidth - rail.clientWidth + inset, 0);
    }
  }
  const shelf = node.closest<HTMLElement>('.shelf');
  const viewport = node.closest<HTMLElement>('.shelves-scroll');
  if (viewport && node.closest('.topbar')) glide(viewport, 0, 0);
  if (shelf && viewport) {
    if (shelf === viewport.querySelector('.shelf') && isFirstGridRow(node)) {
      glide(viewport, 0, 0);
      return;
    }
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

export function FocusButton({ focusKey, children, onClick, className = '', disabled = false, onFocus, onArrow, ariaLabel, selected, autoRestoreFocus = true }: {
  focusKey: string; children: ReactNode; onClick: () => void; className?: string; disabled?: boolean;
  autoRestoreFocus?: boolean; onFocus?: () => void; onArrow?: (direction: string) => boolean; ariaLabel?: string; selected?: boolean;
}) {
  const { ref, focused, focusSelf } = useFocusable({ focusKey, focusable: !disabled, autoRestoreFocus, onEnterPress: onClick,
    onArrowPress: (direction) => {
      if (onArrow?.(direction) === false) return false;
      const node = ref.current as HTMLButtonElement | null;
      const grid = node?.closest<HTMLElement>('.episode-grid');
      if (grid) {
        const { cards, indices, columns } = getNavigation(grid);
        const index = indices.get(node!);
        if (index === undefined) return true;
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
        const { cards, indices } = getNavigation(rail);
        const index = indices.get(node!);
        if (index === undefined) return true;
        const next = cards[index + (direction === 'right' ? 1 : -1)];
        if (next?.dataset.focus) setFocus(next.dataset.focus);
        return false; // Fast keys never use temporarily scaled/scrolling geometry.
      }
      return true;
    },
    onFocus: () => { if (ref.current) revealCard(ref.current); onFocus?.(); } });
  return <button type="button" ref={ref} data-focus={focusKey} aria-label={ariaLabel} aria-pressed={selected}
    className={`${className} ${focused ? 'focused' : ''}`} disabled={disabled}
    onKeyDown={(event) => {
      // Spatial navigation handles these keys; native button activation/scroll
      // would otherwise fire a second action or move the viewport afterwards.
      if (event.key.startsWith('Arrow') || event.key === 'Enter') event.preventDefault();
    }}
    onFocus={() => { if (getCurrentFocusKey() !== focusKey) focusSelf(); }} onClick={onClick}>{children}</button>;
}
