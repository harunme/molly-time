import { useEffect, useState } from 'react';
import { api, type Session } from './api';

type Pending = { name: string; expiresAt: string };
export function PairingPage({ initialCode, session, close }: { initialCode: string; session: Session; close: () => void }) {
  const [code, setCode] = useState(initialCode), [selected, setSelected] = useState('');
  const [pending, setPending] = useState<Pending>(), [name, setName] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmed, setConfirmed] = useState(false);
  const admin = ['admin', 'superadmin'].includes(session.user.role);
  const lookup = async (value: string) => {
    setBusy(true); setError(''); setPending(undefined);
    try {
      const data = await api<Pending>(`/pairing/${encodeURIComponent(value.trim())}`);
      setSelected(value.trim()); setPending(data); setName(data.name);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '配对码无效'); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (initialCode && admin) void lookup(initialCode); }, [initialCode, admin]);
  const confirm = async () => {
    setBusy(true); setError('');
    try { await api('/pairing/confirm', 'POST', { code: selected, name: name.trim() }); setConfirmed(true); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '绑定失败，请重试'); }
    finally { setBusy(false); }
  };
  return <main className="pairing-page"><section className="pairing-card">
    <div className="wordmark">MollyTime</div>
    <h1>{confirmed ? '已确认绑定' : '绑定电视'}</h1>
    {confirmed ? <><p role="status">电视正在连接「{session.family.name}」，无需在遥控器上输入密码。</p><button className="primary" onClick={close}>返回管理后台</button></> : !admin ? <><p role="alert">绑定电视需要家庭管理员账号。</p><button onClick={close}>返回管理后台</button></> : <>
      <p>只确认你正在操作的电视。配对码应与电视屏幕一致。</p>
      {!pending ? <form onSubmit={(event) => { event.preventDefault(); void lookup(code); }}>
        <label>电视配对码<input autoComplete="off" autoCapitalize="characters" spellCheck={false} value={code} maxLength={16} onChange={(event) => setCode(event.target.value.toUpperCase())} required /></label>
        <button className="primary" disabled={busy || !code.trim()}>{busy ? '正在查找…' : '查看电视'}</button>
      </form> : <form onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
        <div className="pairing-summary"><span>配对码</span><strong>{selected}</strong><span>绑定到</span><strong>{session.family.name}</strong></div>
        <label>电视名称<input value={name} maxLength={128} onChange={(event) => setName(event.target.value)} required /></label>
        <button className="primary" disabled={busy}>{busy ? '正在绑定…' : '确认绑定这台电视'}</button>
        <button type="button" className="quiet" disabled={busy} onClick={() => { setPending(undefined); setError(''); }}>输入其他配对码</button>
      </form>}
      {error && <p role="alert" className="error">{error}</p>}
      <button className="quiet" disabled={busy} onClick={close}>取消</button>
    </>}
  </section></main>;
}
