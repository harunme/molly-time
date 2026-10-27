import { useEffect, useState } from 'react';
import { ApiError, call, type Capabilities } from './api';
import { FocusButton } from './focus';
import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { toDataURL } from 'qrcode';

type Pairing = { userCode: string; verificationUri: string; verificationUriManual: string; expiresAt: string; interval: number };
export function PairingPanel({ capabilities, done }: { capabilities?: Capabilities; done: () => void }) {
  const [pairing, setPairing] = useState<Pairing>();
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [attempt, retry] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [qr, setQr] = useState<{ uri: string; src: string }>();
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
  useEffect(() => {
    let alive = true;
    setQr(undefined);
    if (pairing?.verificationUri) {
      const uri = pairing.verificationUri;
      try {
        const url = new URL(uri, capabilities?.serverUrl || location.origin);
        if (url.protocol === 'https:' || url.protocol === 'http:') {
          void toDataURL(url.href, { width: 480, margin: 4, errorCorrectionLevel: 'M' })
            .then(value => { if (alive) setQr({ uri, src: value }); }).catch(() => {});
        }
      } catch { /* The public code remains usable without a QR link. */ }
    }
    return () => { alive = false; };
  }, [pairing, capabilities?.serverUrl]);
  const seconds = pairing ? Math.max(0, Math.ceil((Date.parse(pairing.expiresAt) - now) / 1000)) : 0;
  const isExpired = expired || (!!pairing && seconds === 0);
  return <div className="pairing-panel">
    <div className="pairing-explanation"><h1>用手机绑定电视</h1>
      <p>把你选好的故事，带到电视上。</p>
      <ol><li>用手机扫描右侧二维码，打开家长后台。</li><li>登录家庭管理员账号，确认绑定这台电视。</li><li>绑定后，电视会自动进入内容页。</li></ol>
      <p className="pairing-alternative">也可以在家长后台点击「绑定电视」，输入右侧四位配对码。</p>
    </div>
    <div className="pairing-credentials">
      {pairing && !isExpired ? <>
        {qr && qr.uri === pairing.verificationUri ? <img className="pairing-qr" src={qr.src} alt="电视绑定二维码" /> : <div className="pairing-qr-fallback"><p>请在家长后台输入配对码</p></div>}
        <p className="pairing-code" aria-label="配对码">{pairing.userCode}</p>
        {pairing.verificationUriManual && <p className="pairing-manual">{pairing.verificationUriManual}</p>}
        <p className="pairing-status" role="status">等待家长确认 · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</p>
      </> : isExpired ? <div className="pairing-qr-fallback"><p role="status">配对码已过期，请重新生成</p></div> : !error ? <div className="pairing-qr-fallback"><p role="status">正在生成配对码…</p></div> : null}
      {error && <p role="alert" className="error">{error}</p>}
      {(!window.MollyBridge || capabilities?.devicePairing) && <FocusButton focusKey="pairing-refresh" className="text-button" onClick={() => retry((value) => value + 1)}>{isExpired || !pairing ? '重新生成配对码' : '刷新配对码'}</FocusButton>}
    </div>
  </div>;
}
