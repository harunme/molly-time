import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, MonitorOff, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, type Resource } from './api';
import { confirmAction } from './feedback';

type Result = { changed: number; unchanged: number; hidden: number; skipped: { id: string; name: string; reason: string }[] };
type Mode = 'publish' | 'unpublish';

export function publicationLabel(item: Resource) {
  if (!item.ready) return '待就绪';
  if (item.status === 'published' && item.hiddenByFolder) return '随目录下架';
  if (item.type !== 'Episode') return item.status === 'published' ? '目录已上架' : '目录已下架';
  return item.status === 'published' ? '已上架' : '已下架';
}

export function useLibraryPublication({ items, parent, scope, readonly, refreshing, changed }: {
  items: Resource[]; parent?: Resource; scope: string; readonly: boolean; refreshing: boolean; changed: () => void;
}) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [batchMode, setBatchMode] = useState<Mode>();
  const lock = useRef(false);
  const selectButton = useRef<HTMLButtonElement>(null);
  const firstSelector = useRef<HTMLButtonElement>(null);
  const wasSelecting = useRef(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [skipped, setSkipped] = useState<Result['skipped']>([]);
  useEffect(() => { setSelected([]); setSelecting(false); setNotice(''); setError(''); setSkipped([]); }, [scope]);
  useEffect(() => {
    if (selecting) firstSelector.current?.focus();
    else if (wasSelecting.current) selectButton.current?.focus();
    wasSelecting.current = selecting;
  }, [selecting]);
  const videos = items.filter(item => item.type === 'Episode');
  const selection = videos.filter(item => selected.includes(item.id));
  const disabled = busy || refreshing;
  const toggle = (id: string) => {
    if (disabled) return;
    setSelected(current => current.includes(id) ? current.filter(key => key !== id) : [...current, id]);
  };
  const perform = async (operation: () => Promise<void>) => {
    if (readonly || lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice(''); setSkipped([]);
    try { await operation(); changed(); }
    catch (failure) { setError((failure as Error).message); }
    finally { lock.current = false; setBusy(false); setBatchMode(undefined); }
  };
  const batch = async (action: Mode, folderId?: string) => {
    const ids = selection.map(item => item.id);
    if (!folderId && !ids.length) return;
    await perform(async () => {
      setBatchMode(action);
      const result: Result = { changed: 0, unchanged: 0, hidden: 0, skipped: [] };
      // The API limits explicit selections to 200; folder operations remain server scoped.
      const batches = folderId ? [{ folderId }] : Array.from({ length: Math.ceil(ids.length / 200) }, (_, index) => ({ ids: ids.slice(index * 200, (index + 1) * 200) }));
      let completed = 0;
      for (const target of batches) {
        try {
          const part = await api<Result>('/resources/publication', 'POST', { action, ...target });
          result.changed += part.changed; result.unchanged += part.unchanged;
          result.hidden += part.hidden; result.skipped.push(...part.skipped);
          completed++;
        } catch (failure) {
          if (completed) {
            changed();
            throw new Error(`部分视频已处理，请刷新后检查结果并重试。${(failure as Error).message}`);
          }
          throw failure;
        }
      }
      const verb = action === 'publish' ? '上架' : '下架';
      const parts = [`已${verb} ${result.changed} 个视频`];
      if (result.unchanged) parts.push(`${result.unchanged} 个已是此状态`);
      if (result.skipped.length) parts.push(`${result.skipped.length} 个尚未就绪，已跳过`);
      if (result.hidden) parts.push(`${result.hidden} 个因上级目录已下架，暂不在电视显示`);
      setNotice(parts.join('。') + '。'); setSkipped(result.skipped);
      // Keep skipped videos selected so their remaining work stays discoverable.
      setSelected(result.skipped.map(item => item.id));
    });
  };
  const publishFolder = async (folder: Resource) => {
    if (disabled || lock.current) return;
    if (await confirmAction({ title: "上架目录内全部视频？", description: "包含所有子目录，尚未就绪的视频会跳过。已下架的目录不会自动上架。", detail: { label: "目录", value: folder.name }, confirmText: "上架全部视频" })) {
      await batch('publish', folder.id);
    }
  };
  const changeItem = (item: Resource) => perform(async () => {
    const published = item.status === 'published';
    const updated = await api<Resource>(`/resources/${item.id}/${published ? 'unpublish' : 'publish'}`, 'POST');
    const text = item.type === 'Episode'
      ? `“${item.name}”已${published ? '下架' : '上架'}。`
      : `“${item.name}”已${published ? '下架' : '上架'}，其中视频的上架状态已保留。`;
    setNotice((item.type === 'Episode' ? text : '') + (!published && updated.hiddenByFolder ? `上级目录“${updated.hiddenByFolder.name}”已下架，暂不在电视显示。` : ''));
  });
  const exit = () => { if (!busy) { setSelecting(false); setSelected([]); } };
  const toolbar = <div className="library-publication-controls">
    {(parent?.hiddenByFolder || parent?.status !== 'published' && parent) && <p className="library-visibility-note">
      <MonitorOff aria-hidden="true" />{parent.hiddenByFolder ? `上级目录“${parent.hiddenByFolder.name}”已下架。` : '此目录已下架。'}请先上架目录，才能在电视观看其中已上架的视频。
    </p>}
    {!readonly && <div className="library-selection-toolbar" data-selecting={selecting} role="group" aria-label="视频批量操作" aria-busy={busy}>
      {selecting ? <>
        <span className="library-selection-count">已选 {selection.length} 个视频</span>
        <Button variant="ghost" size="sm" disabled={disabled || !videos.length} onClick={() => setSelected(selection.length === videos.length ? [] : videos.map(item => item.id))}>
          {selection.length === videos.length && videos.length ? '取消全选' : '全选当前列表'}
        </Button>
        <div className="library-selection-actions">
          <Button variant="bordered" size="sm" disabled={disabled || !selection.some(item => item.status === 'published')} onClick={() => void batch('unpublish')}>{batchMode === 'unpublish' && <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />}下架</Button>
          <Button variant="bordered" className="library-selection-publish" size="sm" disabled={disabled || !selection.some(item => item.ready && item.status !== 'published')} onClick={() => void batch('publish')}>
            {batchMode === 'publish' && <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />}上架
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={exit}>完成</Button>
        </div>
      </> : <>
        <span className={`library-selection-hint${parent ? ' is-folder-label' : ''}`}>{parent ? '视频' : '上架后可在电视观看。'}</span>
        {parent && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void publishFolder(parent)}>上架目录内全部视频</Button>}
        {videos.length > 0 && <Button ref={selectButton} variant="bordered" size="sm" disabled={disabled} onClick={() => setSelecting(true)}>选择视频</Button>}
      </>}
    </div>}
  </div>;
  const feedback = <>
    {error && <div className="library-publication-feedback is-error" role="alert"><p>{error}</p><Button variant="ghost" size="icon" aria-label="关闭操作错误" onClick={() => setError('')}><X className="size-4" /></Button></div>}
    {notice && <div className="library-publication-feedback" role="status"><div><p>{notice}</p>{skipped.length > 0 && <details><summary>查看跳过的视频</summary><ul>{skipped.map(item => <li key={item.id}>{item.name} · {item.reason}</li>)}</ul></details>}</div><Button variant="ghost" size="icon" aria-label="关闭操作结果" onClick={() => { setNotice(''); setSkipped([]); }}><X className="size-4" /></Button></div>}
  </>;
  const selector = (item: Resource) => selecting && item.type === 'Episode' ? <button ref={item.id === videos[0]?.id ? firstSelector : undefined} type="button" role="checkbox" aria-checked={selected.includes(item.id)} aria-label={`选择视频 ${item.name}`} disabled={disabled} className="library-video-selector" onClick={() => toggle(item.id)}><span>{selected.includes(item.id) && <Check aria-hidden="true" />}</span></button> : null;
  return { selecting, selected, busy, toolbar, feedback, toggle, selector, changeItem, publishFolder, exit, beginSelection: () => setSelecting(true), selectAll: () => { if (!disabled) setSelected(videos.map(item => item.id)); }, publishSelection: () => batch('publish'), unpublishSelection: () => batch('unpublish') };
}
