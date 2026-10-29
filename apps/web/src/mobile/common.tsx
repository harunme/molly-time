import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { api } from '../api';
import { useRevalidation } from '../lifecycle';

export function useMobileData<T>(path: string, serial = 0, interval = 0) {
  const revision = useRevalidation();
  const [result, setData] = useState<{ path: string; value: T }>(), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let reading = false; setError('');
    if (!path) return () => controller.abort();
    const read = async () => {
      if (reading) return;
      reading = true;
      try { const value = await api<T>(path, 'GET', undefined, undefined, controller.signal); if (!controller.signal.aborted) { setData({ path, value }); setError(''); } }
      catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
      finally { reading = false; }
    };
    void read();
    const timer = interval ? setInterval(() => { if (!document.hidden && navigator.onLine) void read(); }, interval) : undefined;
    return () => { controller.abort(); if (timer) clearInterval(timer); };
  }, [path, serial, revision, interval]);
  return { data: result?.path === path ? result.value : undefined, error };
}
export function MobileError({ message }: { message?: string }) { return message ? <p className="m-error" role="alert">{message}</p> : null; }
export function MobileTitle({ title, subtitle, back, action }: { title: string; subtitle?: string; back?: string; action?: ReactNode }) {
  return <header className="m-title">{back && <Link className="m-back" to={back}><ArrowLeft size={20} /><span>返回</span></Link>}<div className="m-title-line"><div>{subtitle && <p>{subtitle}</p>}<h1>{title}</h1></div>{action}</div></header>;
}
