import { ApiError, call, request, type Home, type HomeRow, type Playlist, type PlaylistEpisode, type Series } from './api';

export const catalogPageSize = 24;
const emptyItems: Series[] = [];
export const playlistItems = (data?: Playlist): Series[] => data?.items ?? data?.episodes ?? emptyItems;
export const playlistHasMore = (data?: Playlist) => data?.items ? data.itemsHasMore : data?.hasMore;
export const playlistFocus = (item: { id: string; type?: string }) => `${item.type === 'folder' ? 'folder' : 'episode'}-${item.id}`;
let localCatalog = false;
export function configureCatalog(enabled: boolean) { localCatalog = enabled; }
function waitForCatalog() {
  return new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); window.removeEventListener('molly:catalogChanged', done); resolve(); };
    const timer = setTimeout(done, 250);
    window.addEventListener('molly:catalogChanged', done, { once: true });
  });
}
export type PlaybackReturn = { episodeId: string; positionMs: number; completed: boolean; runtimeMs?: number; progressKnown: true };

export function readPlaybackReturn(value: unknown): PlaybackReturn | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as Record<string, unknown>;
  if (data.progressKnown !== true || typeof data.episodeId !== 'string' || !/^[A-Za-z0-9-]+$/.test(data.episodeId) ||
    typeof data.positionMs !== 'number' || !Number.isFinite(data.positionMs) || data.positionMs < 0 || typeof data.completed !== 'boolean') return;
  const runtimeMs = typeof data.runtimeMs === 'number' && Number.isFinite(data.runtimeMs) && data.runtimeMs > 0 ? data.runtimeMs : undefined;
  return { episodeId: data.episodeId, positionMs: runtimeMs ? Math.min(data.positionMs, runtimeMs) : data.positionMs,
    completed: data.completed, runtimeMs, progressKnown: true };
}

export function withPlaybackProgress<T extends { id: string }>(item: T, progress: PlaybackReturn): T {
  return item.id === progress.episodeId ? { ...item, positionMs: progress.positionMs, completed: progress.completed,
    ...(progress.runtimeMs ? { runtimeMs: progress.runtimeMs } : {}) } : item;
}

export function updatePlaylistProgress(playlist: Playlist, progress: PlaybackReturn): Playlist | undefined {
  const current = playlist.episodes.find((item) => item.id === progress.episodeId) ??
    (playlist.resumeEpisode?.id === progress.episodeId ? playlist.resumeEpisode : undefined);
  if (!current) return;
  const index = playlist.episodes.findIndex((item) => item.id === progress.episodeId);
  // The next episode may be on an unloaded page. Let the server resolve it
  // instead of incorrectly offering the just-completed episode as the resume.
  if (progress.completed && (index < 0 || index === playlist.episodes.length - 1 && playlist.hasMore)) return;
  const resume = progress.completed && index >= 0 ? playlist.episodes[index + 1] ?? current : current;
  return { ...playlist, episodes: playlist.episodes.map((item) => withPlaybackProgress(item, progress)),
    items: playlist.items?.map((item) => withPlaybackProgress(item, progress)),
    hasProgress: true, episodeId: resume.id, resumeEpisode: withPlaybackProgress(resume, progress) };
}

export function updateHomeProgress(home: Home, progress: PlaybackReturn, episode?: PlaylistEpisode): Home {
  return { rows: home.rows.map((row) => {
    const items = row.items.map((item) => withPlaybackProgress(item, progress));
    if (episode && (row.id === 'recently-played' || row.title === '最近播放')) {
      return { ...row, items: [withPlaybackProgress({ ...episode, type: 'episode' as const }, progress),
        ...items.filter((item) => item.id !== progress.episodeId)].slice(0, Math.max(items.length, 1)) };
    }
    return items.some((item, index) => item !== row.items[index]) ? { ...row, items } : row;
  }) };
}
export const homeOrder = (home: Home): Home => {
  const order = (title: string) => title === '最近播放' ? 0 : title === '我的媒体库' ? 2 : 1;
  return { rows: [...home.rows].sort((a, b) => order(a.title) - order(b.title)) };
};

// Older native shells reject queries at their bridge allowlist. Keep browsing
// available until the shell is updated; old servers may return unpaged data.
export async function catalogRequest<T>(path: string, page = 1, rowId?: string): Promise<T> {
  if (localCatalog) {
    const folder = /^\/api\/series\/([A-Za-z0-9-]+)\/playlist$/.exec(path);
    const args = { kind: folder ? 'playlist' : 'home', folderId: folder?.[1], page, pageSize: catalogPageSize, rowId };
    const started = performance.now();
    while (localCatalog) {
      const result = await call<{ data?: T; unsupported?: boolean; pending?: boolean; offline?: boolean; message?: string }>('catalogRead', args);
      if (result.unsupported) { configureCatalog(false); break; }
      if (result.data) return result.data;
      if (result.offline || performance.now() - started > 30000) throw new ApiError(result.message || '此内容尚未同步，请联网后重试');
      await waitForCatalog();
    }
  }
  const query = `page=${page}&pageSize=${catalogPageSize}${rowId ? `&rowId=${encodeURIComponent(rowId)}` : ''}`;
  try { return await request<T>(`${path}?${query}`); }
  catch (failure) {
    if (page === 1 && failure instanceof Error && failure.message === '接口不允许访问') return request<T>(path);
    throw failure;
  }
}

export function appendItems<T extends { id: string }>(items: T[], more: T[]): T[] {
  const ids = new Set(items.map((item) => item.id));
  return [...items, ...more.filter((item) => { if (ids.has(item.id)) return false; ids.add(item.id); return true; })];
}

export async function loadHome(previous?: Home, active = () => true): Promise<Home> {
  const data = homeOrder(await catalogRequest<Home>('/api/home'));
  // Refresh only the batches previously visited, preserving return focus.
  for (const row of data.rows) {
    const pages = previous?.rows.find((old) => old.id === row.id)?.page ?? 1;
    for (let page = 2; active() && row.id && row.hasMore && page <= pages; page++) {
      const more = (await catalogRequest<Home>('/api/home', page, row.id)).rows[0];
      if (!more) break;
      Object.assign(row, more, { items: appendItems(row.items, more.items) });
    }
  }
  return data;
}

export async function loadPlaylist(folderId: string, previous?: Playlist, active = () => true): Promise<Playlist> {
  const data = await catalogRequest<Playlist>(`/api/series/${folderId}/playlist`);
  for (let page = 2; active() && playlistHasMore(data) && page <= (previous?.page ?? 1); page++) {
    const more = await catalogRequest<Playlist>(`/api/series/${folderId}/playlist`, page);
    Object.assign(data, more, { episodes: appendItems(data.episodes, more.episodes), ...(more.items ? { items: appendItems(data.items ?? [], more.items) } : {}) });
  }
  return data;
}

export function appendRow(home: Home, row: HomeRow): Home {
  return { rows: home.rows.map((old) => old.id === row.id ? { ...row, items: appendItems(old.items, row.items) } : old) };
}
