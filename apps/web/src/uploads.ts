import { storedUploads, saveUpload, removeStoredUpload, setStoredPause, type SavedUpload } from './upload-store';
import SparkMD5 from 'spark-md5';
import { api, ApiError, type Upload, type Resource } from './api';
import { previewArtwork, confirmArtwork, clearArtworkPreviews } from './artwork-preview';
import { sha256Blob as sha } from './file-hash';
import { getUploadLimits, validateUploadSize } from './upload-limits';
import { prepareVideo } from './video-metadata';

const files = new Map<string, File>();
const paused = new Set<string>();
const waiting = new Set<string>();
const running = new Set<string>();
export const live = new Map<string, { offset: number; error: string; paused: boolean; preparing?: boolean; recovery?: string }>();
let active = 0;
let owner = '';
let generation = 0;
const controllers = new Map<string, AbortController>();
const retryOnReconnect = new Set<string>();
const recovery = new Map<string, string>();
let restoring: Promise<void> | undefined;
const artworkJobs = new Map<string, { record: SavedUpload; running: boolean; controller?: AbortController }>();
export function restoreUploads(account: string): Promise<void> {
  if (owner === account) return restoring ?? Promise.resolve();
  if (owner) stopUploads();
  owner = account;
  const epoch = generation;
  restoring = (async () => {
    const saved = (await storedUploads().catch(() => [])).sort((a, b) => a.savedAt - b.savedAt);
    for (const entry of saved) {
      if (owner !== account || generation !== epoch) return;
      if (entry.artwork) {
        if (entry.owner === account) {
          previewArtwork(entry.artwork.itemID, entry.artwork.kind, entry.file, entry.id);
          artworkJobs.set(entry.id, { record: entry, running: false });
        }
        continue;
      }
      // Expired local copies are discarded even when they belonged to another login.
      if (Date.now() - entry.savedAt > 7 * 86400000) { await removeStoredUpload(entry.id).catch(() => {}); continue; }
      if (entry.owner !== account) continue;
      try {
        const row = await api<Upload>(`/uploads/${entry.id}`);
        if (owner !== account || generation !== epoch) return;
        if (row.status !== 'uploading') { await removeStoredUpload(entry.id).catch(() => {}); continue; }
        recovery.set(row.id, "已保存到本机，重新打开后可恢复");
        files.set(row.id, entry.file);
        if (entry.paused) paused.add(row.id); else waiting.add(row.id);
        live.set(row.id, { offset: row.offset, error: '', paused: entry.paused, recovery: '已保存到本机，重新打开后可恢复' });
      } catch (error) {
        if (error instanceof ApiError && [403, 404, 410].includes(error.status)) await removeStoredUpload(entry.id).catch(() => {});
        else if (owner === account && generation === epoch) {
          files.set(entry.id, entry.file);
          live.set(entry.id, { offset: 0, error: '连接恢复后继续上传', paused: true });
          if (!entry.paused) retryOnReconnect.add(entry.id); else paused.add(entry.id);
        }
      }
    }
    changed(); pump(); resumeArtwork();
  })();
  return restoring;
}
async function persist(id: string, file: File) {
  if (!owner) return;
  const account = owner, epoch = generation;
  try {
    await saveUpload({ id, owner: account, file, paused: paused.has(id), savedAt: Date.now() });
    if (owner !== account || epoch !== generation) { await removeStoredUpload(id); return; }
    recovery.set(id, '已保存到本机，重新打开后可恢复');
  } catch { recovery.set(id, '本机无法保存此文件，关闭页面后需重新选择原文件续传'); }
}
export function forgetUpload(id: string) {
  paused.add(id); waiting.delete(id); retryOnReconnect.delete(id);
  controllers.get(id)?.abort(); files.delete(id); live.delete(id); recovery.delete(id);
  void removeStoredUpload(id).catch(() => {}); changed();
}
const reconnect = () => {
  if (!navigator.onLine || document.hidden) return;
  resumeArtwork();
  for (const id of retryOnReconnect) {
    if (!files.has(id) || paused.has(id)) continue;
    retryOnReconnect.delete(id); waiting.add(id);
    live.set(id, { offset: live.get(id)?.offset ?? 0, error: '', paused: false });
  }
  pump();
};
window.addEventListener('mollytime:revalidate', reconnect);
window.addEventListener('online', reconnect);
const suspend = () => {
  for (const [id, controller] of controllers) {
    if (!files.has(id) || paused.has(id)) continue;
    retryOnReconnect.add(id);
    live.set(id, { offset: live.get(id)?.offset ?? 0, error: '', paused: true, recovery: '恢复网络并回到应用后继续上传' });
    controller.abort();
  }
  changed();
};
window.addEventListener('offline', suspend);
window.addEventListener('pagehide', suspend);
document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); else reconnect(); });

