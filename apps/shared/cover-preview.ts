// Share the same hover/focus interaction between the parent app and the TV WebView.
// A fresh blob URL restarts WebP playback even when the browser cached its end.
export function observeCoverPreview(host: HTMLElement, image: HTMLImageElement,
  load: (signal: AbortSignal) => Promise<Blob | null>) {
  const poster = image.getAttribute('src') || image.src;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let hovering = host.matches(':hover'), active = false, disposed = false;
  let cached: Blob | null | undefined, controller: AbortController | undefined, objectUrl = '';
  const reset = () => {
    controller?.abort(); controller = undefined;
    if (objectUrl) {
      if (image.src === objectUrl) image.src = poster;
      URL.revokeObjectURL(objectUrl); objectUrl = '';
      delete image.dataset.preview;
    }
  };
  const update = () => {
    const next = !reducedMotion.matches && (hovering || host.classList.contains('focused') || host.matches(':focus-visible'));
    if (next === active || disposed) return;
    active = next; reset();
    if (!active) return;
    const request = new AbortController(); controller = request;
    void (cached !== undefined ? Promise.resolve(cached) : load(request.signal)).then(blob => {
      if (request.signal.aborted || disposed || !active) return;
      cached = blob;
      if (blob) { objectUrl = URL.createObjectURL(blob); image.dataset.preview = 'true'; image.src = objectUrl; }
    }).catch(() => { /* Keep the first frame if the preview is unavailable/offline. */ });
  };
  const enter = () => { hovering = true; update(); };
  const leave = () => { hovering = false; update(); };
  const failed = (event: Event) => { if (objectUrl) { event.stopImmediatePropagation(); reset(); } };
  const observer = new MutationObserver(update);
  observer.observe(host, { attributes: true, attributeFilter: ['class'] });
  host.addEventListener('pointerenter', enter); host.addEventListener('pointerleave', leave);
  host.addEventListener('focusin', update); host.addEventListener('focusout', update);
  image.addEventListener('error', failed);
  reducedMotion.addEventListener('change', update);
  update();
  return () => {
    disposed = true; reset(); observer.disconnect();
    host.removeEventListener('pointerenter', enter); host.removeEventListener('pointerleave', leave);
    host.removeEventListener('focusin', update); host.removeEventListener('focusout', update);
    image.removeEventListener('error', failed);
    reducedMotion.removeEventListener('change', update);
  };
}
