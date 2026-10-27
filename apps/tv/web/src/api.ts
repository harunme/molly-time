import { demoCall, demoEnabled, demoImage, demoRequest } from './demo';
export type Capabilities = { bridgeVersion: number; authenticated: boolean; childId: string; nativePlayback: boolean; liveTv?: boolean; serverUrl?: string; webVersion?: string; devicePairing?: boolean; devicePairingReset?: boolean; clientUpdates?: boolean; shellVersion?: string; catalogSync?: boolean; offlinePlayback?: boolean; watchControl?: boolean };
export type ImageRef = { url: string; directUrl?: string | null };
export type Series = { id: string; name: string; type?: 'episode' | 'folder'; episodeCount?: number; runtimeMs?: number; positionMs?: number; completed?: boolean; offlineAvailable?: boolean; overview?: string; image?: ImageRef };
export type Season = { id: string; name: string; image?: ImageRef; indexNumber?: number; episodeCount?: number };
export type Episode = { id: string; name: string; runtimeMs?: number; positionMs?: number; completed?: boolean; offlineAvailable?: boolean; image?: ImageRef };
export type PageInfo = { page?: number; pageSize?: number; total?: number; hasMore?: boolean };
export type HomeRow = PageInfo & { id?: string; title: string; items: Series[] };
export type Home = { rows: HomeRow[] };
export type PlaylistEpisode = Episode & { seasonName: string };
export type Playlist = PageInfo & { items: Series[]; itemTotal: number; itemsHasMore: boolean; unavailable?: boolean; episodes: PlaylistEpisode[]; episodeId: string | null; hasProgress: boolean; resumeEpisode?: PlaylistEpisode | null };
export class ApiError extends Error { constructor(message: string, public status = 0, public retryAfter?: number) { super(message); } }

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
  call<T>('request', { path, method, body, ...(path.split('?')[0] === '/api/home' ? { homeSchemaVersion: 2 } : {}) });

// Browser TV bindings persist for this origin. Native TV credentials never enter JS.
let access = '', refresh = '', deviceId = '';
let pairingCode = '';
let pairingAttempt = 0;
type BrowserPairing = { deviceCode: string; userCode: string; verificationUri: string; verificationUriManual: string; expiresAt: string; interval: number };
const pairingKey = 'mollytime.tv.pairing.v1';
const pairingRetryKey = 'mollytime.tv.pairing.retryAt.v1';
let browserPairing: BrowserPairing | undefined;
let pairingRetryAt = 0;
function clearPairing() {
  browserPairing = undefined; pairingCode = '';
  try { sessionStorage.removeItem(pairingKey); } catch { /* Keep working without browser storage. */ }
}
function readPairing() {
  try { browserPairing ??= JSON.parse(sessionStorage.getItem(pairingKey) || 'null') ?? undefined; } catch { /* Ignore unavailable or malformed storage. */ }
  const value = browserPairing;
  if (value && typeof value.deviceCode === 'string' && value.deviceCode.length >= 32 && /^[0-9]{4}$/.test(value.userCode)
    && typeof value.verificationUri === 'string' && typeof value.verificationUriManual === 'string'
    && Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.expiresAt) > Date.now()) return value;
  clearPairing();
}
function publicPairing(value: BrowserPairing) {
  const { deviceCode: _secret, ...result } = value;
  return result;
}
let refreshInFlight: Promise<void> | undefined;
let bindingVersion = 0;
// A browser preview has a tab lifetime rather than an Android boot lifetime.
const browserBoot = (() => {
  if (port || demoEnabled) return undefined;
  const fresh = { id: `browser:${Date.now()}`, startedAt: Date.now() };
  try {
    const saved = JSON.parse(sessionStorage.getItem('mollytime.tv.boot.v1') || 'null');
    if (saved && typeof saved.id === 'string' && Number.isFinite(saved.startedAt)
      && saved.startedAt <= Date.now()) return saved as typeof fresh;
    sessionStorage.setItem('mollytime.tv.boot.v1', JSON.stringify(fresh));
  } catch { /* A restricted browser can still track this page lifetime. */ }
  return fresh;
})();
const bindingKey = 'mollytime.tv.binding.v1';
function saveBinding() {
  localStorage.setItem(bindingKey, JSON.stringify({ accessToken: access, refreshToken: refresh, deviceId }));
}
function clearBinding() {
  bindingVersion++;
  access = ''; refresh = ''; deviceId = '';
  try { localStorage.removeItem(bindingKey); } catch { /* Storage can be unavailable in a restricted browser. */ }
}
if (!port && !demoEnabled) {
  try {
    const saved = JSON.parse(localStorage.getItem(bindingKey) || 'null');
    if (saved && typeof saved.refreshToken === 'string' && typeof saved.accessToken === 'string' && typeof saved.deviceId === 'string') {
      access = saved.accessToken; refresh = saved.refreshToken; deviceId = saved.deviceId;
    }
  } catch { clearBinding(); }
}