function changed() { window.dispatchEvent(new Event('mollytime:uploads')); }
async function fingerprint(file: File) {
  return `${file.size}:${await sha(new Blob([file.slice(0, 1024**2), file.slice(Math.max(0, file.size - 1024**2))]))}`;
}
export async function enqueue(file: File, itemId: string, kind: string, language = 'und') {
  if (kind === 'image' || kind === 'preview') {
    const record: SavedUpload = { id: `artwork-${crypto.randomUUID()}`, owner, file, paused: false, savedAt: Date.now(), artwork: { itemID: itemId, kind } };
    previewArtwork(itemId, kind, file, record.id);
    artworkJobs.set(record.id, { record, running: false });
    void saveUpload(record).catch(() => {}).finally(resumeArtwork);
    return;
  }
  const epoch = generation;
  validateUploadSize(file, kind, await getUploadLimits());
  const row = await api<Upload>('/uploads', 'POST', { itemId, filename: file.name, size: file.size, fingerprint: await fingerprint(file), kind, language });
  if (epoch !== generation) throw new Error('登录已变更，请重新上传');
  files.set(row.id, file);
  await persist(row.id, file);
  if (epoch !== generation) return;
  waiting.add(row.id);
  live.set(row.id, { offset: 0, error: '', paused: false, recovery: recovery.get(row.id) }); changed(); pump();
}

function resumeArtwork() {
  if (!owner || !navigator.onLine || document.hidden) return;
  for (const [id, job] of artworkJobs) {
    if (job.running || job.record.owner !== owner) continue;
    // Serialise replacements of the same image; an older upload must not
    // finish after a more recently selected one and overwrite it on the server.
    if ([...artworkJobs.values()].find(other => other.record.artwork?.itemID === job.record.artwork?.itemID
        && other.record.artwork?.kind === job.record.artwork?.kind) !== job) continue;
    job.running = true;
    const epoch = generation;
    const controller = new AbortController(); job.controller = controller;
    const superseded = () => {
      const jobs = [...artworkJobs.values()];
      return jobs.slice(jobs.indexOf(job) + 1).some(other => other.record.artwork?.itemID === job.record.artwork?.itemID
        && other.record.artwork?.kind === job.record.artwork?.kind);
    };
    const discard = async () => {
      await removeStoredUpload(id).catch(() => {});
      if (epoch === generation) artworkJobs.delete(id);
    };
    void (async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (epoch !== generation || controller.signal.aborted) return;
        try {
          const artwork = job.record.artwork!;
          if (!artwork.upload && superseded()) { await discard(); return; }
          validateUploadSize(job.record.file, artwork.kind, await getUploadLimits());
          let row = artwork.upload
            ? await api<Upload>(`/uploads/${artwork.upload.id}`, 'GET', undefined, undefined, controller.signal)
            : await api<Upload>('/uploads', 'POST', { itemId: artwork.itemID, filename: job.record.file.name, kind: artwork.kind,
                size: job.record.file.size, fingerprint: await fingerprint(job.record.file) }, undefined, controller.signal);
          if (epoch !== generation) return;
          artwork.upload = row;
          await saveUpload(job.record).catch(() => {});
          if (superseded() && row.status !== 'processing') {
            if (row.status === 'uploading' || row.status === 'failed') {
              await api(`/uploads/${row.id}/cancel`, 'POST', undefined, undefined, controller.signal);
            }
            await discard(); return;
          }
          if (row.status === 'cancelled') throw new ApiError('上传已结束', 410);
          if (row.status === 'failed' && row.taskId) row = await api<Upload>(`/tasks/${row.taskId}/retry`, 'POST', undefined, undefined, controller.signal);
          if (row.status === 'uploading') await transfer(row.id, job.record.file, controller.signal, epoch);
          await waitForArtwork(row.id, epoch, controller.signal);
          const resource = await api<Resource>(`/resources/${artwork.itemID}`, 'GET', undefined, undefined, controller.signal);
          if (epoch !== generation) return;
          confirmArtwork(artwork.itemID, artwork.kind, id, artwork.kind === 'preview' ? resource.imagePreviewUrl || resource.imageUrl : resource.imageUrl);
          await discard(); changed();
          window.dispatchEvent(new Event('mollytime:artwork-saved'));
          return;
        } catch (error) {
          if (epoch !== generation || controller.signal.aborted) return;
          if (error instanceof ApiError && [400, 401, 403, 413, 422].includes(error.status)) return;
          if (error instanceof ApiError && [404, 410].includes(error.status)) {
            job.record.artwork!.upload = undefined;
            await saveUpload(job.record).catch(() => {});
          }
          if (attempt < 5) await new Promise(resolve => window.setTimeout(resolve, [2000, 5000, 15000, 60000, 300000][attempt]));
        }
      }
    })().finally(() => { job.running = false; job.controller = undefined; if (!artworkJobs.has(id)) resumeArtwork(); });
  }
}

