import { useEffect, useState } from 'react';
import { ApiError, call, type Capabilities } from './api';
import { FocusButton } from './focus';
import { setFocus } from '@noriginmedia/norigin-spatial-navigation';

type Pairing = { userCode: string; verificationUri: string; verificationUriManual: string; expiresAt: string; interval: number };
export function PairingPanel({ capabilities, done }: { capabilities?: Capabilities; done: () => void }) {
  const [pairing, setPairing] = useState<Pairing>();
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [attempt, retry] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!capabilities) return;
    if (!capabilities.devicePairing) { setError('请先更新电视客户端，再绑定。'); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    setPairing(undefined); setError(''); setExpired(false);
    void call<Pairing>('pairingStart').then((value) => {
      if (!alive) return;
      const deadline = Date.parse(value.expiresAt);
      if (!Number.isFinite(deadline)) throw new Error('配对响应无效，请重试');
      const delay = Math.max(3, Math.min(30, value.interval || 3)) * 1000;
      setPairing(value); setNow(Date.now());
      setFocus('pairing-refresh');
      const poll = async () => {
        if (!alive) return;
        if (Date.now() >= deadline) { setExpired(true); return; }
        try {
          const result = await call<{ status: string }>('pairingPoll');
          if (!alive) return;
          if (result.status === 'authorized') { done(); return; }
          if (result.status === 'expired') { setExpired(true); return; }
          setError('');
        } catch (failure) {
          if (!alive) return;
          if (!(failure instanceof ApiError && failure.status === 429)) setError('暂时无法连接，正在重试…');
        }
        if (alive) timer = setTimeout(() => { void poll(); }, delay);
      };
      timer = setTimeout(() => { void poll(); }, delay);
    }).catch((failure) => { if (alive) setError(failure instanceof Error ? failure.message : '无法生成配对码'); });
    return () => { alive = false; clearTimeout(timer); void call('pairingCancel').catch(() => {}); };
  }, [capabilities, attempt, done]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = pairing ? Math.max(0, Math.ceil((Date.parse(pairing.expiresAt) - now) / 1000)) : 0;
  return <div className="pairing-panel">
    {pairing && !expired ? <>
      <p>在家长后台输入以下配对码</p>
      <p className="pairing-code" aria-label="配对码">{pairing.userCode}</p>
      <p className="pairing-manual">打开家长后台 · 绑定电视</p>
      <p className="pairing-status" role="status">等待家长确认 · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</p>
    </> : expired ? <p role="status">配对码已过期，请重新生成</p> : !error ? <p role="status">正在生成配对码…</p> : null}
    {error && <p role="alert" className="error">{error}</p>}
    {(!window.MollyBridge || capabilities?.devicePairing) && <FocusButton focusKey="pairing-refresh" className="text-button" onClick={() => retry((value) => value + 1)}>{expired || !pairing ? '重新生成配对码' : '刷新配对码'}</FocusButton>}
  </div>;
}
