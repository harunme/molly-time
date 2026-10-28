import { useEffect, useRef } from 'react';
import { observeCoverPreview } from '../../shared/cover-preview';

export function CoverArtwork({ src, preview }: { src: string; preview?: string | null }) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = ref.current, host = image?.closest('button');
    if (!image || !host || !preview) return;
    const url = new URL(preview, location.origin); url.searchParams.set('w', '320');
    return observeCoverPreview(host, image, async signal => {
      const response = await fetch(url, { signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error('封面预览暂不可用');
      if (response.status === 204) return null;
      return response.blob();
    });
  }, [src, preview]);
  return <img ref={ref} src={src} alt="" loading="lazy" draggable={false}
    onLoad={event => { event.currentTarget.dataset.loaded = 'true'; event.currentTarget.style.display = ''; }}
    onError={event => { if (event.currentTarget.src.startsWith('blob:')) return;
      delete event.currentTarget.dataset.loaded; event.currentTarget.style.display = 'none'; }} />;
}
