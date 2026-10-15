import { useLayoutEffect, useRef } from 'react';

type Direction = 'open' | 'forward' | 'back';
const easing = 'cubic-bezier(0.16, 1, 0.3, 1)';
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const cancel = (animations: Animation[]) => { animations.forEach((animation) => animation.cancel()); animations.length = 0; };

// Animate containers, leaving card focus transforms and scroll geometry intact
// as soon as the remote is used. No animation completion gates navigation.
export function useTvMotion(homeReady: boolean, page: string | null) {
  const homeRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const direction = useRef<Direction>('open');
  const homeShown = useRef(false);
  const homeAnimations = useRef<Animation[]>([]);
  const panelAnimations = useRef<Animation[]>([]);

  useLayoutEffect(() => {
    const interrupt = () => {
      homeShown.current = true;
      cancel(homeAnimations.current);
      cancel(panelAnimations.current);
    };
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => { if (preference.matches) interrupt(); };
    window.addEventListener('keydown', interrupt, true);
    window.addEventListener('pointerdown', interrupt, true);
    window.addEventListener('molly:menu', interrupt);
    preference.addEventListener('change', changed);
    return () => {
      window.removeEventListener('keydown', interrupt, true);
      window.removeEventListener('pointerdown', interrupt, true);
      window.removeEventListener('molly:menu', interrupt);
      preference.removeEventListener('change', changed);
      cancel(homeAnimations.current);
      cancel(panelAnimations.current);
    };
  }, []);

  useLayoutEffect(() => {
    if (!homeReady || homeShown.current || !homeRef.current) return;
    homeShown.current = true;
    if (reducedMotion()) return;
    const greeting = homeRef.current.querySelector<HTMLElement>('.home-greeting');
    const rows = Array.from(homeRef.current.querySelectorAll<HTMLElement>('.shelf')).slice(0, 3);
    const enter = (node: HTMLElement, delay: number) => {
      if (typeof node.animate !== 'function') return;
      homeAnimations.current.push(node.animate([
        { opacity: 0, transform: 'translateY(12px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ], { id: 'tv-home-entry', duration: 340, delay, easing, fill: 'backwards' }));
    };
    if (greeting) enter(greeting, 0);
    rows.forEach((row, index) => enter(row, 60 + index * 50));
    return () => cancel(homeAnimations.current);
  }, [homeReady]);

  useLayoutEffect(() => {
    cancel(panelAnimations.current);
    const node = direction.current === 'open' ? panelRef.current?.parentElement : panelRef.current;
    if (!page || !node || reducedMotion() || typeof node.animate !== 'function') return;
    const from = direction.current === 'open' ? 'translateY(8px)' : `translateX(${direction.current === 'back' ? '-18' : '18'}px)`;
    panelAnimations.current.push(node.animate([
      { opacity: 0, transform: from }, { opacity: 1, transform: 'translate(0, 0)' },
    ], { id: `tv-panel-${direction.current}`, duration: 200, easing }));
    return () => cancel(panelAnimations.current);
  }, [page]);

  return { homeRef, panelRef, direction };
}
