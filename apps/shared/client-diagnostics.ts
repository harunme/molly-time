/** No exception messages, request bodies, tokens, or query strings enter diagnostics. */
export type ClientSource = 'web-parent' | 'tv-web';
export type ClientDiagnostic = {
  id: string; installationId: string; source: ClientSource; code: string; fatal: boolean;
  errorType: string; stack: string[]; breadcrumbs: { name: string; at: string }[];
  screen: string; appVersion: string; osVersion: string; deviceModel: string; occurredAt: string;
};
type Row = { owner: string; body: ClientDiagnostic };
type Sender = (body: ClientDiagnostic, signal: AbortSignal) => Promise<'ack' | 'drop' | 'retry'>;
declare const __MOLLY_BUILD_VERSION__: string;

function uuid() {
  const bytes = new Uint8Array(16);
  try { globalThis.crypto.getRandomValues(bytes); }
  catch { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function diagnosticStack(stack: string | undefined): string[] {
  return (stack ?? '').split('\n').filter((line) => /^\s*at\s|@.*:\d/.test(line))
    .slice(0, 64).map((line) => line
      .replace(/https?:\/\/[^\s)]+/gi, (url) => {
        try { const path = new URL(url).pathname; return path.substring(path.lastIndexOf('/') + 1); }
        catch { return '[url]'; }
      })
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
      .replace(/\?[^\s)]*/g, '').trim().slice(0, 300));
}

function browserSystem() {
  const ua = navigator.userAgent;
  const system = ua.match(/Android [\d.]+|(?:iPhone|CPU) OS [\d_]+|Mac OS X [\d_]+|Windows NT [\d.]+|Linux/)?.[0] ?? navigator.platform;
  const browser = ua.match(/(?:Edg|Firefox|Chrome|Version)\/[\d.]+/)?.[0] ?? 'WebView';
  return `${system.replace(/_/g, '.')} · ${browser}`.slice(0, 128);
}

export function createClientDiagnostics(source: ClientSource) {
  const key = `mollytime.diagnostics.${source}.v1`;
  let installation = uuid();
  let rows: Row[] = [];
  try {
    const savedID = localStorage.getItem(`${key}.installation`);
    if (savedID && /^[a-f0-9-]{36}$/i.test(savedID)) installation = savedID;
    localStorage.setItem(`${key}.installation`, installation);
    const saved = localStorage.getItem(key) || '[]';
    const parsed: unknown = saved.length <= 1_024_000 ? JSON.parse(saved) : [];
    if (Array.isArray(parsed)) rows = parsed.filter((row): row is Row =>
      row && typeof row.owner === 'string' && typeof row.body?.id === 'string'
      && Date.parse(row.body.occurredAt) > Date.now() - 30 * 86400_000).slice(-32);
  } catch { /* Sandboxed browsers retain the current page's queue in memory. */ }
  let owner = '', screen = 'startup', sender: Sender | undefined, flushing = false, retryAt = 0;
  try { owner = localStorage.getItem(`${key}.owner`) || ''; } catch { /* No persisted attribution. */ }
  let breadcrumbs: ClientDiagnostic['breadcrumbs'] = [];
  let last = '', lastAt = 0;
  const save = () => { try { localStorage.setItem(key, JSON.stringify(rows)); } catch { /* Best effort. */ } };
  async function flush() {
    if (!owner || !sender || flushing || Date.now() < retryAt) return;
    flushing = true;
    const expectedOwner = owner, send = sender;
    try {
      for (const row of rows.filter((row) => row.owner === expectedOwner).slice(0, 10)) {
        if (owner !== expectedOwner) break;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12_000);
        let outcome: 'ack' | 'drop' | 'retry' = 'retry';
        try {
          outcome = await Promise.race([send(row.body, controller.signal), new Promise<'retry'>((resolve) => {
            controller.signal.addEventListener('abort', () => resolve('retry'), { once: true });
          })]);
        } catch { /* Never report reporter failures. */ }
        finally { clearTimeout(timer); }
        if (outcome === 'retry') { retryAt = Date.now() + 60_000; break; }
        rows = rows.filter((value) => value.body.id !== row.body.id); save();
      }
    } finally { flushing = false; }
  }
  function breadcrumb(name: string) {
    if (!/^[A-Za-z0-9_.:/-]{1,80}$/.test(name)) return;
    breadcrumbs = [...breadcrumbs.slice(-19), { name, at: new Date().toISOString() }];
  }
  function capture(error: unknown, code = 'JS_UNHANDLED', fatal = false, componentStack?: string) {
    // A signed-out page never sends another account's pending diagnostics.
    if (!owner) return;
    try {
      const type = error instanceof Error ? error.name : 'NonErrorRejection';
      const stack = diagnosticStack(error instanceof Error ? error.stack : undefined);
      if (componentStack) stack.push(...diagnosticStack(componentStack));
      const signature = `${code}|${type}|${stack.slice(0, 3).join('|')}`;
      if (signature === last && Date.now() - lastAt < 30_000) return;
      last = signature; lastAt = Date.now();
      rows.push({ owner, body: {
        id: uuid(), installationId: installation, source, code, fatal,
        errorType: /^[A-Za-z_$][A-Za-z0-9_.$:-]{0,127}$/.test(type) ? type : 'Error',
        stack: stack.slice(0, 64), breadcrumbs: [...breadcrumbs], screen,
        appVersion: typeof __MOLLY_BUILD_VERSION__ === 'string' ? __MOLLY_BUILD_VERSION__ : 'development',
        osVersion: browserSystem(), deviceModel: navigator.platform.slice(0, 128),
        occurredAt: new Date().toISOString(),
      } });
      if (rows.length > 32) { const disposable = rows.findIndex((row) => !row.body.fatal); rows.splice(disposable < 0 ? 0 : disposable, 1); }
      save(); void flush();
    } catch { /* Reporting cannot break an application error handler. */ }
  }
  window.addEventListener('error', (event) => {
    if (event instanceof ErrorEvent) capture(event.error ?? new Error(), 'JS_UNCAUGHT', true);
  });
  window.addEventListener('unhandledrejection', (event) => capture(event.reason, 'JS_UNHANDLED_REJECTION', true));
  window.addEventListener('online', () => { retryAt = 0; void flush(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void flush(); });
  setInterval(() => { if (!document.hidden) void flush(); }, 60_000);
  return {
    capture, breadcrumb, flush,
    screen(name: string) { if (/^[A-Za-z0-9_.:/-]{1,80}$/.test(name)) { screen = name; breadcrumb(`screen:${name}`); } },
    bind(nextOwner: string, send?: Sender) {
      if (owner !== nextOwner) { breadcrumbs = []; screen = 'startup'; last = ''; }
      owner = nextOwner; sender = send; retryAt = 0; void flush();
      try { localStorage.setItem(`${key}.owner`, owner); } catch { /* Best effort. */ }
    },
  };
}
