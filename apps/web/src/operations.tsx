import { useEffect, useState } from 'react';
import { api } from './api';

type StorageConfig = {
  revision: number; storage_backend: 'local' | 'oss'; oss_endpoint: string; oss_bucket: string;
  oss_internal_endpoint: string; oss_upload_ttl: number; oss_signed_url_ttl: number;
  credentialsConfigured: boolean;
};
type Form = StorageConfig & { oss_access_key_id: string; oss_access_key_secret: string };
export function Operations({ notify }: { notify: (message: string) => void }) {
  const [form, setForm] = useState<Form>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = (value: StorageConfig) => setForm({ ...value, oss_access_key_id: '', oss_access_key_secret: '' });
  useEffect(() => { let alive = true; api<StorageConfig>('/operations/storage').then((value) => { if (alive) load(value); }).catch((e) => { if (alive) setError(e.message); }); return () => { alive = false; }; }, []);
  const submit = async (test: boolean) => {
    if (!form) return;
    setBusy(true); setError(''); notify('');
    const { credentialsConfigured: _configured, ...body } = form;
    try {
      if (test) {
        const result = await api<{ message: string }>('/operations/storage/test', 'POST', body);
        notify(result.message);
      } else {
        load(await api<StorageConfig>('/operations/storage', 'PUT', body));
        notify('存储配置已保存并生效，新上传使用当前存储方式。');
      }
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  };
  return <><div className="page-title"><div><p className="eyebrow">平台运营</p><h1>运营设置</h1><p>统一管理所有家庭的新上传存储，仅平台超管可修改。</p></div></div>
    {error && <p className="error" role="alert">{error}</p>}
    {!form ? <p className="empty">正在加载存储配置…</p> : <section className="settings-card operations-card"><h2>文件存储</h2>
      <p className="muted">已有文件继续使用原存储。已有云端资源时，切换 Bucket 或地域需要先迁移资源。</p>
      <form onSubmit={(e) => { e.preventDefault(); void submit(false); }}><fieldset disabled={busy}>
        <label>存储方式<select value={form.storage_backend} onChange={(e) => setForm({ ...form, storage_backend: e.target.value as 'local' | 'oss' })}><option value="local">服务器本地磁盘</option><option value="oss">阿里云 OSS</option></select></label>
        <div className="form-grid">
          <label>OSS Endpoint<input placeholder="https://oss-cn-hangzhou.aliyuncs.com" value={form.oss_endpoint} onChange={(e) => setForm({ ...form, oss_endpoint: e.target.value })} required={form.storage_backend === 'oss'} /></label>
          <label>Bucket<input placeholder="私有 Bucket 名称" value={form.oss_bucket} onChange={(e) => setForm({ ...form, oss_bucket: e.target.value })} required={form.storage_backend === 'oss'} /></label>
          <label>AccessKey ID<input type="password" autoComplete="new-password" value={form.oss_access_key_id} placeholder={form.credentialsConfigured ? '已保存；留空保留原值' : '输入 AccessKey ID'} onChange={(e) => setForm({ ...form, oss_access_key_id: e.target.value })} required={form.storage_backend === 'oss' && !form.credentialsConfigured} /></label>
          <label>AccessKey Secret<input type="password" autoComplete="new-password" value={form.oss_access_key_secret} placeholder={form.credentialsConfigured ? '已保存；留空保留原值' : '输入 AccessKey Secret'} onChange={(e) => setForm({ ...form, oss_access_key_secret: e.target.value })} required={form.storage_backend === 'oss' && !form.credentialsConfigured} /></label>
        </div>
        <p className="muted">{form.credentialsConfigured ? '访问密钥已配置。' : '尚未配置访问密钥。'} 密钥加密保存，不会回显。</p>
        <label>内网 Endpoint（可选）<input placeholder="仅同地域阿里云服务器使用，本机开发留空" value={form.oss_internal_endpoint} onChange={(e) => setForm({ ...form, oss_internal_endpoint: e.target.value })} /></label>
        <div className="form-grid"><label>上传签名有效期（秒）<input type="number" min={60} max={3600} value={form.oss_upload_ttl} onChange={(e) => setForm({ ...form, oss_upload_ttl: Number(e.target.value) })} required /></label>
          <label>播放签名有效期（秒）<input type="number" min={60} max={14400} value={form.oss_signed_url_ttl} onChange={(e) => setForm({ ...form, oss_signed_url_ttl: Number(e.target.value) })} required /></label></div>
        <p className="muted">Bucket 需设为私有，并允许管理网页和 TV 网页来源的 CORS 请求。服务端测试会创建、读取并删除一个临时对象。</p>
        <div className="actions"><button type="button" onClick={() => { void submit(true); }}>{busy ? '正在处理…' : '测试 OSS 连接'}</button><button className="primary" type="submit">保存存储配置</button></div>
      </fieldset></form>
    </section>}
  </>;
}
