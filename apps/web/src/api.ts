export type Session = { user: { id: string; name: string; role: string; email: string | null; accountId: string }; family: { id: string; name: string }; csrfToken: string };
export type Resource = { id: string; name: string; type: 'Series' | 'Season' | 'Episode'; ancestors?: { id: string; name: string; type: 'Series' | 'Season' }[]; parentId: string | null; overview: string; indexNumber: number | null; status: string; hiddenByFolder?: { id: string; name: string } | null; ready: boolean; shared?: boolean; legacy: boolean; runtimeMs: number; imageUrl: string; imagePreviewUrl?: string | null; hasOwnPreview?: boolean; files: { id: string; name: string; kind: string; size: number; language: string; storage: string; version: string; isDefault: boolean; offsetMs: number }[] };
export type Page<T> = { items: T[]; page: number; pageSize: number; total: number };
export type ResourceOption = Pick<Resource, 'id' | 'name' | 'type' | 'status'>;
export type Upload = { id: string; itemId: string; filename: string; size: number; offset: number; status: string; fingerprint: string; kind: string; error: string; taskId: string | null; taskStatus: string | null; transport?: 'local' | 'oss'; partSize?: number; expiresAt?: string | null };
export type WatchDeviceSegment = { deviceId: string | null; playedMs: number };
export type WatchReport = { devices?: { id: string | null; name: string }[]; timezone: string; totalPlayedMs: number; episodeCount: number; statisticsSince: string | null; lastSync: string | null; days: { date: string; playedMs: number; devices?: WatchDeviceSegment[] }[]; hours: { hour: number; playedMs: number; devices?: WatchDeviceSegment[] }[]; contents: { id: string; name: string; playedMs: number }[]; sessions: { id: string; name: string; childName: string; deviceName: string; startedAt: string; playedMs: number; positionMs: number; ended: boolean; lastSync: string | null }[] };
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
let csrf = '';
export function setSession(session: Session | undefined) { csrf = session?.csrfToken || ''; }
export async function api<T>(path: string, method = 'GET', body?: unknown, extraHeaders?: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const raw = body instanceof Blob;
  const requestCsrf = csrf;
  let response: Response;
  try { response = await fetch('/api/manage' + path, { method, signal, credentials: 'same-origin',
    headers: { ...(raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }), 'X-CSRF-Token': requestCsrf, ...extraHeaders },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(navigator.onLine ? '连接中断，请检查网络后重试' : '网络已断开，恢复连接后可重试', 0);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && requestCsrf && requestCsrf === csrf) window.dispatchEvent(new Event('mollytime:unauthorized'));
    const message = typeof data.detail === 'string' ? data.detail : response.status === 422 ? '请检查输入内容和文件格式' : '操作失败，请重试';
    throw new ApiError(message, response.status);
  }
  return response.json();
}
export const bytes = (value: number) => value >= 1024**3 ? `${(value / 1024**3).toFixed(1)} GB` : `${(value / 1024**2).toFixed(1)} MB`;
export const minutes = (value: number) => value < 60000 ? `${Math.round(value / 1000)} 秒` : `${(value / 60000).toFixed(1)} 分钟`;
export const dateTime = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未同步';
