import { useEffect, useState } from 'react';
import { api, dateTime } from './api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Settings = { enabled: boolean; sourceUrl: string; updatedAt: string | null; channels: { id: string; name: string; group: string }[]; skipped?: number };
const example = 'https://raw.githubusercontent.com/vbskycn/iptv/master/tv/iptv4.m3u';

export function LiveTvOperations({ notify }: { notify: (message: string) => void }) {
  const [data, setData] = useState<Settings>(), [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    api<Settings>('/operations/live-tv').then(value => { if (alive) { setData(value); setUrl(value.sourceUrl); setError(''); } })
      .catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [reload]);
  const perform = async (action: () => Promise<Settings>, message: string) => {
    setBusy(true); setError(''); notify('');
    try {
      const result = await action(); setData(result); setUrl(result.sourceUrl);
      notify(`${message}${result.skipped ? `，跳过 ${result.skipped} 条无效或重复记录` : ''}`);
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  };
  return <Card className="settings-card operations-card">
    <h2>电视直播（实验）</h2>
    <p className="muted">统一维护所有家庭的直播频道。电视入口位于“设置 → 电视直播”，每次观看最长 30 分钟。</p>
    <p className="muted">仅导入你有权使用的直播源。频道由电视直连，实际可用性取决于源站及家庭网络。</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!data && !error && <p role="status">正在加载直播配置…</p>}
    {!data && error && <Button onClick={() => setReload(v => v + 1)}>重新加载</Button>}
    {data && <>
      <p role="status">{data.enabled ? '已开启' : '未开启'} · {data.channels.length} 个频道 · 更新于 {dateTime(data.updatedAt)}</p>
      <form onSubmit={e => { e.preventDefault(); void perform(() => api('/operations/live-tv/import', 'POST', { sourceUrl: url.trim() }), '频道已导入并开启'); }}>
        <fieldset disabled={busy}>
          <Label htmlFor="live-source">订阅地址</Label>
          <Input id="live-source" type="url" required value={url} maxLength={4096} placeholder="https://example.com/tv.m3u" onChange={e => setUrl(e.target.value)} />
          <div className="actions">
            <Button type="submit" disabled={!url.trim()}>{busy ? '正在处理…' : '导入并开启'}</Button>
            <Button type="button" variant="bordered" onClick={() => setUrl(example)}>填入 vbskycn IPv4 示例</Button>
            <Button type="button" variant="bordered" disabled={!data.sourceUrl} onClick={() => { void perform(() => api('/operations/live-tv/import', 'POST', { sourceUrl: data.sourceUrl }), '订阅已刷新'); }}>刷新当前订阅</Button>
          </div>
          <Label htmlFor="live-file">或上传 M3U / TXT 列表（最大 2 MB）</Label>
          <Input id="live-file" type="file" accept=".m3u,.m3u8,.txt" onChange={e => {
            const file = e.target.files?.[0]; e.target.value = '';
            if (!file) return;
            if (file.size > 2 * 1024 * 1024) { setError('列表不能超过 2 MB'); return; }
            void perform(async () => api('/operations/live-tv/import', 'POST', { content: await file.text() }), '频道已导入并开启');
          }} />
          <p className="muted">导入成功会替换当前频道列表并对所有家庭开启；失败会保留原列表。订阅暂由运营手动刷新。</p>
          <Button type="button" variant="bordered" disabled={!data.channels.length} onClick={() => { void perform(() => api('/operations/live-tv', 'PUT', { enabled: !data.enabled }), data.enabled ? '电视直播已关闭' : '电视直播已开启'); }}>{data.enabled ? '关闭电视直播' : '开启电视直播'}</Button>
        </fieldset>
      </form>
      {!!data.channels.length && <details className="mt-4"><summary className="cursor-pointer">查看频道列表（{data.channels.length}）</summary><div className="mt-3 max-h-96 overflow-auto"><Table><TableHeader><TableRow><TableHead>频道</TableHead><TableHead>分组</TableHead></TableRow></TableHeader><TableBody>{data.channels.map(c => <TableRow key={c.id}><TableCell>{c.name}</TableCell><TableCell>{c.group}</TableCell></TableRow>)}</TableBody></Table></div></details>}
    </>}
  </Card>;
}
