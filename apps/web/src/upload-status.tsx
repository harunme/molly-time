import { useEffect, useRef, useState } from 'react';
import { api, bytes, type Page, type Upload } from './api';
import { hasFile, live, pause, resume, forgetUpload } from './uploads';
import { Button } from './components/ui/button';
import { FileUploadField } from './components/ui/upload';
import { Progress } from './components/ui/progress';

/** One scoped request for the visible files; progress events do not poll the API per chunk. */
export function useItemUploads(itemIds: string[], settled?: () => void) {
  const key = [...new Set(itemIds)].sort().join(',');
  const [result, setResult] = useState<{ key: string; rows: Upload[] }>({ key: '', rows: [] });
  const [error, setError] = useState('');
  const [, render] = useState(0);
  const refreshRef = useRef<() => void>(() => {});
  const settledRef = useRef(settled); settledRef.current = settled;
  useEffect(() => {
    if (!key) { setError(''); return; }
    const controller = new AbortController();
    let busy = false, dirty = false, previous: Upload[] = [];
    const load = async () => {
      if (busy) { dirty = true; return; }
      busy = true;
      try {
        const rows: Upload[] = [];
        const itemIds = key.split(',');
        // The upload API accepts at most 100 item IDs per request.
        for (let start = 0; start < itemIds.length; start += 100) {
          const params = new URLSearchParams({ pending: 'true', pageSize: '100' });
          for (const id of itemIds.slice(start, start + 100)) params.append('itemIds', id);
          let loaded = 0;
          for (let page = 1; ; page++) {
            params.set('page', String(page));
            const response = await api<Page<Upload>>(`/uploads?${params}`, 'GET', undefined, undefined, controller.signal);
            rows.push(...response.items); loaded += response.items.length;
            if (loaded >= response.total || !response.items.length) break;
          }
        }
        if (controller.signal.aborted) return;
        const removed = previous.some(old => !rows.some(row => row.id === old.id));
        previous = rows;
        setResult({ key, rows }); setError('');
        if (removed) settledRef.current?.();
      } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
      finally {
        busy = false;
        if (dirty && !controller.signal.aborted) { dirty = false; void load(); }
      }
    };
    refreshRef.current = () => { void load(); };
    let ids = [...live.keys()].sort().join(',');
    const changed = () => {
      render(value => value + 1);
      const next = [...live.keys()].sort().join(',');
      if (next !== ids) { ids = next; void load(); }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 4000);
    window.addEventListener('mollytime:uploads', changed);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('mollytime:uploads', changed); refreshRef.current = () => {}; };
  }, [key]);
  const rows = result.key === key ? result.rows : [];
  return { rows, error, refresh: () => refreshRef.current(), forItem: (id: string) => rows.filter(row => row.itemId === id) };
}

const uploadBytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${Math.ceil(value / 1024)} KB` : bytes(value);

export function FileUploadStatus({ row, readonly, changed, showFilename = true }: { row: Upload; readonly: boolean; changed: () => void; showFilename?: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  const current = live.get(row.id);
  const offset = Math.min(row.size, Math.max(row.offset, current?.offset ?? 0));
  const percent = row.size ? Math.min(100, Math.floor(offset / row.size * 100)) : 0;
  const needsFile = row.status === 'uploading' && !hasFile(row.id);
  const failed = row.status === 'failed' || !!current?.error;
  const status = needsFile ? '等待重新选择原文件' : failed ? (row.taskId ? '处理失败' : '上传失败') : current?.preparing ? '正在准备视频' : current?.paused ? '已暂停' : row.status === 'processing' ? '正在处理' : offset >= row.size ? '正在提交' : `上传中 ${percent}%`;
  const act = async (work: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await work(); changed(); }
    catch (failure) { setError((failure as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };
  return <section className="file-upload-status" aria-label={`${row.filename} 上传状态`} data-status={failed ? 'failed' : row.status}>
    <div className="file-upload-caption">{showFilename && <span title={row.filename}>{row.filename}</span>}<span role="status">{status}</span></div>
    {row.status === 'uploading' && <Progress value={percent} aria-label={`${row.filename} 上传进度`} />}
    <div className="file-upload-detail"><span>{row.status === 'processing' ? '处理完成后自动更新' : `${uploadBytes(offset)} / ${uploadBytes(row.size)}`}</span>
      {!readonly && <div className="file-upload-actions">
        {row.status === 'uploading' && hasFile(row.id) && <Button type="button" variant="ghost" size="sm" disabled={busy || current?.preparing} onClick={() => {
          if (current?.paused || current?.error) void act(() => resume(row)); else { pause(row.id); changed(); }
        }}>{current?.error ? '重试' : current?.paused ? '继续' : '暂停'}</Button>}
        {row.status === 'failed' && row.taskId && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void act(() => api(`/tasks/${row.taskId}/retry`, 'POST'))}>重试处理</Button>}
        {['uploading', 'failed'].includes(row.status) && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void act(async () => { pause(row.id); await api(`/uploads/${row.id}/cancel`, 'POST'); forgetUpload(row.id); })}>{row.status === 'failed' ? '移除' : '取消'}</Button>}
      </div>}
    </div>
    {current?.recovery && <p className="mt-1 text-muted-foreground">{current.recovery}</p>}
    {(error || current?.error || row.error) && <p className="file-upload-error" role="alert">{error || current?.error || row.error}</p>}
    {!readonly && row.status === 'uploading' && !hasFile(row.id) && <FileUploadField inputLabel={`继续上传 ${row.filename}`} placeholder="重新选择原文件继续" disabled={busy} onFileSelect={file => { void act(() => resume(row, file)); }} />}
  </section>;
}
