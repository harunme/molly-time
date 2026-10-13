import { request, type Home, type HomeRow, type Playlist } from './api';

export const catalogPageSize = 24;
export const homeOrder = (home: Home): Home => {
  const order = (title: string) => title === '最近播放' ? 0 : title === '我的媒体库' ? 2 : 1;
  return { rows: [...home.rows].sort((a, b) => order(a.title) - order(b.title)) };
};

// Older native shells reject queries at their bridge allowlist. Keep browsing
// available until the shell is updated; old servers may return unpaged data.
export async function catalogRequest<T>(path: string, page = 1, rowId?: string): Promise<T> {
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
  for (let page = 2; active() && data.hasMore && page <= (previous?.page ?? 1); page++) {
    const more = await catalogRequest<Playlist>(`/api/series/${folderId}/playlist`, page);
    Object.assign(data, more, { episodes: appendItems(data.episodes, more.episodes) });
  }
  return data;
}

export function appendRow(home: Home, row: HomeRow): Home {
  return { rows: home.rows.map((old) => old.id === row.id ? { ...row, items: appendItems(old.items, row.items) } : old) };
}
