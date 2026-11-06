import { useSyncExternalStore } from 'react';

type Preview = { token: string; url: string; local: boolean };
type Artwork = { image?: Preview; preview?: Preview };
const items = new Map<string, Artwork>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useLocalArtwork(itemID?: string) {
  return useSyncExternalStore(subscribe, () => itemID ? items.get(itemID) : undefined);
}
export function previewArtwork(itemID: string, kind: 'image' | 'preview', file: File, token: string) {
  const current = items.get(itemID) ?? {}, old = current[kind];
  if (old?.local) URL.revokeObjectURL(old.url);
  items.set(itemID, { ...current, [kind]: { token, url: URL.createObjectURL(file), local: true } });
  changed();
}
export function confirmArtwork(itemID: string, kind: 'image' | 'preview', token: string, url: string) {
  if (!url || items.get(itemID)?.[kind]?.token !== token) return;
  // Decode the saved image before replacing the already visible local preview.
  const image = new Image();
  image.onload = () => {
    const current = items.get(itemID), old = current?.[kind];
    if (!current || !old || old.token !== token) return;
    items.set(itemID, { ...current, [kind]: { token, url, local: false } });
    if (old.local) URL.revokeObjectURL(old.url);
    changed();
  };
  image.src = url;
}
export function clearArtworkPreviews() {
  for (const item of items.values()) for (const preview of Object.values(item)) {
    if (preview?.local) URL.revokeObjectURL(preview.url);
  }
  items.clear(); changed();
}
export function releaseConfirmedArtwork(itemID: string, kind: 'image' | 'preview', url?: string | null) {
  const item = items.get(itemID), preview = item?.[kind];
  if (!item || !preview || preview.local || preview.url !== url) return;
  const next = { ...item }; delete next[kind];
  if (next.image || next.preview) items.set(itemID, next); else items.delete(itemID);
  changed();
}
