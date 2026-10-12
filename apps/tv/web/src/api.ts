import { demoCall, demoEnabled, demoImage, demoRequest } from './demo';
export type Capabilities = { bridgeVersion: number; authenticated: boolean; childId: string; nativePlayback: boolean; devicePairing?: boolean; devicePairingReset?: boolean };
export type Child = { id: string; name: string };
export type Series = { id: string; name: string; type?: 'episode'; episodeCount?: number; runtimeMs?: number; positionMs?: number; completed?: boolean; overview?: string; image?: { url: string } };
export type Season = { id: string; name: string; image?: { url: string }; indexNumber?: number; episodeCount?: number };
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
  if (demoEnabled) return Promise.resolve().then(() => demoCall(method, args) as T);
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

// Browser TV bindings persist for this origin. Native TV credentials never enter JS.
let access = '', refresh = '', deviceId = '';
let selectedChild = '';
let pairingCode = '';
let pairingAttempt = 0;
let refreshInFlight: Promise<void> | undefined;
let bindingVersion = 0;
const bindingKey = 'mollytime.tv.binding.v1';
function saveBinding() {
  localStorage.setItem(bindingKey, JSON.stringify({ accessToken: access, refreshToken: refresh, deviceId, childId: selectedChild }));
}
function clearBinding() {
  bindingVersion++;
  access = ''; refresh = ''; deviceId = ''; selectedChild = '';
  try { localStorage.removeItem(bindingKey); } catch { /* Storage can be unavailable in a restricted browser. */ }
}
if (!port && !demoEnabled) {
  try {
    const saved = JSON.parse(localStorage.getItem(bindingKey) || 'null');
    if (saved && typeof saved.refreshToken === 'string' && typeof saved.accessToken === 'string' && typeof saved.deviceId === 'string') {
      access = saved.accessToken; refresh = saved.refreshToken; deviceId = saved.deviceId;
      selectedChild = typeof saved.childId === 'string' ? saved.childId : '';
    }
  } catch { clearBinding(); }
}

async function fetchApi(path: string, method = 'GET', body?: unknown, retry = true): Promise<unknown> {
  const version = bindingVersion;
  const response = await fetch(path, {
    method, headers: { 'Content-Type': 'application/json', 'X-Molly-Home-Schema': '2', ...(selectedChild ? { 'X-Molly-Child': selectedChild } : {}), ...(access ? { Authorization: `Bearer ${access}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (version !== bindingVersion) throw new ApiError('请求已取消');
  if (response.status === 401 && retry && refresh && !path.startsWith('/api/auth/')) {
    refreshInFlight ??= fetchApi('/api/auth/refresh', 'POST', { refreshToken: refresh }, false)
      .then((data) => { if (version !== bindingVersion) throw new ApiError('请求已取消'); const auth = data as { accessToken: string; refreshToken: string }; access = auth.accessToken; refresh = auth.refreshToken; saveBinding(); })
      .finally(() => { refreshInFlight = undefined; });
    await refreshInFlight;
    return fetchApi(path, method, body, false);
  }
  if (response.status === 401) clearBinding();
  if (!response.ok) throw new ApiError(response.status === 401 ? '电视授权已失效，请重新扫码绑定' : '媒体库请求失败，请重试', response.status);
  const result = await response.json();
  if (version !== bindingVersion) throw new ApiError('请求已取消');
  return result;
}
async function browserCall(method: string, args: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'getCapabilities': return { bridgeVersion: 1, authenticated: !!refresh, childId: selectedChild, nativePlayback: false, devicePairing: true, devicePairingReset: true };
    case 'ready': return { ok: true };
    case 'pairingStart': {
      const attempt = ++pairingAttempt;
      const previous = pairingCode; pairingCode = '';
      if (previous) await fetchApi('/api/auth/pairing/cancel', 'POST', { deviceCode: previous });
      const result = await fetchApi('/api/auth/pairing/start', 'POST', { name: 'MollyTime TV' }) as Record<string, unknown>;
      if (attempt !== pairingAttempt) {
        void fetchApi('/api/auth/pairing/cancel', 'POST', { deviceCode: result.deviceCode }).catch(() => {});
        throw new ApiError('配对已取消');
      }
      pairingCode = String(result.deviceCode); delete result.deviceCode;
      return result;
    }
    case 'pairingPoll': {
      if (!pairingCode) throw new ApiError('请重新生成配对码');
      const code = pairingCode;
      const result = await fetchApi('/api/auth/pairing/poll', 'POST', { deviceCode: code }) as { status: string; auth?: { accessToken: string; refreshToken: string; deviceId: string } };
      if (code !== pairingCode) throw new ApiError('配对已取消');
      if (result.status === 'authorized' && result.auth) {
        bindingVersion++;
        access = result.auth.accessToken; refresh = result.auth.refreshToken; deviceId = result.auth.deviceId; saveBinding(); pairingCode = '';
      }
      delete result.auth;
      return result;
    }
    case 'pairingCancel': {
      pairingAttempt++;
      const code = pairingCode; pairingCode = '';
      if (code) await fetchApi('/api/auth/pairing/cancel', 'POST', { deviceCode: code });
      return { ok: true };
    }
    case 'pairingReset': {
      try { await fetchApi('/api/auth/pairing/reset', 'POST', {}); }
      catch (failure) { if (!(failure instanceof ApiError && failure.status === 401)) throw failure; }
      clearBinding();
      return { ok: true };
    }
    case 'request': {
      const result = await fetchApi(String(args.path), String(args.method), args.body);
      const match = /^\/api\/children\/([A-Za-z0-9-]+)\/select$/.exec(String(args.path));
      if (match) { selectedChild = match[1]; saveBinding(); }
      return result;
    }
    case 'playEpisode': window.dispatchEvent(new CustomEvent('molly:browserPlay', { detail: args })); return { ok: true };
    case 'connection': throw new ApiError('请在电视客户端中修改媒体库连接');
    default: throw new ApiError('浏览器仅供预览，请在电视客户端播放');
  }
}
export async function imageSource(path: string, width = 480): Promise<string> {
  if (demoEnabled) return demoImage(path);
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


export const browserRequest = <T>(path: string, method = 'GET', body?: unknown) => {
  if (demoEnabled) return Promise.resolve().then(() => demoRequest(path) as T);
  if (port) return Promise.reject(new ApiError('请使用原生播放器')) as Promise<T>;
  if (method === 'POST' && path === '/api/playback/sessions' && selectedChild) {
    body = { ...(body as Record<string, unknown>), childId: selectedChild };
  }
  if (method === 'GET' && /\/progress$/.test(path) && selectedChild) path += `?childId=${encodeURIComponent(selectedChild)}`;
  return fetchApi(path, method, body) as Promise<T>;
};
export function browserMediaUrl(path: string): string {
  const url = new URL(path, location.origin);
  // A token is needed by HTML video/track, and is never sent to an external origin.
  if (url.origin === location.origin) url.searchParams.set('token', access);
  return url.toString();
}