async function waitForArtwork(id: string, epoch: number, signal?: AbortSignal) {
  // Keep the local preview until the worker commits the new one. Polling may stop
  // when the page closes; the durable server task continues independently.
  for (let attempt = 0; attempt < 60; attempt++) {
    if (epoch !== generation || signal?.aborted) throw new Error('登录已变更，请重新打开资料库');
    const row = await api<Upload>(`/uploads/${id}`, 'GET', undefined, undefined, signal);
    if (epoch !== generation) throw new Error('登录已变更，请重新打开资料库');
    if (row.status === 'ready') { changed(); return; }
    if (row.status === 'failed') throw new Error(`${row.error || '封面处理失败'}；可在上传任务中重试处理或取消。`);
    if (row.status !== 'processing') throw new Error('封面上传已结束，请查看上传任务。');
    await new Promise(resolve => window.setTimeout(resolve, 1000));
  }
  throw new Error('封面仍在后台处理中，可离开页面，稍后在上传任务中查看。');
}
export async function resume(row: Upload, selected?: File) {
  const epoch = generation;
  const file = selected || files.get(row.id);
  if (!file) throw new Error('请重新选择原文件继续上传');
  if (file.size !== row.size || await fingerprint(file) !== row.fingerprint) throw new Error('所选文件与原文件不一致');
  if (epoch !== generation) throw new Error('登录已变更，请重新上传');
  files.set(row.id, file); paused.delete(row.id); retryOnReconnect.delete(row.id);
  if (selected) await persist(row.id, file);
  if (epoch !== generation) return;
  void setStoredPause(row.id, false).catch(() => {});
  live.set(row.id, { offset: row.offset, error: '', paused: false, recovery: recovery.get(row.id) });
  if (!running.has(row.id)) waiting.add(row.id);
  changed(); pump();
}
export function pause(id: string) {
  paused.add(id); waiting.delete(id); retryOnReconnect.delete(id);
  void setStoredPause(id, true).catch(() => {});
  const state = live.get(id);
  live.set(id, { offset: state?.offset || 0, error: state?.error || '', paused: true }); changed();
}
export function hasActiveUploads() { return running.size > 0 || waiting.size > 0 || [...files.keys()].some(id => !paused.has(id) && !live.get(id)?.paused); }
export function hasFile(id: string) { return files.has(id); }
export function stopUploads() {
  generation++;
  for (const job of artworkJobs.values()) job.controller?.abort();
  artworkJobs.clear(); clearArtworkPreviews();
  const account = owner;
  owner = ''; restoring = undefined;
  for (const controller of controllers.values()) controller.abort();
  for (const id of files.keys()) void removeStoredUpload(id).catch(() => {});
  void storedUploads().then(rows => Promise.all(rows.filter(row => row.owner === account).map(row => removeStoredUpload(row.id)))).catch(() => {});
  waiting.clear(); files.clear(); live.clear(); paused.clear(); retryOnReconnect.clear(); recovery.clear(); changed();
}
function pump() {
  if (!navigator.onLine || document.hidden) return;
  for (const id of waiting) {
    if (active >= 2) break;
    if (running.has(id)) continue;
    waiting.delete(id); active++; running.add(id);
    const epoch = generation;
    const controller = new AbortController(); controllers.set(id, controller);
    const execute = () => transfer(id, files.get(id)!, controller.signal, epoch);
    // Only one tab may send chunks for a given server upload at a time.
    const transferTask = navigator.locks ? navigator.locks.request(`mollytime-upload:${id}`, { signal: controller.signal }, execute) : execute();
    void transferTask.catch((error) => {
      if (epoch !== generation || !files.has(id) || controller.signal.aborted) return;
      if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) retryOnReconnect.add(id);
      live.set(id, { offset: live.get(id)?.offset || 0, error: error.message, paused: true, recovery: recovery.get(id) });
    }).finally(() => { active--; running.delete(id); controllers.delete(id); changed(); pump(); });
  }
}
async function transfer(id: string, file = files.get(id)!, signal?: AbortSignal, epoch = generation) {
  const request = <T>(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) => {
    if (epoch !== generation || signal?.aborted) throw new DOMException('上传已停止', 'AbortError');
    return api<T>(path, method, body, headers, signal);
  };
  const stopped = () => paused.has(id) || epoch !== generation || !!signal?.aborted;
  let row = await request<Upload>(`/uploads/${id}`);
  const transferAttempts = row.kind === 'image' || row.kind === 'preview' ? 1 : 3;
  if (['ready', 'processing', 'cancelled'].includes(row.status)) { forgetUpload(id); return; }
  if (row.kind === 'video') {
    live.set(id, { offset: row.offset, error: '', paused: paused.has(id), preparing: true, recovery: recovery.get(id) }); changed();
  }
  const metadata = row.kind === 'video' ? await prepareVideo(file).finally(() => {
    const state = live.get(id);
    if (state) { live.set(id, { ...state, preparing: false }); changed(); }
  }) : undefined;
  if (stopped()) return;
  if (row.transport === 'oss') {
    const { parts, partSize } = await request<{ parts: { number: number; size: number }[]; partSize: number }>(`/uploads/${id}/parts`);
    const existing = new Set(parts.map((p) => p.number));
    let offset = parts.reduce((total, p) => total + p.size, 0);
    for (let number = 1; number <= Math.ceil(file.size / partSize) && !stopped(); number++) {
      if (existing.has(number)) continue;
      const chunk = file.slice((number - 1) * partSize, number * partSize);
      const md5 = btoa(SparkMD5.ArrayBuffer.hash(await chunk.arrayBuffer(), true));
      for (let attempt = 0; attempt < transferAttempts; attempt++) {
        try {
          const signed = await request<{ url: string; headers: Record<string, string> }>(`/uploads/${id}/part-url`, 'POST', { number, md5 });
          let result: Response;
          try { result = await fetch(signed.url, { method: 'PUT', credentials: 'omit', headers: signed.headers, body: chunk, signal }); }
          catch (error) { if (signal?.aborted) throw error; throw new ApiError('连接中断，恢复连接后继续上传', 0); }
          if (!result.ok) throw new Error('云端上传失败，请重试；若持续失败请联系管理员检查跨域配置');
          break;
        } catch (error) { if (attempt === transferAttempts - 1) throw error; }
      }
      offset += chunk.size;
      if (row.kind !== 'image' && row.kind !== 'preview') { live.set(id, { offset, error: '', paused: paused.has(id), recovery: recovery.get(id) }); changed(); }
    }
    if (!stopped()) { await request(`/uploads/${id}/complete`, 'POST', metadata); forgetUpload(id); }
    return;
  }
  while (row.offset < file.size && !stopped()) {
    const part = file.slice(row.offset, row.offset + 8 * 1024**2);
    const hash = await sha(part);
    let result: Upload | undefined;
    for (let attempt = 0; attempt < transferAttempts; attempt++) {
      try { result = await request<Upload>(`/uploads/${id}/chunks?offset=${row.offset}`, 'PUT', part, { 'X-Chunk-SHA256': hash }); break; }
      catch (error) { if (attempt === transferAttempts - 1) throw error; }
    }
    row = result!;
    if (row.kind !== 'image' && row.kind !== 'preview') { live.set(id, { offset: row.offset, error: '', paused: paused.has(id), recovery: recovery.get(id) }); changed(); }
  }
  if (!stopped()) { await request(`/uploads/${id}/complete`, 'POST', metadata); forgetUpload(id); }
}
