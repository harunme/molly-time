export type Capabilities = { bridgeVersion: number; authenticated: boolean; childId: string; nativePlayback: boolean };
export type Child = { id: string; name: string };
export type Series = { id: string; name: string; type?: 'episode'; episodeCount?: number; runtimeMs?: number; overview?: string; image?: { url: string } };
export type Season = { id: string; name: string; indexNumber?: number; episodeCount?: number };
export type Episode = { id: string; name: string; runtimeMs?: number; image?: { url: string } };
export type Home = { rows: { title: string; items: Series[] }[] };
export class ApiError extends Error { constructor(message: string, public status = 0) { super(message); } }

type NativePort = { postMessage: (message: string) => void; onmessage?: (event: MessageEvent<string>) => void };
declare global {
  interface Window { MollyBridge?: NativePort; mollyBack?: () => boolean }
}
const pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let counter = 0;
const port = window.MollyBridge;
if (port) port.onmessage = (event) => {
  const response = JSON.parse(event.data);
  const request = pending.get(response.id);
  if (!request) return;
  pending.delete(response.id);
  clearTimeout(request.timer);
  if (response.error) request.reject(new ApiError(response.error.message, response.error.status));
  else request.resolve(response.result);
};

export function call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!port) return browserCall(method, args) as Promise<T>;
  if (pending.size >= 24) return Promise.reject(new ApiError('请求过多，请稍后重试'));
  return new Promise((resolve, reject) => {
    const id = `web-${++counter}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new ApiError('连接超时，请重试')); }, 35000);
    pending.set(id, { resolve: (data) => resolve(data as T), reject, timer });
    port.postMessage(JSON.stringify({ id, method, args }));
  });
}
export const request = <T>(path: string, method = 'GET', body?: Record<string, unknown>) =>
  call<T>('request', { path, method, body, ...(path === '/api/home' ? { homeSchemaVersion: 2 } : {}) });

// Browser preview uses an in-memory session. Native TV credentials never enter JS.
let access = '', refresh = '';
let selectedChild = '';
let refreshInFlight: Promise<void> | undefined;
async function fetchApi(path: string, method = 'GET', body?: unknown, retry = true): Promise<unknown> {
  const response = await fetch(path, {
    method, headers: { 'Content-Type': 'application/json', 'X-Molly-Home-Schema': '2', ...(selectedChild ? { 'X-Molly-Child': selectedChild } : {}), ...(access ? { Authorization: `Bearer ${access}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && retry && refresh && !path.startsWith('/api/auth/')) {
    refreshInFlight ??= fetchApi('/api/auth/refresh', 'POST', { refreshToken: refresh }, false)
      .then((data) => { const auth = data as { accessToken: string; refreshToken: string }; access = auth.accessToken; refresh = auth.refreshToken; })
      .finally(() => { refreshInFlight = undefined; });
    await refreshInFlight;
    return fetchApi(path, method, body, false);
  }
  if (!response.ok) throw new ApiError(response.status === 401 ? '请检查账号密码，或重新登录' : '媒体库请求失败，请重试', response.status);
  return response.json();
}
async function browserCall(method: string, args: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'getCapabilities': return { bridgeVersion: 1, authenticated: !!access, childId: '', nativePlayback: false };
    case 'ready': return { ok: true };
    case 'login': {
      const result = await fetchApi('/api/auth/login', 'POST', args) as { accessToken: string; refreshToken: string; user: unknown };
      access = result.accessToken; refresh = result.refreshToken; return result.user;
    }
    case 'logout': {
      const token = refresh; access = ''; refresh = ''; selectedChild = '';
      if (token) await fetchApi('/api/auth/logout', 'POST', { refreshToken: token });
      return { ok: true };
    }
    case 'request': {
      const result = await fetchApi(String(args.path), String(args.method), args.body);
      const match = /^\/api\/children\/([A-Za-z0-9-]+)\/select$/.exec(String(args.path));
      if (match) selectedChild = match[1];
      return result;
    }
    case 'connection': throw new ApiError('请在电视客户端中修改媒体库连接');
    default: throw new ApiError('浏览器仅供预览，请在电视客户端播放');
  }
}
export async function imageSource(path: string, width = 480): Promise<string> {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin || !/^\/api\/items\/[A-Za-z0-9-]+\/image$/.test(url.pathname)) throw new ApiError('封面地址无效');
  const version = url.searchParams.get('v');
  url.search = `?w=${width === 960 ? 960 : 480}`;
  if (version && /^[A-Za-z0-9-]{1,64}$/.test(version)) url.searchParams.set('v', version);
  if (port) return url.toString();
  const result = await fetch(url, { headers: { Authorization: `Bearer ${access}` } });
  if (!result.ok) throw new ApiError('封面暂不可用');
  return URL.createObjectURL(await result.blob());
}
