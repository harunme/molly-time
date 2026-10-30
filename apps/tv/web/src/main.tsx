import { useWatchControl, WatchControlPanel, readWatchControl, WatchQuota } from './watch-control';
import { BrowserPlaybackHost } from './playback';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentFocusKey, init, setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { LiveTv } from './live-tv';
import { PlaybackSettings } from './playback-settings';
import { ApiError, call, request, type Capabilities, type Home, type Playlist, type PlaylistEpisode, type Series } from './api';
import { appendItems, appendRow, catalogRequest, configureCatalog, loadHome, loadPlaylist, readPlaybackReturn, updateHomeProgress, updatePlaylistProgress } from './catalog';
import { playlistItems, playlistHasMore, playlistFocus } from './catalog';
import { finishScrolls, FocusButton, FocusRegion, isFirstGridRow } from './focus';
import { CatalogCard, DetailHeader, HomeGreeting, Icon, LoadMore, Shelf } from './content';
import { PairingPanel } from './pairing';
import { Brand } from './brand';
import { useClientUpdate } from './client-update';
import { useTvMotion } from './motion';
import { HomeLoading } from './home-loading';
import './style.css';
import './focus-ring.css';

init({ debug: false, visualDebug: false, throttle: 100, shouldFocusDOMNode: true,
  domNodeFocusOptions: { preventScroll: true }, shouldUseNativeEvents: true });

type ViewSnapshot = { focus: string; scroll: number; rails: Record<string, number> };
type Overlay = 'settings' | 'pairing' | 're-pair' | 'client-update' | 'live-tv' | 'watch-control' | 'watch-rest' | null;
type SyncStatus = { online: boolean; supported?: boolean; message?: string; lastSync?: number; catalogComplete?: boolean; coversComplete?: boolean; paused?: boolean };
const legacyHomeFocus = (row: number, item: Series) => row === 0 ? `series-${item.id}` : `home-${row}-${item.id}`;
const emptyVideos: PlaylistEpisode[] = [];
const duration = (ms?: number) => ms ? `${Math.ceil(ms / 60000)} 分钟` : '';
const playbackTime = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
const watchedPosition = (item: Series) => {
  if (!Number.isFinite(item.positionMs) || !item.positionMs || item.positionMs < 0 || item.completed) return '';
  const runtime = item.runtimeMs;
  const hasRuntime = runtime !== undefined && Number.isFinite(runtime) && runtime > 0;
  const position = hasRuntime ? Math.min(item.positionMs, runtime) : item.positionMs;
  return `已看 ${playbackTime(position)}${hasRuntime ? ` / ${playbackTime(runtime)}` : ''}`;
};
const episodeAction = (item: Series) => item.completed ? '再次播放' : watchedPosition(item) ? `继续观看 · ${watchedPosition(item)}` : '播放';

function useCatalogCallback<Args extends unknown[]>(callback: (...args: Args) => void) {
  const latest = useRef(callback);
  useLayoutEffect(() => { latest.current = callback; });
  return useCallback((...args: Args) => latest.current(...args), []);
}

