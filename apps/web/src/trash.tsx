import { useEffect, useState } from 'react';
import { Clock3, FileVideo, FolderOpen, RotateCcw, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Empty } from '@/components/ui/empty';
import { Label } from '@/components/ui/label';
import { Loading } from '@/components/ui/loading';
import { SelectField } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, bytes as largeBytes, dateTime, type Page } from './api';
import { confirmAction } from './feedback';
import { Pagination, usePagedData } from './pagination';
import { ResourceSummary } from './resource-summary';

type Storage = { usedBytes: number; reclaimableBytes: number; ossBytes: number; localBytes: number; unknownSizeCount: number };
type TrashItem = {
  id: string; name: string; type: string; archivedAt: string; deleteAt: string | null;
  videoCount: number; deleting: boolean; error: string; storage: Storage;
};
type TrashPage = Page<TrashItem> & { storage: Storage; entryCount: number; retentionDays: number };
const bytes = (value: number) => value < 1024 ? `${value} B`
  : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : largeBytes(value);

export function TrashRetentionSettings({ readonly, run, notify }: { readonly: boolean; run: (action: () => Promise<void>) => Promise<void>; notify: (value: string) => void }) {
  const [retentionDays, setRetentionDays] = useState('7');
  const [savedDays, setSavedDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api<{ retentionDays: number }>('/trash/settings').then((value) => {
      if (alive) { setRetentionDays(String(value.retentionDays)); setSavedDays(value.retentionDays); }
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  const save = async () => {
    const days = Number(retentionDays);
    if (days > 0 && !await confirmAction(`将自动删除策略设为 ${days} 天？此策略也适用于已有回收站内容，超过保留期的内容将在下一次清理时彻底删除，无法恢复。`)) return;
    setBusy(true);
    await run(async () => {
      await api('/trash/settings', 'PUT', { retentionDays: days });
      setSavedDays(days);
      notify(days ? `已设置为移入回收站 ${days} 天后自动删除。` : '已关闭自动删除，回收站内容将保留至手动删除。');
    });
    setBusy(false);
  };
  const options = [0, 7, 14, 30, 90, 365].map((days) => ({ value: String(days), label: days ? `${days} 天后自动删除` : '不自动删除' }));
  return <Card className="settings-card">
    <div className="flex items-center gap-2"><Clock3 className="size-4 text-muted-foreground" /><h2 className="mb-0">回收站自动删除</h2></div>
    <p className="muted">内容移入回收站后按此策略自动清理，彻底删除会清理 OSS 和本地文件，无法恢复。</p>
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Label htmlFor="trash-retention">保留时间</Label>
      <SelectField id="trash-retention" aria-label="回收站保留时间" value={retentionDays} onValueChange={setRetentionDays} disabled={readonly || loading || busy} options={options} />
      {!readonly && <Button className="mt-3" variant="bordered" type="submit" disabled={loading || busy || Number(retentionDays) === savedDays}>{busy ? '保存中…' : '保存策略'}</Button>}
    </form>
  </Card>;
}

export function Trash({ readonly }: { readonly: boolean }) {
  const [serial, refresh] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState<TrashItem>();
  const list = usePagedData<TrashItem, TrashPage>('/trash', serial);
  const [summary, setSummary] = useState<TrashPage>();
  useEffect(() => { if (list.response) setSummary(list.response); }, [list.response]);
  const mutate = async (key: string, action: () => Promise<unknown>, message: string) => {
    setBusy(key); setError(''); setNotice('');
    try {
      await action();
      setNotice(message);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败，请重试');
      throw failure;
    } finally {
      setBusy('');
      refresh((value) => value + 1);
    }
  };
  return <>
    <div className="page-title">
      <div><h1>回收站</h1><p>暂存不再需要的内容，保留期内可以恢复。</p></div>
    </div>
    {(error || list.error) && <Alert variant="destructive" role="alert" className="mb-5"><AlertDescription>{error || list.error}</AlertDescription></Alert>}
    {notice && <Alert role="status" className="mb-5"><AlertDescription>{notice}</AlertDescription></Alert>}
    {summary && <ResourceSummary className="trash-summary" icon={Trash2} title="回收站占用"
      primary={bytes(summary.storage.usedBytes)} primaryTitle={`${summary.storage.usedBytes} 字节`} primaryTestId="trash-used"
      secondary={<>可释放 <strong className="font-medium text-foreground" data-testid="trash-reclaimable">{bytes(summary.storage.reclaimableBytes)}</strong></>}
      detail={<>OSS {bytes(summary.storage.ossBytes)} · 本地 {bytes(summary.storage.localBytes)}</>}
      note="包含文件夹子内容、字幕、封面和旧版本；共享文件按实际文件去重，仍被其他资源使用的文件会保留。"
    >
        {summary.storage.unknownSizeCount > 0 && <p className="text-sm text-destructive">{summary.storage.unknownSizeCount} 个文件大小未确认，当前统计不完整。</p>}
    </ResourceSummary>}
    <Card className="settings-card trash-list-card">
      <div className="trash-list-body">
      {list.loading ? <Loading className="min-h-0 flex-1" label="正在加载回收站…" /> : !list.error && <>
        {!!list.data.length &&
        <Table className="trash-table min-w-256">
          <TableHeader><TableRow><TableHead>名称</TableHead><TableHead>占用空间</TableHead><TableHead>移入时间</TableHead><TableHead>自动删除时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
          <TableBody>{list.data.map((row) => <TableRow key={row.id}>
            <TableCell><div className="flex items-center gap-2.5">{row.type === 'Episode' ? <FileVideo className="size-4 shrink-0 text-muted-foreground" /> : <FolderOpen className="size-4 shrink-0 text-muted-foreground" />}
              <strong className="max-w-48 truncate font-medium" title={row.name}>{row.name}</strong>
              <span className="shrink-0 text-xs text-muted-foreground">{row.type === 'Episode' ? '视频' : `文件夹 · ${row.videoCount} 个视频`}</span>
              {row.error && <span className="max-w-40 truncate text-xs text-destructive" title={row.error}>{row.error}</span>}
            </div></TableCell>
            <TableCell><div className="flex items-center gap-3 tabular-nums"><span title={`${row.storage.usedBytes} 字节`}>{bytes(row.storage.usedBytes)}</span><span className="text-xs text-muted-foreground">可释放 {bytes(row.storage.reclaimableBytes)}</span></div></TableCell>
            <TableCell className="whitespace-nowrap">{dateTime(row.archivedAt)}</TableCell>
            <TableCell className="whitespace-nowrap">{row.deleting ? '已开始删除，无法恢复' : row.deleteAt ? dateTime(row.deleteAt) : '不自动删除'}</TableCell>
            <TableCell><div className="trash-row-actions">{!readonly && <>
              <Button variant="ghost" disabled={!!busy || row.deleting} onClick={() => { void mutate(row.id, () => api(`/trash/${row.id}/restore`, 'POST'), '已恢复到资源库，沿用移入前的发布状态。').catch(() => {}); }}><RotateCcw className="size-3.5" />恢复</Button>
              <Button variant="ghost" className="text-destructive" disabled={!!busy} onClick={() => setDeleting(row)}><Trash2 className="size-3.5" />{row.deleting ? '重试删除' : '立即删除'}</Button>
            </>}</div></TableCell>
          </TableRow>)}</TableBody>
        </Table>}
        {!list.data.length && <Empty className="empty py-16"><Trash2 className="size-8 text-muted-foreground" /><h3>回收站是空的</h3><p>资源库中移入回收站的内容会显示在这里。</p></Empty>}
      </>}
      </div>
      <Pagination {...list} loading={list.refreshing} label="回收站分页" />
    </Card>
    <ConfirmDialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(undefined); }} title="彻底删除内容" confirmLabel="彻底删除" destructive
      description={deleting ? `永久删除“${deleting.name}”${deleting.type !== 'Episode' ? '及文件夹内的所有内容' : ''}？将清理对应的 OSS 和本地文件，预计释放 ${bytes(deleting.storage.reclaimableBytes)}。仍被其他资源使用的文件会保留。此操作无法恢复。` : ''}
      onConfirm={async () => { if (deleting) await mutate(deleting.id, () => api(`/trash/${deleting.id}`, 'DELETE'), '内容已彻底删除。'); }} />
  </>;
}
