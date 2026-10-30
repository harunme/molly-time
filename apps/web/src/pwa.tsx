import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Download, WifiOff } from 'lucide-react';
import { Button } from './components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog';
import { hasActiveUploads } from './uploads';

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
let installPrompt: InstallPrompt | undefined;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault(); installPrompt = event as InstallPrompt;
});

export function InstallApp() {
  const [open, setOpen] = useState(false);
  const [installed, setInstalled] = useState(matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone);
  useEffect(() => {
    const done = () => { setInstalled(true); setOpen(false); installPrompt = undefined; };
    window.addEventListener('appinstalled', done);
    return () => window.removeEventListener('appinstalled', done);
  }, []);
  if (installed) return null;
  return <>
    <Button variant="ghost" className="brandbar-tv-link" aria-label="安装应用" title="安装应用" onClick={async () => {
      if (!installPrompt) { setOpen(true); return; }
      const prompt = installPrompt; installPrompt = undefined;
      await prompt.prompt();
      if ((await prompt.userChoice).outcome === 'accepted') setInstalled(true);
    }}><Download className="size-4" /><span>安装应用</span></Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>安装 MollyTime</DialogTitle><DialogDescription>添加到手机主屏幕，下次直接打开。</DialogDescription></DialogHeader>
      <DialogBody><p>iPhone 或 iPad：在 Safari 中打开，点“分享”，再选择“添加到主屏幕”。</p><p className="mt-3">Android：在浏览器菜单中选择“安装应用”或“添加到主屏幕”。</p>
        {!isSecureContext && <p className="mt-3">请通过 HTTPS 地址访问后安装。</p>}
        <p className="mt-3 text-muted-foreground">安装后仍需联网管理媒体；锁屏或关闭应用后，页面内开机提醒和上传可能暂停。</p></DialogBody>
    </DialogContent></Dialog>
  </>;
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return online;
}

export function OfflineStart({ retry }: { retry: () => void }) {
  return <main className="offline-start"><WifiOff size={36} /><h1>暂时无法连接</h1><p>请检查网络。恢复连接后会自动重试，未完成的上传会保留进度。</p><Button onClick={retry}>重新连接</Button></main>;
}

export function PwaStatus() {
  const online = useOnline();
  const standalone = matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone;
  const status = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const measure = () => document.documentElement.style.setProperty('--app-status-height', `${status.current?.offsetHeight ?? 0}px`);
    const observer = new ResizeObserver(measure);
    if (status.current) observer.observe(status.current);
    measure();
    return () => observer.disconnect();
  }, []);
  const [waiting, setWaiting] = useState<ServiceWorker>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !isSecureContext) return;
    let alive = true;
    const activated = () => setWaiting(undefined);
    navigator.serviceWorker.addEventListener('controllerchange', activated);
    void navigator.serviceWorker.register('/manage/sw.js', { scope: '/manage/', updateViaCache: 'none' }).then(registration => {
      const update = () => { if (alive) setWaiting(registration.active && registration.waiting?.state === 'installed' ? registration.waiting : undefined); };
      update();
      registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', update));
    }).catch(() => { /* The online application remains usable when installation is unavailable. */ });
    return () => { alive = false; navigator.serviceWorker.removeEventListener('controllerchange', activated); };
  }, []);
  useEffect(() => {
    if (!waiting || standalone) return;
    const activate = () => {
      if (!hasActiveUploads() && waiting.state === 'installed') waiting.postMessage('ACTIVATE_UPDATE');
    };
    // Browser navigation already fetches fresh HTML. Activate the shell quietly
    // for the next visit, without reloading or interrupting the current page.
    activate();
    window.addEventListener('mollytime:uploads', activate);
    return () => window.removeEventListener('mollytime:uploads', activate);
  }, [waiting, standalone]);
  return <div ref={status} className="app-status">
    {!online && <div className="connection-banner" role="status">网络已断开，恢复连接后自动重试。上传可能暂停。</div>}
    {standalone && waiting && <div className="connection-banner" role="status">新版本已准备好<Button size="sm" disabled={busy} onClick={() => {
      if (hasActiveUploads()) {
        setBusy(true); setTimeout(() => setBusy(false), 2000); return;
      }
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
      waiting.postMessage('ACTIVATE_UPDATE');
    }}>{busy ? '请先暂停上传' : '更新应用'}</Button></div>}
  </div>;
}
