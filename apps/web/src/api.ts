export type Session = { user: { id: string; name: string; role: string }; family: { id: string; name: string }; csrfToken: string };
export type Resource = { id: string; name: string; type: 'Series' | 'Season' | 'Episode'; parentId: string | null; overview: string; indexNumber: number | null; status: string; ready: boolean; legacy: boolean; runtimeMs: number; imageUrl: string; files: { id: string; name: string; kind: string; size: number; language: string }[] };
export type Child = { id: string; name: string };
export type Upload = { id: string; itemId: string; filename: string; size: number; offset: number; status: string; fingerprint: string; kind: string; error: string; taskId: string | null; taskStatus: string | null };
export type Row = { id: string; title: string; source: 'manual' | 'recent' | 'continue'; enabled: boolean; limit: number; itemIds: string[] };
export type Content = { schemaVersion: number; rows: Row[] };
export type Config = { revision: number; content: Content; followingFamily: boolean; publishedId: string | null };
export type Home = { rows: { title: string; items: { id: string; name: string; type?: string; image?: { url: string } }[] }[] };
export type WatchReport = { timezone: string; totalPlayedMs: number; episodeCount: number; statisticsSince: string | null; lastSync: string | null; days: { date: string; playedMs: number }[]; contents: { id: string; name: string; playedMs: number }[]; sessions: { id: string; name: string; childName: string; deviceName: string; startedAt: string; playedMs: number; positionMs: number; ended: boolean; lastSync: string | null }[] };
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
let csrf = '';
export function setSession(session: Session | undefined) { csrf = session?.csrfToken || ''; }
export async function api<T>(path: string, method = 'GET', body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const raw = body instanceof Blob;
  const response = await fetch('/api/manage' + path, { method, credentials: 'same-origin',
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
export function scope(child: string) { return child ? `?childId=${encodeURIComponent(child)}` : ''; }
export const bytes = (value: number) => value >= 1024**3 ? `${(value / 1024**3).toFixed(1)} GB` : `${(value / 1024**2).toFixed(1)} MB`;
export const minutes = (value: number) => value < 60000 ? `${Math.round(value / 1000)} 秒` : `${(value / 60000).toFixed(1)} 分钟`;
export const dateTime = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未同步';
