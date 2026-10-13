export type Session = { user: { id: string; name: string; role: string }; family: { id: string; name: string }; csrfToken: string };
export type Resource = { id: string; name: string; type: 'Series' | 'Season' | 'Episode'; parentId: string | null; overview: string; indexNumber: number | null; status: string; ready: boolean; legacy: boolean; runtimeMs: number; imageUrl: string; files: { id: string; name: string; kind: string; size: number; language: string; storage: string; version: string; isDefault: boolean; offsetMs: number }[] };
export type Child = { id: string; name: string };
export type Page<T> = { items: T[]; page: number; pageSize: number; total: number };
export type ResourceOption = Pick<Resource, 'id' | 'name' | 'type' | 'status'>;
export type Upload = { id: string; itemId: string; filename: string; size: number; offset: number; status: string; fingerprint: string; kind: string; error: string; taskId: string | null; taskStatus: string | null; transport?: 'local' | 'oss'; partSize?: number };
export type WatchReport = { timezone: string; totalPlayedMs: number; episodeCount: number; statisticsSince: string | null; lastSync: string | null; days: { date: string; playedMs: number }[]; contents: { id: string; name: string; playedMs: number }[]; sessions: { id: string; name: string; childName: string; deviceName: string; startedAt: string; playedMs: number; positionMs: number; ended: boolean; lastSync: string | null }[] };
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
let csrf = '';
export function setSession(session: Session | undefined) { csrf = session?.csrfToken || ''; }
export async function api<T>(path: string, method = 'GET', body?: unknown, extraHeaders?: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const raw = body instanceof Blob;
  const response = await fetch('/api/manage' + path, { method, signal, credentials: 'same-origin',
    headers: { ...(raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }), 'X-CSRF-Token': csrf, ...extraHeaders },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) window.dispatchEvent(new Event('mollytime:unauthorized'));
    const message = typeof data.detail === 'string' ? data.detail : response.status === 422 ? '请检查输入内容和文件格式' : '操作失败，请重试';
    throw new ApiError(message, response.status);
  }
  return response.json();
}
export function uploadApi<T>(path: string, file: File, progress: (percent: number) => void, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) { reject(new ApiError('上传已取消', 0)); return; }
    xhr.open('PUT', '/api/manage' + path);
    xhr.withCredentials = true;
    xhr.timeout = 20 * 60 * 1000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-CSRF-Token', csrf);
    xhr.upload.onprogress = (event) => progress(Math.min(100, Math.floor(event.loaded * 100 / (event.total || file.size))));
    xhr.onload = () => {
      cleanup();
      let data: unknown;
      try { data = JSON.parse(xhr.responseText); } catch { reject(new ApiError('服务器响应无效，请重新进入客户端版本页确认发布状态', xhr.status)); return; }
      if (xhr.status < 200 || xhr.status >= 300) {
        if (xhr.status === 401) window.dispatchEvent(new Event('mollytime:unauthorized'));
        const detail = (data as { detail?: unknown })?.detail;
        reject(new ApiError(typeof detail === 'string' ? detail : '安装包上传失败，请重试', xhr.status));
      } else resolve(data as T);
    };
    xhr.onerror = xhr.ontimeout = () => { cleanup(); reject(new ApiError('上传未完成，请重新进入客户端版本页确认发布状态后重试', 0)); };
    xhr.onabort = () => { cleanup(); reject(new ApiError('上传已取消', 0)); };
    signal.addEventListener('abort', abort, { once: true });
    xhr.send(file);
  });
}
export const bytes = (value: number) => value >= 1024**3 ? `${(value / 1024**3).toFixed(1)} GB` : `${(value / 1024**2).toFixed(1)} MB`;
export const minutes = (value: number) => value < 60000 ? `${Math.round(value / 1000)} 秒` : `${(value / 60000).toFixed(1)} 分钟`;
export const dateTime = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未同步';