async function fetchApi(path: string, method = 'GET', body?: unknown, retry = true): Promise<unknown> {
  const version = bindingVersion;
  const response = await fetch(path, {
    method, headers: { 'Content-Type': 'application/json', 'X-Molly-Home-Schema': '2', ...(access ? { Authorization: `Bearer ${access}` } : {}),
      ...(path === '/api/me' && browserBoot ? { 'X-Molly-Boot-Id': browserBoot.id,
        'X-Molly-Boot-Elapsed-Ms': String(Math.max(0, Date.now() - browserBoot.startedAt)) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (version !== bindingVersion) throw new ApiError('请求已取消');
  if (response.status === 401 && retry && refresh && !path.startsWith('/api/auth/') && path !== '/api/watch-control') {
    refreshInFlight ??= fetchApi('/api/auth/refresh', 'POST', { refreshToken: refresh }, false)
      .then((data) => { if (version !== bindingVersion) throw new ApiError('请求已取消'); const auth = data as { accessToken: string; refreshToken: string }; access = auth.accessToken; refresh = auth.refreshToken; saveBinding(); })
      .finally(() => { refreshInFlight = undefined; });
    await refreshInFlight;
    return fetchApi(path, method, body, false);
  }
  // Optional capability discovery must not revoke a binding when an older API lacks it.
  if (response.status === 401 && path !== '/api/watch-control') clearBinding();
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const retryAfter = Number(response.headers.get('Retry-After'));
    throw new ApiError(response.status === 401 ? '电视授权已失效，请重新扫码绑定' : typeof data.detail === 'string' ? data.detail : '媒体库请求失败，请重试', response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
  }
  const result = await response.json();
  if (version !== bindingVersion) throw new ApiError('请求已取消');
  return result;
}
async function browserCall(method: string, args: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'getCapabilities': return { bridgeVersion: 1, serverUrl: location.origin, authenticated: !!refresh, childId: '', nativePlayback: false, devicePairing: true, devicePairingReset: true };
    case 'ready': return { ok: true };
    case 'pairingStart': {
      const cached = readPairing();
      if (!args.force && cached) { pairingCode = cached.deviceCode; return publicPairing(cached); }
      try { pairingRetryAt = Math.max(pairingRetryAt, Number(sessionStorage.getItem(pairingRetryKey)) || 0); } catch { /* Memory still prevents repeat requests. */ }
      if (Number.isFinite(pairingRetryAt) && pairingRetryAt > Date.now()) {
        throw new ApiError('生成配对码过于频繁，请稍后再试', 429, Math.ceil((pairingRetryAt - Date.now()) / 1000));
      }
      const attempt = ++pairingAttempt;
      const previous = pairingCode; pairingCode = '';
      if (previous) await fetchApi('/api/auth/pairing/cancel', 'POST', { deviceCode: previous });
      clearPairing();
      let result: BrowserPairing;
      try { result = await fetchApi('/api/auth/pairing/start', 'POST', { name: 'MollyTime TV' }) as BrowserPairing; }
      catch (failure) {
        if (failure instanceof ApiError && failure.status === 429 && failure.retryAfter) {
          pairingRetryAt = Date.now() + failure.retryAfter * 1000;
          try { sessionStorage.setItem(pairingRetryKey, String(pairingRetryAt)); } catch { /* Memory still prevents repeat requests. */ }
        }
        throw failure;
      }
      if (attempt !== pairingAttempt) {
        void fetchApi('/api/auth/pairing/cancel', 'POST', { deviceCode: result.deviceCode }).catch(() => {});
        throw new ApiError('配对已取消');
      }
      pairingCode = result.deviceCode; browserPairing = result; pairingRetryAt = 0;
      try { sessionStorage.setItem(pairingKey, JSON.stringify(result)); sessionStorage.removeItem(pairingRetryKey); } catch { /* The current page can still complete pairing. */ }
      return publicPairing(result);
    }
    case 'pairingPoll': {
      if (!pairingCode) throw new ApiError('请重新生成配对码');
      const code = pairingCode;
      const result = await fetchApi('/api/auth/pairing/poll', 'POST', { deviceCode: code }) as { status: string; auth?: { accessToken: string; refreshToken: string; deviceId: string } };
      if (code !== pairingCode) throw new ApiError('配对已取消');
      if (result.status === 'authorized' && result.auth) {
        bindingVersion++;
        access = result.auth.accessToken; refresh = result.auth.refreshToken; deviceId = result.auth.deviceId; saveBinding(); clearPairing();
      }
      if (result.status === 'expired') clearPairing();
      delete result.auth;
      return result;
    }
    case 'pairingCancel': {
      pairingAttempt++;
      const code = pairingCode; clearPairing();
      if (code) await fetchApi('/api/auth/pairing/cancel', 'POST', { deviceCode: code });
      return { ok: true };
    }
    case 'pairingReset': {
      try { await fetchApi('/api/auth/pairing/reset', 'POST', {}); }
      catch (failure) { if (!(failure instanceof ApiError && failure.status === 401)) throw failure; }
      clearBinding();
      clearPairing();
      return { ok: true };
    }
    case 'request': {
      const result = await fetchApi(String(args.path), String(args.method), args.body);
      return result;
    }
    case 'playEpisode': window.dispatchEvent(new CustomEvent('molly:browserPlay', { detail: args })); return { ok: true };
    default: throw new ApiError('浏览器仅供预览，请在电视客户端播放');
  }
}
export async function imageSource(path: string, width = 480, directUrl?: string | null): Promise<string> {
  if (demoEnabled) return demoImage(path);
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin || !/^\/api\/items\/[A-Za-z0-9-]+\/image$/.test(url.pathname)) throw new ApiError('封面地址无效');
  if (directUrl) {
    try {
      const remote = new URL(directUrl);
      if (remote.protocol === 'https:' && !remote.port && !remote.username && !remote.password
        && /^[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/i.test(remote.hostname)
        && remote.searchParams.has('OSSAccessKeyId') && remote.searchParams.has('Signature') && remote.searchParams.has('Expires')) return remote.toString();
    } catch { /* Fall back to the authenticated image endpoint. */ }
  }
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
  return fetchApi(path, method, body) as Promise<T>;
};
export function browserMediaUrl(path: string): string {
  const url = new URL(path, location.origin);
  // A token is needed by HTML video/track, and is never sent to an external origin.
  if (url.origin === location.origin) url.searchParams.set('token', access);
  return url.toString();
}
