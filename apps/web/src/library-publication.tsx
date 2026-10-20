import { useEffect, useRef, useState } from 'react';
import { Check, CheckCheck, LoaderCircle, Monitor, MonitorOff, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api, type Resource } from './api';
import { confirmAction } from './feedback';

type Result = { changed: number; unchanged: number; hidden: number; skipped: { id: string; name: string; reason: string }[] };
type Mode = 'publish' | 'unpublish';

export function publicationLabel(item: Resource) {
  if (item.type !== 'Episode') return item.status === 'published' ? '电视可见' : '电视已隐藏';
  if (!item.ready) return '待就绪';
  return item.status === 'published' ? '已上架' : '未上架';
}

export function useLibraryPublication({ items, parent, scope, readonly, refreshing, changed }: {
  items: Resource[]; parent?: Resource; scope: string; readonly: boolean; refreshing: boolean; changed: () => void;
}) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
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
    finally { lock.current = false; setBusy(false); }
  };
  const batch = async (action: Mode, folderId?: string) => {
    const ids = selection.map(item => item.id);
    if (!folderId && !ids.length) return;
    await perform(async () => {
      const result = await api<Result>('/resources/publication', 'POST', { action, ...(folderId ? { folderId } : { ids }) });
      const verb = action === 'publish' ? '上架' : '下架';
      const parts = [`已${verb} ${result.changed} 个视频`];
      if (result.unchanged) parts.push(`${result.unchanged} 个已是此状态`);
      if (result.skipped.length) parts.push(`${result.skipped.length} 个尚未就绪，已跳过`);
      if (result.hidden) parts.push(`${result.hidden} 个受上级目录隐藏影响，暂不在电视显示`);
      setNotice(parts.join('。') + '。'); setSkipped(result.skipped);
      // Keep skipped videos selected so their remaining work stays discoverable.
      setSelected(result.skipped.map(item => item.id));
    });
  };
  const publishFolder = async (folder: Resource) => {
    if (disabled || lock.current) return;
    if (await confirmAction({ title: "上架目录内全部视频？", description: "包含所有子目录，尚未就绪的视频会跳过。隐藏的目录仍保持隐藏。", detail: { label: "目录", value: folder.name }, confirmText: "上架全部视频" })) {
      await batch('publish', folder.id);
    }
  };
  const changeItem = (item: Resource) => perform(async () => {
    const published = item.status === 'published';
    const updated = await api<Resource>(`/resources/${item.id}/${published ? 'unpublish' : 'publish'}`, 'POST');
    const text = item.type === 'Episode'
      ? `“${item.name}”已${published ? '下架' : '上架'}。`
      : `“${item.name}”已${published ? '从电视隐藏' : '设为电视可见'}，其中视频的上架状态已保留。`;
    setNotice((item.type === 'Episode' ? text : '') + (!published && updated.hiddenByFolder ? `上级目录“${updated.hiddenByFolder.name}”已隐藏，暂不在电视显示。` : ''));
  });
  const exit = () => { if (!busy) { setSelecting(false); setSelected([]); } };
  const toolbar = <div className="library-publication-controls">
    {parent && <div className="folder-visibility">
      <div className="folder-visibility-copy">
        {parent.status === 'published' ? <Monitor aria-hidden="true" /> : <MonitorOff aria-hidden="true" />}
        <div><span id="folder-visibility-label">在电视上显示此目录</span><p>隐藏目录会一起隐藏其中内容，保留视频的上架状态。</p></div>
      </div>
      {!readonly && <Switch aria-labelledby="folder-visibility-label" checked={parent.status === 'published'} disabled={disabled || !parent.ready} onCheckedChange={() => void changeItem(parent)} />}
    </div>}
    {(parent?.hiddenByFolder || parent?.status !== 'published' && parent) && <p className="library-visibility-note">
      <MonitorOff aria-hidden="true" />{parent.hiddenByFolder ? `上级目录“${parent.hiddenByFolder.name}”已隐藏。` : '此目录已从电视隐藏。'}视频上架后仍不会出现在电视。
    </p>}
    {!readonly && <div className="library-selection-toolbar" role="group" aria-label="视频批量操作" aria-busy={busy}>
      {selecting ? <>
        <span className="library-selection-count">已选 {selection.length} 个视频</span>
        <Button variant="ghost" size="sm" disabled={disabled || !videos.length} onClick={() => setSelected(selection.length === videos.length ? [] : videos.map(item => item.id))}>
          {selection.length === videos.length && videos.length ? '取消全选' : '全选当前页'}
        </Button>
        <div className="library-selection-actions">
          <Button variant="bordered" size="sm" disabled={disabled || !selection.some(item => item.status === 'published')} onClick={() => void batch('unpublish')}>下架</Button>
          <Button size="sm" disabled={disabled || !selection.some(item => item.ready && item.status !== 'published')} onClick={() => void batch('publish')}>
            {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <CheckCheck className="size-3.5" />}上架
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={exit}>完成</Button>
        </div>
      </> : <>
        <span className={`library-selection-hint${parent ? ' is-folder-label' : ''}`}>{parent ? '视频' : '目录管理电视可见性，视频按需上架。'}</span>
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
  return { selecting, selected, busy, toolbar, feedback, toggle, selector, changeItem, publishFolder, exit };
}
