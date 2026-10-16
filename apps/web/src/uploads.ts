import SparkMD5 from 'spark-md5';
import { api, type Upload } from './api';
import { sha256Blob as sha } from './file-hash';
import { getUploadLimits, validateUploadSize } from './upload-limits';
import { prepareVideo } from './video-metadata';

const files = new Map<string, File>();
const paused = new Set<string>();
const waiting = new Set<string>();
const running = new Set<string>();
export const live = new Map<string, { offset: number; error: string; paused: boolean; preparing?: boolean }>();
let active = 0;
function changed() { window.dispatchEvent(new Event('mollytime:uploads')); }
async function fingerprint(file: File) {
  return `${file.size}:${await sha(new Blob([file.slice(0, 1024**2), file.slice(Math.max(0, file.size - 1024**2))]))}`;
}
export async function enqueue(file: File, itemId: string, kind: string, language = 'und') {
  validateUploadSize(file, kind, await getUploadLimits());
  const row = await api<Upload>('/uploads', 'POST', { itemId, filename: file.name, size: file.size, fingerprint: await fingerprint(file), kind, language });
  if (kind === 'image') {
    try {
      await transfer(row.id, file);
    } catch (error) {
      // Inline failures belong to the cover form; release the session for a new selection.
      await api(`/uploads/${row.id}/cancel`, 'POST').catch(() => undefined);
      throw error;
    }
    return;
  }
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
async function transfer(id: string, file = files.get(id)!) {
  let row = await api<Upload>(`/uploads/${id}`);
  if (row.kind === 'video') {
    live.set(id, { offset: row.offset, error: '', paused: paused.has(id), preparing: true }); changed();
  }
  const metadata = row.kind === 'video' ? await prepareVideo(file).finally(() => {
    const state = live.get(id);
    if (state) { live.set(id, { ...state, preparing: false }); changed(); }
  }) : undefined;
  if (paused.has(id)) return;
  if (row.transport === 'oss') {
    const { parts, partSize } = await api<{ parts: { number: number; size: number }[]; partSize: number }>(`/uploads/${id}/parts`);
    const existing = new Set(parts.map((p) => p.number));
    let offset = parts.reduce((total, p) => total + p.size, 0);
    for (let number = 1; number <= Math.ceil(file.size / partSize) && !paused.has(id); number++) {
      if (existing.has(number)) continue;
      const chunk = file.slice((number - 1) * partSize, number * partSize);
      const md5 = btoa(SparkMD5.ArrayBuffer.hash(await chunk.arrayBuffer(), true));
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const signed = await api<{ url: string; headers: Record<string, string> }>(`/uploads/${id}/part-url`, 'POST', { number, md5 });
          const result = await fetch(signed.url, { method: 'PUT', credentials: 'omit', headers: signed.headers, body: chunk });
          if (!result.ok) throw new Error('云端上传失败，请重试；若持续失败请联系管理员检查跨域配置');
          break;
        } catch (error) { if (attempt === 2) throw error; }
      }
      offset += chunk.size;
      if (row.kind !== 'image') { live.set(id, { offset, error: '', paused: paused.has(id) }); changed(); }
    }
    if (!paused.has(id)) { await api(`/uploads/${id}/complete`, 'POST', metadata); files.delete(id); live.delete(id); }
    return;
  }
  while (row.offset < file.size && !paused.has(id)) {
    const part = file.slice(row.offset, row.offset + 8 * 1024**2);
    const hash = await sha(part);
    let result: Upload | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { result = await api<Upload>(`/uploads/${id}/chunks?offset=${row.offset}`, 'PUT', part, { 'X-Chunk-SHA256': hash }); break; }
      catch (error) { if (attempt === 2) throw error; }
    }
    row = result!;
    if (row.kind !== 'image') { live.set(id, { offset: row.offset, error: '', paused: false }); changed(); }
  }
  if (!paused.has(id)) { await api(`/uploads/${id}/complete`, 'POST', metadata); files.delete(id); live.delete(id); }
}