function App() {
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [authenticated, setAuthenticated] = useState(false);
  const watch = useWatchControl(authenticated, capabilities);
  const [folder, setFolder] = useState<Series>();
  const [playlist, setPlaylist] = useState<Playlist>();
  const videos = playlist?.episodes ?? emptyVideos;
  const entries = playlistItems(playlist);
  const resumeId = playlist?.hasProgress ? playlist.episodeId ?? '' : '';
  const homeSnapshot = useRef<ViewSnapshot | undefined>(undefined);
  const [home, setHome] = useState<Home>({ rows: [] });
  const homeFocus = (row: number, item: Series, rows = home.rows) => capabilities?.catalogSync && rows[row]?.id
    ? `home-${rows[row].id}-${item.id}` : legacyHomeFocus(row, item);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>();
  const [reload, setReload] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [liveTvEnabled, setLiveTvEnabled] = useState(false);
  const { update: clientUpdate, check: checkClientUpdate, act: updateClient, actionable: updateActionable, actionLabel: updateActionLabel } = useClientUpdate();
  const [bridgeCompatible, setBridgeCompatible] = useState(true);
  const canOpenSettings = authenticated || !!(window.MollyBridge && capabilities?.clientUpdates && capabilities.serverUrl);
  const [compatibilityWarning, setCompatibilityWarning] = useState('');
  const contentFocus = useRef('');
  const folderGridFocus = useRef('');
  const navigationInput = useRef(0);
  const restore = useRef<ViewSnapshot | undefined>(undefined);
  const overlayPage = useRef<Overlay>(null);
  const overlayHistory = useRef<{ page: Overlay; snapshot: ViewSnapshot; error: string }[]>([]);
  const viewport = useRef<HTMLDivElement>(null);
  const loadSerial = useRef(0);
  const appended = useRef(false);
  const homeCache = useRef<{ scope: string; reload: number; data: Home } | undefined>(undefined);
  const playlistCache = useRef<{ scope: string; reload: number; folder: string; data: Playlist } | undefined>(undefined);
  const folderHistory = useRef<{ folder: Series; snapshot: ViewSnapshot; cache: typeof playlistCache.current }[]>([]);
  const [pageStates, setPageStates] = useState<Record<string, { loading?: boolean; error?: string }>>({});
  const [readyToAppend, setReadyToAppend] = useState(false);
  const pageRequests = useRef(new Set<string>());
  const motion = useTvMotion(authenticated && !busy && !folder && !overlay && !playing && !error && home.rows.length > 0, overlay, authenticated && !folder && !overlay && !playing);
  const resetOverlay = useCallback((next: Overlay) => {
    motion.direction.current = overlayPage.current ? 'forward' : 'open';
    overlayHistory.current = [];
    overlayPage.current = next;
    setOverlay(next);
  }, []);
  const openOverlay = useCatalogCallback((next: Exclude<Overlay, null>) => {
    if (next === 'client-update' && overlayPage.current === 'settings') return;
    if (overlayPage.current === next) return;
    finishScrolls(viewport.current);
    motion.direction.current = overlayPage.current ? 'forward' : 'open';
    overlayHistory.current.push({ page: overlayPage.current, error, snapshot: {
      focus: getCurrentFocusKey() || 'content', scroll: viewport.current?.scrollTop ?? 0,
      rails: Object.fromEntries(Array.from(viewport.current?.querySelectorAll<HTMLElement>('[data-rail]') ?? [])
        .map((node) => [node.dataset.rail!, node.scrollLeft])),
    } });
    overlayPage.current = next;
    setError(''); setOverlay(next);
  });
  const checkSettingsUpdate = useCatalogCallback(() => { void checkClientUpdate(); });
  useEffect(() => {
    if (overlay !== 'settings') return;
    if (window.MollyBridge && capabilities?.clientUpdates && capabilities.serverUrl) checkSettingsUpdate();
    setLiveTvEnabled(false);
    if (!authenticated) return;
    let alive = true;
    void request<{ enabled: boolean }>('/api/live-tv').then((data) => {
      if (alive) setLiveTvEnabled(data.enabled === true);
    }).catch(() => { if (alive) setLiveTvEnabled(false); });
    return () => { alive = false; };
  }, [overlay, authenticated, capabilities?.clientUpdates, capabilities?.serverUrl, checkSettingsUpdate]);
  const parentOverlay = overlayHistory.current[overlayHistory.current.length - 1]?.page;
  useEffect(() => {
    if (overlay === 'settings' && !updateActionable && getCurrentFocusKey() === 'client-update-action') {
      const frame = requestAnimationFrame(() => setFocus(authenticated ? 're-pair' : 'close-overlay'));
      return () => cancelAnimationFrame(frame);
    }
    if (overlay !== 'client-update') return;
    const frame = requestAnimationFrame(() => setFocus(updateActionable ? 'client-update-action' : 'close-overlay'));
    return () => cancelAnimationFrame(frame);
  }, [overlay, updateActionable, clientUpdate?.phase]);

  const snapshot = (): ViewSnapshot => { finishScrolls(viewport.current); return { focus: getCurrentFocusKey() || contentFocus.current, scroll: viewport.current?.scrollTop ?? 0,
    rails: Object.fromEntries(Array.from(viewport.current?.querySelectorAll<HTMLElement>('[data-rail]') ?? [])
      .map((node) => [node.dataset.rail!, node.scrollLeft])) }; };
  const fail = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      folderHistory.current = [];
      setAuthenticated(false); setFolder(undefined); setHome({ rows: [] });
      if (overlayPage.current !== 'pairing') resetOverlay(null);
    }
    const message = error instanceof Error ? error.message : '连接失败，请检查网络后重试';
    const origin = overlayHistory.current[0];
    if (origin?.page === null) origin.error = message;
    setError(message);
  }, []);
  useLayoutEffect(() => {
    // Cached routes render immediately. Restore their viewport before observers
    // can mistake the previous route's deep scroll for a request for more data.
    finishScrolls(viewport.current);
    if (viewport.current) viewport.current.scrollTop = restore.current?.scroll ?? 0;
  }, [folder]);
  useEffect(() => {
    call<Capabilities>('getCapabilities').then(async (caps) => {
      // Older shells require an explicit connection before pairing can start.
      if (window.MollyBridge && !caps.serverUrl && caps.bridgeVersion === 1) {
        const connection = await call<{ serverUrl: string; authenticated: boolean; childId: string }>('connect', { serverUrl: 'https://mollytime.app' });
        caps = { ...caps, ...connection };
      }
      configureCatalog(!!caps.catalogSync);
      setBridgeCompatible(caps.bridgeVersion === 1);
      setCapabilities(caps); setAuthenticated(caps.authenticated);
      // Once authenticated, the catalog request owns its loading state.
      if (!caps.authenticated) setBusy(false);
      return call('ready', { webVersion: caps.webVersion ?? '' });
    }).catch((failure) => { fail(failure); setBusy(false); });
  }, [fail]);
  useEffect(() => {
    if (!capabilities?.catalogSync) return;
    const applyStatus = (value: SyncStatus) => {
      setSyncStatus(value);
      if (value.supported === false) { configureCatalog(false); setCapabilities((old) => old ? { ...old, catalogSync: false } : old); }
    };
    const status = (event: Event) => applyStatus((event as CustomEvent<SyncStatus>).detail);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = (event: Event) => {
      const collection = (event as CustomEvent<{ collection: string }>).detail.collection;
      if (collection === 'authorization') { fail(new ApiError('电视授权已失效，请重新绑定', 401)); return; }
      if (playing || collection === 'status' || collection.startsWith('folder:') && collection !== `folder:${folder?.id}`) return;
      clearTimeout(timer);
      timer = setTimeout(() => setReload((value) => value + 1), 100);
    };
    const resumed = () => { if (!document.hidden) void call('catalogSync').catch(() => {}); };
    void call<SyncStatus>('catalogStatus').then(applyStatus).catch(() => {});
    window.addEventListener('molly:catalogStatus', status);
    window.addEventListener('molly:catalogChanged', changed);
    window.addEventListener('online', resumed);
    document.addEventListener('visibilitychange', resumed);
    return () => { clearTimeout(timer); window.removeEventListener('molly:catalogStatus', status); window.removeEventListener('molly:catalogChanged', changed); window.removeEventListener('online', resumed); document.removeEventListener('visibilitychange', resumed); };
  }, [capabilities?.catalogSync, folder?.id, playing, fail]);
  useEffect(() => {
    const incompatible = () => {
      setCompatibilityWarning('此网页版本需要更新电视客户端才能使用。');
      openOverlay('client-update');
      void checkClientUpdate();
    };
    window.addEventListener('molly:webUpdateIncompatible', incompatible);
    return () => window.removeEventListener('molly:webUpdateIncompatible', incompatible);
  }, []);
  useEffect(() => {
    const available = () => {
      void checkClientUpdate();
      openOverlay('client-update');
    };
    window.addEventListener('molly:clientUpdateAvailable', available);
    return () => window.removeEventListener('molly:clientUpdateAvailable', available);
  }, []);
  useEffect(() => {
    const serial = ++loadSerial.current;
    appended.current = false;
    setPageStates({});
    if (!authenticated) { setReadyToAppend(false); homeCache.current = undefined; playlistCache.current = undefined; return; }
    const scope = capabilities?.serverUrl ?? '';
    setError(''); setRefreshError('');
    const cachedHome = homeCache.current?.scope === scope ? homeCache.current : undefined;
    const cachedPlaylist = playlistCache.current?.scope === scope && playlistCache.current.folder === folder?.id ? playlistCache.current : undefined;
    const cachedPlaylistData = cachedPlaylist?.data;
    const cachedHomeData = cachedHome?.data;
    const cached = folder ? cachedPlaylist : cachedHome;
    setReadyToAppend(!!cached && !restore.current);
    // A return must never unmount a usable catalog, its covers, or its focus.
    setBusy(!cached);
    if (cached) {
      if (folder) setPlaylist(cachedPlaylist!.data);
      else setHome(cachedHome!.data);
      if (cached.reload === reload) return () => { loadSerial.current++; };
    }
    const active = () => serial === loadSerial.current;
    const preserveFocus = (hasFocusedItem: boolean) => {
      if (!cached) return;
      const focusedCard = document.querySelector('button.poster[data-focused="true"]');
      if (hasFocusedItem || !focusedCard) appended.current = true;
      else restore.current = snapshot();
    };
    const task = folder ? loadPlaylist(folder.id, cachedPlaylist?.data, active).then((data) => {
      if (serial === loadSerial.current) {
        if (data.unavailable) {
          const previous = folderHistory.current.pop();
          playlistCache.current = previous?.cache;
          setPlaylist(previous?.cache?.data);
          restore.current = previous?.snapshot ?? homeSnapshot.current;
          setFolder(previous?.folder);
          return;
        }
        // Browsing may append a page while the refresh is in flight. Never
        // replace newer user-visible data with an older refresh snapshot.
        if (cachedPlaylist && playlistCache.current?.data !== cachedPlaylistData) return;
        preserveFocus(playlistItems(data).some((item) => playlistFocus(item) === getCurrentFocusKey()) ||
          `episode-${data.resumeEpisode?.id}` === getCurrentFocusKey());
        playlistCache.current = { scope, reload, folder: folder.id, data };
        setPlaylist(data);
      }
    }) : loadHome(cachedHome?.data, active).then((data) => {
      if (serial === loadSerial.current) {
        if (cachedHome && homeCache.current?.data !== cachedHomeData) return;
        preserveFocus(data.rows.some((row, rowIndex) => row.items.some((item) => homeFocus(rowIndex, item, data.rows) === getCurrentFocusKey())));
        homeCache.current = { scope, reload, data };
        setHome(data);
      }
    });
    task.catch((error) => {
      if (serial !== loadSerial.current) return;
      if (!cached || error instanceof ApiError && error.status === 401) fail(error);
      else setRefreshError('内容暂未更新，仍可继续浏览，请稍后重试。');
    })
      .finally(() => { if (serial === loadSerial.current) setBusy(false); });
    return () => { loadSerial.current++; };
  }, [authenticated, folder, reload, fail, capabilities?.serverUrl]);

  const loadMore = (rowId = 'playlist', retry = false) => {
    if (busy || !readyToAppend || overlay || playing || (!retry && pageStates[rowId]?.error)) return;
    const row = home.rows.find((item) => item.id === rowId);
    const current = folder ? playlist : row;
    if (!current || !(folder ? playlistHasMore(playlist) : current.hasMore)) return;
    const serial = loadSerial.current;
    const key = `${serial}:${rowId}`;
    if (pageRequests.current.has(key)) return;
    pageRequests.current.add(key);
    setPageStates((state) => ({ ...state, [rowId]: { loading: true } }));
    const task = folder ? catalogRequest<Playlist>(`/api/series/${folder.id}/playlist`, (current.page ?? 1) + 1).then((more) => {
      if (serial !== loadSerial.current) return;
      appended.current = true;
      if (getCurrentFocusKey() === 'more-playlist' && playlistItems(more)[0]) {
        restore.current = { ...snapshot(), focus: playlistFocus(playlistItems(more)[0]) };
      }
      const data = { ...more, episodes: appendItems(videos, more.episodes), items: appendItems(entries, more.items) };
      if (playlistCache.current) playlistCache.current.data = data;
      setPlaylist(data);
    }) : catalogRequest<Home>('/api/home', (current.page ?? 1) + 1, rowId).then((more) => {
      if (serial !== loadSerial.current) return;
      const next = more.rows[0];
      if (!next || next.id !== rowId) throw new ApiError('栏目已更新，请重新打开媒体库');
      appended.current = true;
      if (getCurrentFocusKey() === `more-${rowId}` && next.items[0]) {
        restore.current = { ...snapshot(), focus: homeFocus(home.rows.findIndex((item) => item.id === rowId), next.items[0]) };
      }
      // Other rows may finish loading concurrently.
      setHome((previous) => {
        const data = appendRow(previous, next);
        if (homeCache.current) homeCache.current.data = data;
        return data;
      });
    });
    void task.catch((failure) => {
      if (serial !== loadSerial.current) return;
      if (failure instanceof ApiError && failure.status === 401) fail(failure);
      else setPageStates((state) => ({ ...state, [rowId]: { error: failure instanceof Error ? failure.message : '加载失败，请重试' } }));
    }).finally(() => {
      pageRequests.current.delete(key);
      if (serial === loadSerial.current) setPageStates((state) => ({ ...state, [rowId]: { ...state[rowId], loading: false } }));
    });
  };

  useLayoutEffect(() => {
    if (playing || (busy && (!overlay || overlay === 're-pair'))) return;
    // Appending cards keeps existing DOM focus and scroll position. Do not run
    // the route-entry focus reset after every background batch.
    if (appended.current) {
      appended.current = false;
      if (!restore.current) { setReadyToAppend(true); return; }
    }
    // Focus registrations run in effects. Restore on the next frame instead of
    // adding a fixed delay after every return, including already-mounted cards.
    const input = navigationInput.current;
    const frame = requestAnimationFrame(() => {
      if (navigationInput.current !== input) { restore.current = undefined; setReadyToAppend(true); return; }
      const saved = restore.current;
      const fallback = overlay === 're-pair' ? 'cancel-re-pair' : overlay === 'pairing' ? 'pairing-refresh' :
        overlay === 'watch-rest' ? 'watch-rest-home' : overlay === 'watch-control' ? 'watch-parent-main' : overlay === 'live-tv' ? 'live-refresh' : overlay === 'settings' ? (authenticated ? 're-pair' : 'close-overlay') : overlay === 'client-update' ? (updateActionable ? 'client-update-action' : 'close-overlay') : !authenticated ? (capabilities?.devicePairing ? 'pairing-refresh' : 'pairing-settings') : error ? 'retry' :
        (folder ? (entries.length ? playlistFocus(entries[0]) : 'folder-back') : home.rows[0]?.items[0] ? homeFocus(0, home.rows[0].items[0]) : 'content');
      const has = (key: string) => !!document.querySelector(`[data-focus="${key}"]`);
      const canRestore = saved && has(saved.focus);
      const target = canRestore ? saved.focus : fallback;
      const next = has(target) ? target : overlay ? 'close-overlay' : 'content';
      if (!canRestore && viewport.current && !overlay) viewport.current.scrollTop = 0;
      setFocus(next);
      finishScrolls(viewport.current);
      if (canRestore && viewport.current) {
        viewport.current.scrollTop = saved.scroll;
        viewport.current.querySelectorAll<HTMLElement>('[data-rail]').forEach((node) => { node.scrollLeft = saved.rails[node.dataset.rail!] ?? 0; });
      }
      restore.current = undefined;
      setReadyToAppend(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [busy, playing, authenticated, folder, videos, entries, resumeId, home, error, overlay, capabilities?.serverUrl, capabilities?.clientUpdates]);


  useEffect(() => {
    if (!authenticated || capabilities?.catalogSync) return;
    let alive = true, checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try { await request('/api/me'); }
      catch (failure) { if (alive && failure instanceof ApiError && failure.status === 401) fail(failure); }
      finally { checking = false; }
    };
    const resumed = () => { if (document.visibilityState === 'visible') void check(); };
    void check();
    const timer = setInterval(() => { void check(); }, 30000);
    document.addEventListener('visibilitychange', resumed);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', resumed); };
  }, [authenticated, capabilities?.catalogSync, fail]);

  const closeOverlay = useCallback(() => {
    if (overlay === 're-pair' && busy) return;
    finishScrolls(viewport.current);
    motion.direction.current = 'back';
    const previous = overlayHistory.current.pop();
    restore.current = previous?.snapshot;
    overlayPage.current = previous?.page ?? null;
    setError(previous?.error ?? ''); setOverlay(overlayPage.current);
  }, [overlay, busy]);
  const restShown = useRef('');
  const watchedRound = useRef('');
  useEffect(() => {
    const state = watch.state;
    if (state?.status === 'allowed') {
      watchedRound.current = state.round?.id ?? '';
      if (overlay === 'watch-rest') resetOverlay(null);
      return;
    }
    if (!state?.enabled || state.status !== 'resting' || playing || overlay) return;
    const key = `${state.round?.id ?? 'waiting'}:${state.version}`;
    if (!watchedRound.current || watchedRound.current !== state.round?.id || restShown.current === key) return;
    restShown.current = key;
    openOverlay('watch-rest');
  }, [watch.state, playing, overlay]);
  const back = useCallback(() => {
    if (overlay) { closeOverlay(); return true; }
    if (folder) {
      const previous = folderHistory.current.pop();
      restore.current = previous?.snapshot ?? homeSnapshot.current;
      if (previous) { playlistCache.current = previous.cache; setPlaylist(previous.cache?.data); }
      setFolder(previous?.folder);
      return true;
    }
    return false;
  }, [folder, overlay, closeOverlay]);
  useEffect(() => {
    window.mollyBack = back;
    const menu = () => {
      if (!playing && !overlay && canOpenSettings) openOverlay('settings');
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key.startsWith('Arrow')) { navigationInput.current++; restore.current = undefined; }
      if (event.key === 'ContextMenu' || event.key === 'Menu' || event.keyCode === 93) {
        event.preventDefault();
        if (!event.repeat) menu();
        return;
      }
      if (event.key === 'Escape' || event.key === 'BrowserBack' || event.keyCode === 461 || event.keyCode === 10009) {
        if (event.repeat) { event.preventDefault(); return; }
        if (back()) event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('molly:menu', menu);
    return () => { delete window.mollyBack; window.removeEventListener('keydown', onKey); window.removeEventListener('molly:menu', menu); };
  }, [back, playing, overlay, openOverlay, canOpenSettings]);
  useEffect(() => {
    const returned = (event: Event) => {
      setPlaying(false);
      const progress = readPlaybackReturn((event as CustomEvent).detail);
      // Older shells and interrupted startup may not return a trustworthy
      // position. Keep the refresh fallback for those cases.
      if (!progress) { setReload((value) => value + 1); return; }
      loadSerial.current++;
      appended.current = false;
      setPageStates({});
      const cachedPlaylist = playlistCache.current;
      const episode = cachedPlaylist?.data.episodes.find((item) => item.id === progress.episodeId) ??
        (cachedPlaylist?.data.resumeEpisode?.id === progress.episodeId ? cachedPlaylist.data.resumeEpisode : undefined);
      if (homeCache.current) homeCache.current.data = updateHomeProgress(homeCache.current.data, progress, episode);
      setHome((current) => updateHomeProgress(current, progress, episode));
      if (cachedPlaylist) {
        const next = updatePlaylistProgress(cachedPlaylist.data, progress);
        if (next) {
          cachedPlaylist.data = next;
          if (folder?.id === cachedPlaylist.folder) setPlaylist(next);
        } else if (folder?.id === cachedPlaylist.folder) {
          // Auto-play may have reached an episode outside the loaded pages.
          setReload((value) => value + 1);
        }
      }
    };
    window.addEventListener('molly:playbackClosed', returned);
    return () => window.removeEventListener('molly:playbackClosed', returned);
  }, [folder]);

  const completePairing = useCallback(() => {
    setError(''); resetOverlay(null); restore.current = undefined; setAuthenticated(true);
  }, []);
  const play = async (id: string) => {
    if (playing) return;
    restore.current = snapshot(); setPlaying(true); setError('');
    try {
      if (!window.MollyBridge || capabilities?.watchControl) {
        const state = await readWatchControl().catch(() => watch.state);
        if (state) watch.setState(state);
        if (state?.enabled && state.status === 'allowed' && state.round?.mode === 'episodes' && state.round.episodeId && state.round.episodeId !== id && state.round.cursor + 1 >= state.round.amount) {
          setPlaying(false); openOverlay('watch-control'); setError('今日集数已用完，可以继续当前视频，或请家长加看。'); return;
        }
        if (state?.enabled && state.status !== 'allowed') {
          setPlaying(false); openOverlay('watch-control'); return;
        }
      }
      await call('playEpisode', { episodeId: id });
    }
    catch (error) { setPlaying(false); fail(error); }
  };
  const rePair = async () => {
    setBusy(true); setError('');
    try {
      await call('pairingReset');
      loadSerial.current++;
      folderHistory.current = [];
      setAuthenticated(false); setFolder(undefined); setHome({ rows: [] });
      restore.current = undefined; contentFocus.current = '';
      resetOverlay('pairing');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '无法断开，请检查网络后重试'); }
    finally { setBusy(false); }
  };
  const remember = (key: string) => {
    contentFocus.current = key;
  };
  const cardArrow = (firstRow: boolean) => (direction: string) => {
    if (direction === 'up' && firstRow) {
      const current = document.querySelector<HTMLElement>(`[data-focus="${getCurrentFocusKey()}"]`);
      if (current?.closest('.episode-grid') && !isFirstGridRow(current)) return true;
      if (folder) { folderGridFocus.current = getCurrentFocusKey(); setFocus('folder-back'); }
      return false;
    }
    return true;
  };
  const activateCard = useCatalogCallback((item: Series) => {
    if (folder?.id === item.id) return;
    if (item.type === 'episode') void play(item.id);
    else {
      if (folder) folderHistory.current.push({ folder, snapshot: snapshot(), cache: playlistCache.current });
      else { homeSnapshot.current = snapshot(); folderHistory.current = []; }
      setPlaylist(undefined); setBusy(true);
      setFolder(item);
    }
  });
  const loadCardPage = useCatalogCallback((rowId: string) => loadMore(rowId));
  const rememberCard = useCallback((key: string) => { contentFocus.current = key; }, []);
  const cardArrowRef = useRef(cardArrow);
  useLayoutEffect(() => { cardArrowRef.current = cardArrow; });
  const navigateCard = useCallback((direction: string, firstRow: boolean) => cardArrowRef.current(firstRow)(direction), []);

  const updateDetails = <div className="client-update-panel" data-phase={clientUpdate?.phase}>
    {compatibilityWarning && <p role="alert" className="error">{compatibilityWarning}</p>}
    <div className="update-state-line">
      <p role="status" className="update-state">{clientUpdate?.message ?? '正在检查更新…'}</p>
      {clientUpdate?.release && <span className="update-package">{clientUpdate.phase !== 'available' && `版本 ${clientUpdate.release.versionName} · `}{Math.ceil(clientUpdate.release.size / (1024 * 1024))} MB</span>}
    </div>
    {['downloading', 'preparing'].includes(clientUpdate?.phase ?? '') && <div className="update-progress" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={clientUpdate?.percent ?? 0}>
      <span style={{ width: `${clientUpdate?.percent ?? 0}%` }} />
    </div>}
    {clientUpdate?.release?.notes && <div className="update-notes"><h3>本次更新</h3><p>{clientUpdate.release.notes}</p></div>}
    {updateActionable && <FocusButton focusKey="client-update-action" className="update-action" onClick={() => { void updateClient(); }}>{updateActionLabel}</FocusButton>}
  </div>;
  const updateCard = <section className="update-card" aria-label="软件更新">
    <div className="update-card-heading">
      <div><h2>软件更新</h2><p className="update-current">当前版本 {capabilities?.shellVersion}</p></div>
    </div>
    {(clientUpdate || overlay === 'client-update') && updateDetails}
  </section>;

  if (!authenticated && !busy && bridgeCompatible && capabilities && !overlay) {
    return <FocusRegion focusKey="screen" className="app">
      <FocusRegion focusKey="content" className="pairing-screen" boundary>
        <header className="pairing-screen-header"><Brand />
          {canOpenSettings && <FocusButton focusKey="pairing-settings" className="settings-trigger" ariaLabel="打开设置" onClick={() => openOverlay('settings')}><Icon name="settings" /><span>设置</span></FocusButton>}
        </header>
        <PairingPanel capabilities={capabilities} done={completePairing} />
        {error && <p role="alert" className="error">{error}</p>}
      </FocusRegion>
    </FocusRegion>;
  }

  return <FocusRegion focusKey="screen" className="app">
    <main ref={motion.homeRef} inert={!!overlay} aria-hidden={overlay ? true : undefined} className={`content-shell ${folder ? 'detail-page' : 'home-page'}`}>
      <FocusRegion focusKey="content" className="content-panels shelves-scroll" scrollRef={viewport}>
      <div className="topbar">
        <Brand />
        {authenticated && syncStatus?.supported !== false && syncStatus && <span className="sync-status" role="status">{syncStatus.message || (!syncStatus.online ? '离线浏览' : syncStatus.catalogComplete ? '内容已同步' : syncStatus.paused ? '同步已暂停' : '正在同步内容')}{!syncStatus.online && syncStatus.lastSync ? ` · 上次同步 ${new Date(syncStatus.lastSync).toLocaleDateString('zh-CN')}` : ''}</span>}
        {authenticated && (!window.MollyBridge || watch.state?.enabled) && <div className="topbar-actions">
          {authenticated && watch.state?.enabled && <WatchQuota state={watch.state} />}
          {!window.MollyBridge && <FocusButton focusKey="browser-settings" className="settings-trigger" ariaLabel="打开设置" onClick={() => openOverlay('settings')}><Icon name="settings" /><span>设置</span></FocusButton>}
        </div>}
      </div>
        {authenticated && (folder ? <DetailHeader series={folder} path={folderHistory.current.map(entry => entry.folder)} total={playlist?.total ?? folder.episodeCount} loading={busy} onBack={back} onDown={() => {
          const saved = folderGridFocus.current;
          setFocus(entries.some(item => playlistFocus(item) === saved) ? saved : entries[0] ? playlistFocus(entries[0]) : 'folder-back');
        }} /> : <HomeGreeting />)}
        <FocusRegion focusKey="shelves" className="shelf-list">
          {refreshError && <div className="catalog-notice"><span role="status">{refreshError}</span><FocusButton focusKey="refresh-retry" onClick={() => setReload((value) => value + 1)} className="text-button">重试更新</FocusButton></div>}
          {!bridgeCompatible && !busy ? <div className="state connect-state"><h1>网页需要更新电视客户端</h1><p>当前网页与客户端能力不兼容，请检查并安装客户端更新。</p><FocusButton focusKey="check-client-compat" className="primary" onClick={() => { openOverlay('client-update'); void checkClientUpdate(); }}>检查客户端更新</FocusButton></div> : !authenticated && !busy ? <div className="state connect-state"><h1><Brand /></h1><p>用手机绑定电视，开始观看。</p></div> : busy ? (!folder ? <HomeLoading /> : <div role="status" className="state">正在加载内容…</div>) : (!error || overlay) && (folder ? <Shelf focusKey="folder-videos" title="文件夹与视频" kind="episode-shelf" initialFocusKey={restore.current?.focus ?? (entries[0] ? playlistFocus(entries[0]) : undefined)} virtualize={!!capabilities?.catalogSync}>
            {entries.map((item, index) => <CatalogCard key={item.id} item={item} focusKey={playlistFocus(item)} disabled={!!overlay}
              firstRow nearEnd={index >= entries.length - 8} rowId="playlist" playable={item.type !== 'folder'}
              subtitle={`${item.id === resumeId ? '继续观看 · ' : ''}${watchedPosition(item) || duration(item.runtimeMs)}`}
              onActivate={activateCard} onRemember={rememberCard} onLoad={loadCardPage} onArrow={navigateCard} />)}
            {playlistHasMore(playlist) && <LoadMore focusKey="more-playlist" loading={pageStates.playlist?.loading} error={pageStates.playlist?.error}
              disabled={!!overlay || playing || !readyToAppend} onLoad={() => loadMore()} onRetry={() => loadMore('playlist', true)} onFocus={() => remember('more-playlist')} />}
          </Shelf> : home.rows.map((row, rowIndex) => {
            const rowKey = `home-row-${capabilities?.catalogSync ? row.id ?? rowIndex : rowIndex}`;
            return <Shelf key={rowKey} focusKey={rowKey} title={row.title} initialFocusKey={restore.current?.focus} virtualize={!!capabilities?.catalogSync} kind={row.id === 'library' || row.title === '我的媒体库' ? 'library-shelf' : ''}>
              {row.items.map((item, index) => <CatalogCard key={item.id} item={item} focusKey={homeFocus(rowIndex, item)} disabled={!!overlay}
                firstRow={rowIndex === 0} nearEnd={!!row.id && index >= row.items.length - 8} rowId={row.id ?? ''}
                playable={item.type === 'episode'} subtitle={item.type === 'episode' ? episodeAction(item) : ''}
                onActivate={activateCard} onRemember={rememberCard} onLoad={loadCardPage} onArrow={navigateCard} />)}
              {row.id && row.hasMore && <LoadMore focusKey={`more-${row.id}`} loading={pageStates[row.id]?.loading} error={pageStates[row.id]?.error}
                disabled={!!overlay || playing || !readyToAppend} onLoad={() => loadMore(row.id)} onRetry={() => loadMore(row.id, true)} onFocus={() => remember(`more-${row.id}`)} />}
            </Shelf>;
          }))}
          {authenticated && !busy && !error && (folder ? entries.length === 0 : home.rows.length === 0) &&
            <div className="state empty-state"><h2>媒体库还没有内容</h2><p>请家长在管理后台上传并发布视频。</p></div>}
          {authenticated && !overlay && error && <div className="state"><p role="alert" className="error">{error}</p><FocusButton focusKey="retry" className="primary" onClick={() => {
            setError(''); setReload((value) => value + 1);
          }}>重试</FocusButton><FocusButton focusKey="load-error-settings" className="text-button" onClick={() => openOverlay('settings')}>打开设置</FocusButton></div>}
        </FocusRegion>
      </FocusRegion>
      {playing && <footer><span role="status" className="player-status">正在打开播放器…</span></footer>}
    </main>
    {overlay && <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="overlay-title">
      <FocusRegion focusKey="overlay" className={`overlay-panel ${overlay === 'pairing' ? 'account-panel' : 'settings-panel'} ${overlay === 'watch-control' ? 'watch-control-shell' : ''}`} boundary>
        <div key={overlay} ref={motion.panelRef} className="overlay-page">
          <h1 id="overlay-title" hidden={overlay === 'watch-control' || overlay === 'pairing'}>{overlay === 'pairing' ? '绑定电视' : overlay === 're-pair' ? '重新配对？' : overlay === 'client-update' ? '客户端更新' : overlay === 'live-tv' ? '电视直播（实验）' : overlay === 'watch-rest' ? '看完啦，休息一下吧。' : overlay === 'watch-control' ? '观看安排' : '电视设置'}</h1>
          {overlay === 're-pair' ? <div className="re-pair-confirm">
            <p>重新配对会断开当前家庭媒体库，需要家长再次输入配对码确认。</p>
            {window.MollyBridge && !capabilities?.devicePairingReset && <p className="error">请先更新电视客户端，再重新配对。</p>}
            <div className="re-pair-actions"><FocusButton focusKey="cancel-re-pair" className="settings-action settings-secondary" disabled={busy} onClick={closeOverlay}>取消</FocusButton>
              <FocusButton focusKey="confirm-re-pair" className="primary settings-action" disabled={busy || (!!window.MollyBridge && !capabilities?.devicePairingReset)} onClick={() => { void rePair(); }}>{busy ? '正在断开…' : '确认重新配对'}</FocusButton></div>
          </div> : overlay === 'watch-rest' ? <section className="watch-parent-panel"><p>{watch.state?.round?.mode === 'minutes' ? '已保存进度，下次可以接着看。' : '今日观看已结束，明天 0 点自动恢复。'}</p><div className="watch-parent-actions"><FocusButton focusKey="watch-rest-home" className="primary settings-action" onClick={() => { setFolder(undefined); folderHistory.current = []; closeOverlay(); }}>返回首页</FocusButton><FocusButton focusKey="watch-rest-parent" className="settings-action settings-secondary" onClick={() => openOverlay('watch-control')}>家长加看</FocusButton></div></section> : overlay === 'watch-control' ? <WatchControlPanel state={watch.state} close={closeOverlay} backLabel={parentOverlay === 'settings' ? '返回设置' : '返回媒体库'} changed={(state, keepOpen) => { watch.setState(state); if (!keepOpen) { setFolder(undefined); folderHistory.current = []; resetOverlay(null); } }} /> : overlay === 'live-tv' ? <LiveTv capabilities={capabilities} /> : overlay === 'client-update' ? updateCard : overlay === 'pairing' ? <PairingPanel capabilities={capabilities} done={completePairing} /> : <div className="settings-list">
            {window.MollyBridge && capabilities?.clientUpdates && capabilities.serverUrl && updateCard}
            {authenticated && <PlaybackSettings />}
            {authenticated && <FocusButton focusKey="re-pair" ariaLabel="重新配对" className="settings-item" onClick={() => { openOverlay('re-pair'); }}><Icon name="people" /><span><strong>重新配对</strong><small>换一个家庭媒体库</small></span><span>›</span></FocusButton>}
            {authenticated && (!window.MollyBridge || capabilities?.watchControl) && <FocusButton focusKey="open-watch-control" className="settings-item" onClick={() => openOverlay('watch-control')}><Icon name="play" /><span><strong>观看安排</strong><small>每日额度、加看或结束今日观看</small></span><span>›</span></FocusButton>}
            {authenticated && liveTvEnabled && <FocusButton focusKey="open-live-tv" className="settings-item" onClick={() => openOverlay('live-tv')}><Icon name="play" /><span><strong>电视直播（实验）</strong><small>观看运营提供的直播频道</small></span><span>›</span></FocusButton>}
          </div>}
          {error && <p role="alert" className="error">{error}</p>}
          {!(overlay === 'settings' && authenticated) && overlay !== 're-pair' && overlay !== 'watch-rest' && overlay !== 'watch-control' && <FocusButton focusKey="close-overlay" className="settings-action settings-secondary" onClick={closeOverlay}>{parentOverlay === 'settings' ? '返回设置' : authenticated ? '返回媒体库' : '返回绑定页'}</FocusButton>}
        </div>
      </FocusRegion>
    </div>}
  </FocusRegion>;
}
createRoot(document.getElementById('root')!).render(<><App /><BrowserPlaybackHost /></>);
