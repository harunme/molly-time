import { api, type Upload } from './api';

const files = new Map<string, File>();
const paused = new Set<string>();
const waiting = new Set<string>();
const running = new Set<string>();
export const live = new Map<string, { offset: number; error: string; paused: boolean }>();
let active = 0;
function changed() { window.dispatchEvent(new Event('mollytime:uploads')); }
async function sha(blob: Blob) {
  if (!crypto.subtle) throw new Error('文件上传需要 HTTPS；本机开发可使用 localhost');
  const value = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function fingerprint(file: File) {
  return `${file.size}:${await sha(new Blob([file.slice(0, 1024**2), file.slice(Math.max(0, file.size - 1024**2))]))}`;
}
export async function enqueue(file: File, itemId: string, kind: string, language = 'und') {
  const row = await api<Upload>('/uploads', 'POST', { itemId, filename: file.name, size: file.size, fingerprint: await fingerprint(file), kind, language });
  files.set(row.id, file); waiting.add(row.id);
  live.set(row.id, { offset: 0, error: '', paused: false }); changed(); pump();
}
export async function resume(row: Upload, selected?: File) {
  const file = selected || files.get(row.id);
  if (!file) throw new Error('请重新选择原文件继续上传');
  if (file.size !== row.size || await fingerprint(file) !== row.fingerprint) throw new Error('所选文件与原文件不一致');
  files.set(row.id, file); paused.delete(row.id);
  live.set(row.id, { offset: row.offset, error: '', paused: false });
  if (!running.has(row.id)) waiting.add(row.id);
  changed(); pump();
}
export function pause(id: string) {
  paused.add(id); waiting.delete(id);
  const state = live.get(id);
  live.set(id, { offset: state?.offset || 0, error: state?.error || '', paused: true }); changed();
}
export function hasFile(id: string) { return files.has(id); }
export function stopUploads() {
  for (const id of files.keys()) paused.add(id);
  waiting.clear(); files.clear(); live.clear(); changed();
}
function pump() {
  for (const id of waiting) {
    if (active >= 2) break;
    waiting.delete(id); active++; running.add(id);
    void transfer(id).catch((error) => {
      live.set(id, { offset: live.get(id)?.offset || 0, error: error.message, paused: true });
    }).finally(() => { active--; running.delete(id); changed(); pump(); });
  }
}
async function transfer(id: string) {
  const file = files.get(id)!;
  let row = await api<Upload>(`/uploads/${id}`);
  while (row.offset < file.size && !paused.has(id)) {
    const part = file.slice(row.offset, row.offset + 8 * 1024**2);
    const hash = await sha(part);
    let result: Upload | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { result = await api<Upload>(`/uploads/${id}/chunks?offset=${row.offset}`, 'PUT', part, { 'X-Chunk-SHA256': hash }); break; }
      catch (error) { if (attempt === 2) throw error; }
    }
    row = result!;
    live.set(id, { offset: row.offset, error: '', paused: false }); changed();
  }
  if (!paused.has(id)) { await api(`/uploads/${id}/complete`, 'POST'); files.delete(id); live.delete(id); }
}
