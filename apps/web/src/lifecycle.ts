import { useEffect, useState } from 'react';

export function useRevalidation() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener('mollytime:revalidate', refresh);
    return () => window.removeEventListener('mollytime:revalidate', refresh);
  }, []);
  return revision;
}

export function startLifecycle() {
  let timer: ReturnType<typeof setTimeout>;
  const refresh = () => {
    if (document.hidden || !navigator.onLine) return;
    clearTimeout(timer);
    timer = setTimeout(() => window.dispatchEvent(new Event('mollytime:revalidate')), 150);
  };
  window.addEventListener('online', refresh);
  window.addEventListener('pageshow', refresh);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  const viewport = window.visualViewport;
  const resize = () => {
    document.documentElement.style.setProperty('--visible-height', `${viewport?.height ?? innerHeight}px`);
    document.documentElement.style.setProperty('--visible-top', `${viewport?.offsetTop ?? 0}px`);
  };
  resize();
  viewport?.addEventListener('resize', resize);
  viewport?.addEventListener('scroll', resize);
  window.addEventListener('resize', resize);
}
