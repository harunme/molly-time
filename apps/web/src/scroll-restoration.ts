import { useLayoutEffect, useRef } from 'react';

/** Keep each destination's document position, including the library beneath a folder. */
export function useDocumentScroll(path: string, account = '') {
  const positions = useRef(new Map<string, number>());
  const owner = useRef(account);
  useLayoutEffect(() => {
    const previous = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    return () => { history.scrollRestoration = previous; };
  }, []);
  useLayoutEffect(() => {
    if (owner.current !== account) { positions.current.clear(); owner.current = account; }
    const target = positions.current.get(path) ?? 0;
    let restoring = true;
    let observer: ResizeObserver | undefined;
    const remember = () => { if (!restoring) positions.current.set(path, window.scrollY); };
    const finish = () => { restoring = false; observer?.disconnect(); };
    const restore = () => {
      if (!restoring) return;
      window.scrollTo({ top: target, left: 0, behavior: 'instant' });
      if (Math.abs(window.scrollY - target) < 2) finish();
    };
    observer = new ResizeObserver(restore);
    observer.observe(document.body);
    restore();
    const leaving = () => { positions.current.set(path, window.scrollY); restoring = true; observer?.disconnect(); };
    const link = (event: MouseEvent) => {
      const anchor = (event.target as Element)?.closest('a[href]');
      if (anchor) { const url = new URL((anchor as HTMLAnchorElement).href); if (url.origin === location.origin && url.pathname === location.pathname && url.hash.startsWith('#/') && url.hash.split('?')[0] !== window.location.hash.split('?')[0]) leaving(); }
    };
    window.addEventListener('mollytime:before-navigation', leaving);
    window.addEventListener('popstate', leaving);
    document.addEventListener('click', link, true);
    window.addEventListener('scroll', remember, { passive: true });
    window.addEventListener('touchstart', finish, { passive: true });
    window.addEventListener('pointerdown', finish, { passive: true });
    window.addEventListener('wheel', finish, { passive: true });
    window.addEventListener('keydown', finish);
    return () => {
      observer?.disconnect();
      window.removeEventListener('mollytime:before-navigation', leaving);
      window.removeEventListener('popstate', leaving);
      document.removeEventListener('click', link, true);
      window.removeEventListener('scroll', remember);
      window.removeEventListener('touchstart', finish);
      window.removeEventListener('pointerdown', finish);
      window.removeEventListener('wheel', finish);
      window.removeEventListener('keydown', finish);
    };
  }, [path, account]);
}
