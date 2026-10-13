import type { Child, Home, Series } from './api';

// Browser-only, opt-in development data. No backend or binding writes.
export const demoEnabled = import.meta.env.DEV && !window.MollyBridge && new URLSearchParams(location.search).get('mock') === '1';
const themes = ['小鼠波波', '动物小课堂', '一起学英语', '奇妙太空', '海底探险', '睡前故事'];
const colors = ['#567b92', '#857553', '#607d64', '#776485', '#487d83', '#976b76'];
const children: Child[] = [{ id: 'demo-child-1', name: '小麦' }, { id: 'demo-child-2', name: '小米' }];
let childId = children[0].id;
let defaultSubtitle = 'zh';
const folders: Series[] = Array.from({ length: 36 }, (_, index) => ({
  id: `demo-series-${index + 1}`, name: `${themes[index % 6]} · 第 ${Math.floor(index / 6) + 1} 季`,
  episodeCount: 80, overview: '一起发现新故事，探索有趣的世界。', image: { url: `/api/items/demo-series-${index + 1}/image` },
}));
const episodes = (seriesId: string) => Array.from({ length: 80 }, (_, index) => ({
  id: `${seriesId}-episode-${index + 1}`, name: `第 ${String(index + 1).padStart(2, '0')} 集 · ${['新朋友来了', '雨天的冒险', '去公园玩', '生日惊喜', '一起做早餐', '寻找小星星', '出发去旅行', '晚安，好梦'][index % 8]}`,
  seasonName: '第一季', runtimeMs: (4 + index % 9) * 60000,
  positionMs: index % 5 === 0 ? 90000 : 0, completed: index % 11 === 0,
  image: { url: `/api/items/${seriesId}-episode-${index + 1}/image` },
}));

export function demoRequest(path: string, method = 'GET', body?: Record<string, unknown>): unknown {
  const url = new URL(path, location.origin);
  const paged = url.searchParams.has('page');
  const page = Number(url.searchParams.get('page') ?? 1);
  const pageSize = Number(url.searchParams.get('pageSize') ?? 24);
  const rowId = url.searchParams.get('rowId');
  path = url.pathname;
  const batch = <T,>(items: T[]) => items.slice((page - 1) * pageSize, page * pageSize);
  if (path === '/api/settings/playback') {
    if (method === 'PUT') defaultSubtitle = String(body?.defaultSubtitle ?? defaultSubtitle);
    return { defaultSubtitle };
  }
  if (path === '/api/me') return { id: 'demo-family' };
  if (path === '/api/families/me/children') return children;
  const child = /^\/api\/children\/(demo-child-[12])\/select$/.exec(path);
  if (child) { childId = child[1]; return { ok: true }; }
  if (path === '/api/home') {
    const home: Home = { rows: [
      { id: 'recently-played', title: '最近播放', items: episodes(folders[0].id).slice(0, 12).map((episode) => ({ ...episode, type: 'episode' })) },
      { id: 'discover', title: '发现新故事', items: folders.slice(12, 30) },
      { id: 'library', title: '我的媒体库', items: folders },
    ] };
    return !paged ? home : { rows: home.rows.filter((row) => !rowId || row.id === rowId).map((row) => ({
      ...row, total: row.items.length, page, pageSize, hasMore: page * pageSize < row.items.length, items: batch(row.items),
    })) };
  }
  const playlist = /^\/api\/series\/(demo-series-\d+)\/playlist$/.exec(path);
  if (playlist && folders.some((folder) => folder.id === playlist[1])) return {
    episodes: paged ? batch(episodes(playlist[1])) : episodes(playlist[1]), episodeId: `${playlist[1]}-episode-16`, hasProgress: true,
    resumeEpisode: episodes(playlist[1])[15], ...(paged ? { page, pageSize, total: 80, hasMore: page * pageSize < 80 } : {}),
  };
  if (path === '/api/playback/sessions') return { sessionId: 'demo-session' };
  if (/\/progress(?:\?|$)/.test(path)) return { positionMs: 0, completed: false };
  if (path.startsWith('/api/playback/sessions/')) return { ok: true };
  if (/\/playback$/.test(path)) throw new Error('假数据用于测试浏览和滚动，没有实际视频。请返回视频列表。');
  throw new Error(`假数据模式未提供此操作：${path}`);
}

export function demoCall(method: string, args: Record<string, unknown>): unknown {
  if (method === 'getCapabilities') return { bridgeVersion: 1, authenticated: true, childId, nativePlayback: false };
  if (method === 'ready') return { ok: true };
  if (method === 'request') return demoRequest(String(args.path), String(args.method), args.body as Record<string, unknown> | undefined);
  if (method === 'playEpisode') { window.dispatchEvent(new CustomEvent('molly:browserPlay', { detail: args })); return { ok: true }; }
  throw new Error('假数据模式仅用于浏览预览，请移除网址中的 mock=1 使用真实媒体库。');
}

export function demoImage(path: string): string {
  const match = /demo-series-(\d+)(?:-episode-(\d+))?/.exec(path);
  if (!match) throw new Error('假数据封面不存在');
  const series = Number(match[1]) - 1, episode = Number(match[2] || 0);
  const label = episode ? `EP ${String(episode).padStart(2, '0')}` : `VOL ${Math.floor(series / 6) + 1}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="${colors[(series + episode) % 6]}"/><circle cx="780" cy="120" r="170" fill="#fff" opacity=".1"/><circle cx="110" cy="500" r="230" fill="#fff" opacity=".07"/><text x="70" y="240" font-family="sans-serif" font-size="72" font-weight="700" fill="#fff">${themes[series % 6]}</text><text x="75" y="335" font-family="sans-serif" font-size="52" fill="#fff" opacity=".8">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
