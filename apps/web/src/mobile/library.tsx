import { MobileActionSheet } from './action-sheet';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { ArrowDownToLine, ArrowUp, ArrowDown, Archive, Captions, Check, ChevronRight, Folder, FolderPlus, Grid2X2, Image, List, MoreHorizontal, MoveRight, Pencil, Play, Plus, Search, Share2, UploadCloud, X } from 'lucide-react';
import { api, type Resource, type ResourceOption, type Upload } from '../api';
import { useDebounced, usePagedData } from '../pagination';
import { useContinuousData, ContinuousListStatus } from '../continuous-list';
import { useLibraryData } from '../library-data';
import { publicationLabel, showPublicationStatus, useLibraryPublication } from '../library-publication';
import { CoverArtwork } from '../cover-artwork';
import { confirmAction, promptText } from '../feedback';
import { queueVideoFiles, type VideoUploadBatch } from '../video-upload';
import { enqueue } from '../uploads';
import { FileUploadStatus, useItemUploads } from '../upload-status';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody } from '../components/ui/dialog';
import { MobileError, MobileTitle, useMobileData } from './common';

export type ResourceEditor = (kind: 'preview' | 'upload' | 'subtitle' | 'share', item: Resource, close: () => void) => ReactNode;
export function MobileLibrary({ readonly, editor, uploads }: { readonly: boolean; editor: ResourceEditor; uploads: ReactNode }) {
  const { folderId = '' } = useParams();
  const location = useLocation(), navigate = useNavigate();
  const [pendingSerial, refreshPending] = useState(0);
  const [serial, refresh] = useState(0), [search, setSearch] = useState(''), [mode, setMode] = useState<'grid' | 'list'>('grid');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [editing, setEditing] = useState<{ kind: 'preview' | 'upload' | 'subtitle' | 'share'; item: Resource }>();
  const [moving, setMoving] = useState<Resource>();
  const [actions, setActions] = useState<Resource>();
  const [adding, setAdding] = useState(false);
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const press = useRef<{ x: number; y: number } | undefined>(undefined);
  const suppressClick = useRef(0);
  useEffect(() => () => clearTimeout(hold.current), []);
  const coverInput = useRef<HTMLInputElement>(null), videoInput = useRef<HTMLInputElement>(null);
  const coverTarget = useRef<{ item: Resource; kind: 'image' | 'preview' } | undefined>(undefined);
  const batch = useRef<VideoUploadBatch>({ rows: [] });
  const lock = useRef(false);
  const query = useDebounced(search);
  const parent = useMobileData<Resource>(folderId ? `/resources/${encodeURIComponent(folderId)}` : '', serial);
  const cache = useLibraryData();
  const list = useContinuousData<Resource>(`/resources?sort=manual${folderId ? `&parentId=${encodeURIComponent(folderId)}` : ''}${query ? `&q=${encodeURIComponent(query)}` : ''}`, serial, true, cache);
  const pending = usePagedData<Upload>('/uploads?pending=true', serial + pendingSerial, 1);
  const fileUploads = useItemUploads(list.data.filter(item => item.type === 'Episode').map(item => item.id), () => refresh(value => value + 1));
  const publication = useLibraryPublication({ items: list.data, parent: parent.data, scope: `${folderId}:${query}`, readonly, refreshing: list.refreshing || !!list.error, changed: () => refresh(value => value + 1) });
  const tasks = new URLSearchParams(location.search).get('uploads') === '1';
  useEffect(() => { setSearch(''); setError(''); setMessage(''); batch.current = { folderId: folderId || undefined, rows: [] }; }, [folderId]);
  useEffect(() => { const timer = setInterval(() => { if (!document.hidden && navigator.onLine) refreshPending(value => value + 1); }, 15000); return () => clearInterval(timer); }, []);
  const run = async (work: () => Promise<void>) => {
    if (lock.current || readonly) return;
    lock.current = true; setBusy(true); setError('');
    try { await work(); refresh(value => value + 1); }
    catch (failure) { setError((failure as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };
  const open = async (item: Resource) => {
    if (Date.now() < suppressClick.current) return;
    if (publication.selecting && item.type === 'Episode') { publication.toggle(item.id); return; }
    if (item.type !== 'Episode') { window.dispatchEvent(new Event('mollytime:before-navigation')); navigate(`/library/${encodeURIComponent(item.id)}`); }
    else setEditing({ kind: 'preview', item });
  };
  const uploadVideos = async (files: File[]) => {
    await run(async () => { await queueVideoFiles(batch.current, files, () => refresh(value => value + 1)); setMessage('文件已加入上传，保持应用打开即可继续。'); if (!folderId && batch.current.folderId) navigate(`/library/${batch.current.folderId}`); });
  };
  const setTasks = (open: boolean) => {
    const params = new URLSearchParams(location.search);
    if (open) params.set('uploads', '1'); else params.delete('uploads');
    navigate(`${location.pathname}${params.size ? `?${params}` : ''}`, { replace: !open });
  };
  const title = folderId ? parent.data?.name || '内容' : '内容';
  return <div className="m-library">
    <MobileTitle title={title} subtitle={!folderId ? '属于我们家的故事收藏' : undefined} back={folderId ? parent.data?.parentId ? `/library/${parent.data.parentId}` : '/library' : undefined} action={!readonly && <div className="m-title-actions">{publication.selecting ? <button className="m-text-action" onClick={publication.exit}>完成</button> : <>{list.data.some(item => item.type === 'Episode') && <button className="m-text-action" onClick={publication.beginSelection}>选择</button>}<button className="m-circle-action" aria-label="添加内容" disabled={busy} onClick={() => setAdding(true)}><Plus size={23} /></button></>}</div>} />
    <div className="m-search"><Search size={18} /><input aria-label="搜索内容" placeholder="搜索故事或文件夹" value={search} onChange={event => setSearch(event.target.value)} />{search && <button aria-label="清除搜索" onClick={() => setSearch('')}><X size={16} /></button>}</div>
    <div className="m-library-meta"><span>{query ? '搜索结果' : folderId ? '文件夹内容' : '所有收藏'} <b>{list.total}</b></span><button className="m-text-action" aria-label={mode === 'grid' ? '切换列表' : '切换网格'} onClick={() => setMode(mode === 'grid' ? 'list' : 'grid')}>{mode === 'grid' ? <List size={19} /> : <Grid2X2 size={19} />}</button></div>
    <MobileError message={error || parent.error || list.error || fileUploads.error} />
    {message && <p className="m-inline-status" role="status">{message}</p>}
    {pending.total > 0 && <button className="m-upload-summary" onClick={() => setTasks(true)}><span className="m-transfer-icon"><ArrowDownToLine size={19} /></span><span><strong>{pending.total} 个文件待完成</strong><small>查看上传进度</small></span><ChevronRight size={16} /></button>}
    {publication.selecting && <div className="m-selection-heading"><span>选择要处理的视频</span></div>}
    <div className="m-publication">{parent.data && parent.data.status !== 'published' && <p className="m-footnote">此目录已下架，其中的视频暂不在电视显示。</p>}{publication.feedback}</div>
    {list.loading && <div className="m-loading" role="status">正在打开内容库…</div>}
    {!list.loading && !list.error && !list.data.length && <section className="m-empty"><Folder size={48} strokeWidth={1} /><h2>{query ? '还没有找到这个故事' : '给好故事留个位置'}</h2><p>{query ? '试试其他片名或文件夹名称。' : '建一个收藏，或上传孩子喜欢的视频。'}</p>{!readonly && !query && <button className="m-primary" onClick={() => videoInput.current?.click()}>上传第一个视频</button>}</section>}
    <div className={`m-collection ${mode}`} aria-label="家庭内容">{list.data.map(item => <article className="m-content-item" key={item.id}>
      <div className="m-cover-wrap"><button className={`m-cover ${item.type !== 'Episode' ? 'collection' : 'video'}`} aria-label={`打开 ${item.name}`} disabled={publication.selecting && item.type !== 'Episode'} onClick={() => void open(item)}
        onPointerDown={event => { if (event.pointerType !== 'touch' || publication.selecting) return; press.current = { x: event.clientX, y: event.clientY }; clearTimeout(hold.current); hold.current = setTimeout(() => { suppressClick.current = Date.now() + 700; setActions(item); }, 450); }}
        onPointerMove={event => { if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8) clearTimeout(hold.current); }}
        onPointerUp={() => { clearTimeout(hold.current); press.current = undefined; }} onPointerCancel={() => { clearTimeout(hold.current); press.current = undefined; }}
        onContextMenu={event => { event.preventDefault(); setActions(item); }}>{item.type === 'Episode' ? <Play size={29} strokeWidth={1.2} /> : <Folder size={38} strokeWidth={1.15} />}{item.imageUrl && <CoverArtwork src={item.imageUrl} preview={item.imagePreviewUrl} />}{item.type === 'Episode' && <span className="m-media-tag">{item.runtimeMs ? `${Math.floor(item.runtimeMs / 60000)}:${String(Math.floor(item.runtimeMs / 1000) % 60).padStart(2, '0')}` : '视频'}</span>}</button>{publication.selector(item)}</div>
      <div className="m-content-info"><button className="m-content-name" disabled={publication.selecting && item.type !== 'Episode'} onClick={() => void open(item)}>{item.name}</button>{showPublicationStatus(item) && <p className="m-content-state">{publicationLabel(item)}</p>}{fileUploads.forItem(item.id).map(row => <FileUploadStatus key={row.id} row={row} readonly={readonly} changed={fileUploads.refresh} />)}</div>
      {!publication.selecting && <button className="m-content-more" aria-label={`更多操作 ${item.name}`} onClick={() => setActions(item)}><MoreHorizontal size={20} /></button>}
    </article>)}</div>
    {publication.selecting && <div className="m-selection-bar" role="group" aria-label="已选视频操作"><div><strong>已选 {publication.selected.length} 个</strong><button disabled={list.refreshing || !!list.error || publication.busy} onClick={publication.selectAll}>全选当前列表</button></div><button disabled={!list.data.some(item => publication.selected.includes(item.id) && item.status === 'published') || publication.busy} onClick={() => void publication.unpublishSelection()}>下架</button><button className="publish" disabled={!list.data.some(item => publication.selected.includes(item.id) && item.ready && item.status !== 'published') || publication.busy} onClick={() => void publication.publishSelection()}>上架</button></div>}
    <MobileActionSheet open={adding} close={() => setAdding(false)} title="添加到内容库" detail={folderId ? title : '为下一次观看准备故事'} groups={[[
      { label: '新建文件夹', icon: <FolderPlus size={20} />, onSelect: () => { void run(async () => { const name = await promptText('新建文件夹', ''); if (name) await api('/resources', 'POST', { name, type: folderId ? 'Season' : 'Series', parentId: folderId || null }); }); } },
      { label: '上传视频', icon: <UploadCloud size={20} />, onSelect: () => videoInput.current?.click() },
    ]]} />
    {actions && <MobileActionSheet open close={() => setActions(undefined)} title={actions.name} detail={publicationLabel(actions)} image={actions.imageUrl || undefined}
      quick={[
        { label: actions.type === 'Episode' ? '预览' : '打开', icon: actions.type === 'Episode' ? <Play size={22} /> : <Folder size={22} />, onSelect: () => { suppressClick.current = 0; void open(actions); } },
        ...(!readonly ? [
          { label: actions.status === 'published' ? '下架' : '上架', icon: <Check size={22} />, disabled: publication.busy || !actions.ready && actions.status !== 'published', onSelect: () => void publication.changeItem(actions) },
          { label: '移动', icon: <MoveRight size={22} />, disabled: busy, onSelect: () => setMoving(actions) },
        ] : []),
      ]}
      groups={readonly ? [] : [
        [
          { label: '重命名', icon: <Pencil size={19} />, disabled: busy, onSelect: () => { void run(async () => { const name = await promptText('内容名称', actions.name); if (name && name !== actions.name) await api(`/resources/${actions.id}`, 'PATCH', { name }); }); } },
          { label: '更换封面', icon: <Image size={19} />, onSelect: () => { coverTarget.current = { item: actions, kind: 'image' }; coverInput.current?.click(); } },
          { label: '上传动态预览', icon: <Play size={19} />, onSelect: () => { coverTarget.current = { item: actions, kind: 'preview' }; coverInput.current?.click(); } },
          ...(actions.hasOwnPreview ? [{ label: '移除动态预览', icon: <X size={19} />, onSelect: () => { void run(async () => { await api(`/resources/${actions.id}/preview`, 'DELETE'); }); } }] : []),
        ],
        [
          ...(actions.type === 'Episode' ? [
            { label: '字幕设置', icon: <Captions size={19} />, onSelect: () => { void api<Resource>(`/resources/${actions.id}`).then(value => setEditing({ kind: 'subtitle', item: value })).catch(failure => setError(failure.message)); } },
            { label: '替换视频或追加文件', icon: <UploadCloud size={19} />, onSelect: () => setEditing({ kind: 'upload', item: actions }) },
          ] : [{ label: '上架目录内全部视频', icon: <Check size={19} />, onSelect: () => void publication.publishFolder(actions) }]),
          ...(actions.status === 'published' && !actions.shared && actions.type !== 'Season' ? [{ label: '分享内容', icon: <Share2 size={19} />, onSelect: () => setEditing({ kind: 'share', item: actions }) }] : []),
        ],
        [
          { label: '上移一位', icon: <ArrowUp size={19} />, disabled: busy || list.refreshing || !!list.error || list.data[0]?.id === actions.id, onSelect: () => { void run(async () => { const previous = list.data[list.data.findIndex(item => item.id === actions.id) - 1]; if (previous) await api(`/resources/${actions.id}/position`, 'PUT', { beforeId: previous.id, afterId: null }); }); } },
          { label: '下移一位', icon: <ArrowDown size={19} />, disabled: busy || list.refreshing || !!list.error || list.data[list.data.length - 1]?.id === actions.id, onSelect: () => { void run(async () => { const next = list.data[list.data.findIndex(item => item.id === actions.id) + 1]; if (next) await api(`/resources/${actions.id}/position`, 'PUT', { beforeId: null, afterId: next.id }); }); } },
        ],
        [{ label: '移入最近删除', icon: <Archive size={19} />, destructive: true, disabled: busy, onSelect: () => { void run(async () => { if (await confirmAction(`将“${actions.name}”移入最近删除？保留期内可以恢复。`)) await api(`/resources/${actions.id}/archive`, 'POST'); }); } }],
      ]} />}
    <ContinuousListStatus {...list} />
    <input type="file" hidden multiple ref={videoInput} accept="video/mp4,.mp4" aria-label="选择上传视频" onChange={event => { const files = [...event.currentTarget.files ?? []]; event.currentTarget.value = ''; if (files.length) void uploadVideos(files); }} />
    <input type="file" hidden ref={coverInput} accept="image/jpeg,image/png,image/webp,image/gif" aria-label="选择封面或动态预览" onChange={event => { const file = event.currentTarget.files?.[0], target = coverTarget.current; event.currentTarget.value = ''; if (file && target) void run(async () => { await enqueue(file, target.item.id, target.kind); }); }} />
    {editing && editor(editing.kind, editing.item, () => { setEditing(undefined); refresh(value => value + 1); })}
    {moving && <MobileMove item={moving} close={() => setMoving(undefined)} moved={() => { setMoving(undefined); setMessage('已移动到新位置'); refresh(value => value + 1); }} />}
    <Dialog open={tasks} onOpenChange={setTasks}><DialogContent className="m-sheet"><DialogHeader><DialogTitle>上传进度</DialogTitle><DialogDescription>回到其他页面也会继续上传。</DialogDescription></DialogHeader><DialogBody className="m-shared-form">{uploads}</DialogBody></DialogContent></Dialog>
  </div>;
}
function MobileMove({ item, close, moved }: { item: Resource; close: () => void; moved: () => void }) {
  const [search, setSearch] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const query = useDebounced(search);
  const folders = useContinuousData<ResourceOption>(`/resources?summary=true&q=${encodeURIComponent(query)}`);
  const candidates = folders.data.filter(row => row.type !== 'Episode' && row.id !== item.id && row.id !== item.parentId);
  const move = async (folderId: string | null) => { if (busy) return; setBusy(true); setError(''); try { await api(`/resources/${item.id}/move`, 'POST', { folderId }); moved(); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); } };
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="m-sheet"><DialogHeader><DialogTitle>移动“{item.name}”</DialogTitle><DialogDescription>选择目标文件夹。原有内容会一起移动。</DialogDescription></DialogHeader><DialogBody><div className="m-search"><Search size={18} /><input aria-label="搜索目标文件夹" placeholder="搜索文件夹" value={search} onChange={event => setSearch(event.target.value)} /></div><MobileError message={error || folders.error} /><div className="m-group">{item.type === 'Series' && item.parentId && <button className="m-row" disabled={busy} onClick={() => void move(null)}><Folder size={20} /><span>全部收藏</span></button>}{candidates.map(folder => <button className="m-row" disabled={busy} key={folder.id} onClick={() => void move(folder.id)}><Folder size={20} /><span>{folder.name}</span><ChevronRight size={16} /></button>)}</div>{!folders.loading && !candidates.length && <p className="m-footnote">没有可用的目标文件夹。请尝试其他名称。</p>}<ContinuousListStatus {...folders} /></DialogBody></DialogContent></Dialog>;
}
