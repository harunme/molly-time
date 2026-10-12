import { BrowserPlaybackHost } from './playback';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentFocusKey, init, setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { ApiError, call, request, type Capabilities, type Child, type Episode, type Home, type Season, type Series } from './api';
import { finishScrolls, FocusButton, FocusRegion } from './focus';
import { Cover, Feature, Icon, Shelf, tone } from './content';
import { PairingPanel } from './pairing';
import './style.css';

init({ debug: false, visualDebug: false, throttle: 100, shouldFocusDOMNode: true,
  domNodeFocusOptions: { preventScroll: true }, shouldUseNativeEvents: true });

type Route = { kind: 'home' } | { kind: 'series'; series: Series } | { kind: 'season'; series: Series; season: Season };
type ViewSnapshot = { focus: string; scroll: number; rails: Record<string, number> };
type RouteSnapshot = ViewSnapshot & { route: Route };
type Overlay = 'children' | 'settings' | 'pairing' | 're-pair' | null;
const homeFocus = (row: number, item: Series) => row === 0 ? `series-${item.id}` : `home-${row}-${item.id}`;
const duration = (ms?: number) => ms ? `${Math.ceil(ms / 60000)} 分钟` : '';

function App() {
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [authenticated, setAuthenticated] = useState(false);
  const [route, setRoute] = useState<Route>({ kind: 'home' });
  const [home, setHome] = useState<Home>({ rows: [] });
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [seriesDetail, setSeriesDetail] = useState<Series>();
  const [children, setChildren] = useState<Child[]>([]);
  const [child, setChild] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTarget = useRef('back');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [selectingChild, setSelectingChild] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [preview, setPreview] = useState<Series | Episode>();
  const [activePositions, setActivePositions] = useState<Record<string, number>>({});
  const [playing, setPlaying] = useState(false);
  const history = useRef<RouteSnapshot[]>([]);
  const contentFocus = useRef('');
  const restore = useRef<ViewSnapshot | undefined>(undefined);
  const overlayOrigin = useRef('');
  const viewport = useRef<HTMLDivElement>(null);
  const loadSerial = useRef(0);

  const snapshot = (): ViewSnapshot => { finishScrolls(viewport.current); return { focus: contentFocus.current, scroll: viewport.current?.scrollTop ?? 0,
    rails: Object.fromEntries(Array.from(viewport.current?.querySelectorAll<HTMLElement>('[data-rail]') ?? [])
      .map((node) => [node.dataset.rail!, node.scrollLeft])) }; };
  const fail = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      setAuthenticated(false); setHome({ rows: [] }); setPreview(undefined); setChildren([]);
      setOverlay((current) => current === 'pairing' ? 'pairing' : null); history.current = []; setRoute({ kind: 'home' });
    }
    setError(error instanceof Error ? error.message : '连接失败，请检查网络后重试');
  }, []);
  useEffect(() => {
    call<Capabilities>('getCapabilities').then((caps) => {
      if (caps.bridgeVersion !== 1) throw new Error('网页与电视版本不兼容，请更新电视客户端');
      setCapabilities(caps); setAuthenticated(caps.authenticated); setChild(caps.childId);
      return call('ready');
    }).catch(fail).finally(() => setBusy(false));
  }, [fail]);
  useEffect(() => {
    if (!authenticated) return;
    let canceled = false;
    request<Child[]>('/api/families/me/children').then((data) => { if (!canceled) setChildren(data); }).catch((failure) => { if (!canceled) fail(failure); });
    return () => { canceled = true; };
  }, [authenticated, fail]);
  useEffect(() => {
    if (!authenticated) return;
    const serial = ++loadSerial.current;
    setBusy(true); setError(''); setActivePositions({});
    const task = route.kind === 'home' ? request<Home>('/api/home').then((data) => {
      if (serial === loadSerial.current) { setHome(data); setPreview(data.rows[0]?.items[0]); }
    }) : route.kind === 'series' ? request<{ series?: Series; seasons: Season[] }>(`/api/series/${route.series.id}`).then((data) => {
      if (serial === loadSerial.current) { setSeriesDetail(data.series ?? route.series); setSeasons(data.seasons.filter((season) => season.episodeCount !== 0)); setPreview(route.series); }
    }) : request<{ episodes: Episode[] }>(`/api/seasons/${route.season.id}`).then((data) => {
      if (serial === loadSerial.current) { setEpisodes(data.episodes); setPreview(data.episodes[0]); }
    });
    task.catch((error) => { if (serial === loadSerial.current) fail(error); })
      .finally(() => { if (serial === loadSerial.current) setBusy(false); });
    return () => { loadSerial.current++; };
  }, [authenticated, route, reload, fail]);

  useEffect(() => {
    if (busy || playing) return;
    const timer = setTimeout(() => {
      const saved = restore.current;
      const fallback = overlay === 're-pair' ? 'cancel-re-pair' : overlay === 'pairing' ? 'pairing-refresh' : overlay === 'children' ? `child-${child || children[0]?.id}` :
        overlay === 'settings' ? (window.MollyBridge ? 'connection' : authenticated ? 're-pair' : 'connect-account') : !authenticated ? 'connect-home' : error ? 'retry' :
        route.kind === 'home' ? (home.rows[0]?.items[0] ? homeFocus(0, home.rows[0].items[0]) : 'menu') :
        route.kind === 'series' ? `season-${seasons[0]?.id}` : `episode-${episodes[0]?.id}`;
      const has = (key: string) => !!document.querySelector(`[data-focus="${key}"]`);
      const canRestore = saved && has(saved.focus);
      const target = canRestore ? saved.focus : fallback;
      const next = has(target) ? target : overlay ? 'close-overlay' : 'menu';
      if (['back', 'children', 'settings', 'connect-sidebar'].includes(next) && !menuOpen) {
        menuTarget.current = next; setMenuOpen(true);
      } else setFocus(next);
      finishScrolls(viewport.current);
      if (canRestore && viewport.current) {
        viewport.current.scrollTop = saved.scroll;
        viewport.current.querySelectorAll<HTMLElement>('[data-rail]').forEach((node) => { node.scrollLeft = saved.rails[node.dataset.rail!] ?? 0; });
      } else if (viewport.current && !overlay) viewport.current.scrollTop = 0;
      restore.current = undefined;
    }, 60);
    return () => clearTimeout(timer);
  }, [busy, playing, authenticated, route, home, seasons, episodes, error, overlay, children, child]);

  useEffect(() => {
    if (!menuOpen) return;
    const frame = requestAnimationFrame(() => setFocus(menuTarget.current));
    return () => cancelAnimationFrame(frame);
  }, [menuOpen]);
  const showMenu = () => { menuTarget.current = 'back'; setMenuOpen(true); };
  const hideMenu = useCallback(() => {
    setMenuOpen(false);
    const saved = contentFocus.current;
    const first = document.querySelector<HTMLButtonElement>('.poster:not(:disabled)');
    const target = saved && document.querySelector(`[data-focus="${saved}"]`) ? saved :
      first?.dataset.focus ?? (!authenticated ? 'connect-home' : error ? 'retry' : 'menu');
    setFocus(target);
  }, [authenticated, error]);

  useEffect(() => {
    if (!authenticated) return;
    let alive = true, checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try { await request('/api/me'); }
      catch (failure) { if (alive && failure instanceof ApiError && failure.status === 401) fail(failure); }
      finally { checking = false; }
    };
    const resumed = () => { if (document.visibilityState === 'visible') void check(); };
    const timer = setInterval(() => { void check(); }, 30000);
    document.addEventListener('visibilitychange', resumed);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', resumed); };
  }, [authenticated, fail]);

  const navigate = (next: Route) => { history.current.push({ route, ...snapshot() }); setRoute(next); };
  const openOverlay = (next: Overlay) => {
    overlayOrigin.current = getCurrentFocusKey() || 'back'; setError(''); setOverlay(next);
  };
  const closeOverlay = useCallback(() => {
    if (selectingChild || (overlay === 're-pair' && busy)) return;
    finishScrolls(viewport.current);
    restore.current = { focus: overlay === 're-pair' ? 're-pair' : overlayOrigin.current, scroll: viewport.current?.scrollTop ?? 0, rails: {} };
    // Closing a dialog must not reset the independently scrolled content rows.
    viewport.current?.querySelectorAll<HTMLElement>('[data-rail]').forEach((node) => { restore.current!.rails[node.dataset.rail!] = node.scrollLeft; });
    setError(''); setOverlay(overlay === 're-pair' ? 'settings' : null);
  }, [selectingChild, overlay, busy]);
  const back = useCallback(() => {
    if (overlay) { closeOverlay(); return true; }
    if (menuOpen) { hideMenu(); return true; }
    const last = history.current.pop();
    if (last) { restore.current = last; setRoute(last.route); return true; }
    if (route.kind !== 'home') { setRoute({ kind: 'home' }); return true; }
    return false;
  }, [overlay, closeOverlay, route.kind, menuOpen, hideMenu]);
  useEffect(() => {
    window.mollyBack = back;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'BrowserBack' || event.keyCode === 461 || event.keyCode === 10009) {
        if (back()) event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { delete window.mollyBack; window.removeEventListener('keydown', onKey); };
  }, [back]);
  useEffect(() => {
    const returned = () => {
      setPlaying(false);
      if (route.kind === 'home') setReload((value) => value + 1);
    };
    window.addEventListener('molly:playbackClosed', returned);
    return () => window.removeEventListener('molly:playbackClosed', returned);
  }, [route.kind]);

  const completePairing = useCallback(() => {
    setError(''); setOverlay(null); setMenuOpen(false); restore.current = undefined; setAuthenticated(true);
  }, []);
  const play = async (id: string) => {
    if (playing) return;
    restore.current = snapshot(); setPlaying(true); setError('');
    try { await call('playEpisode', { episodeId: id }); }
    catch (error) { setPlaying(false); fail(error); }
  };
  const rePair = async () => {
    setBusy(true); setError('');
    try {
      await call('pairingReset');
      loadSerial.current++;
      setAuthenticated(false); setChild(''); setChildren([]); setHome({ rows: [] }); setPreview(undefined);
      setSeasons([]); setEpisodes([]); setSeriesDetail(undefined); setActivePositions({});
      history.current = []; restore.current = undefined; contentFocus.current = '';
      setRoute({ kind: 'home' }); setOverlay('pairing');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '无法断开，请检查网络后重试'); }
    finally { setBusy(false); }
  };
  const selectChild = (id: string) => {
    setSelectingChild(true); setError('');
    void request(`/api/children/${id}/select`, 'POST').then(() => {
      setChild(id); setOverlay(null); setMenuOpen(false); history.current = []; restore.current = undefined;
      setRoute({ kind: 'home' }); setReload((value) => value + 1);
    }).catch(fail).finally(() => setSelectingChild(false));
  };
  const selectedChild = children.find((c) => c.id === child);
  const remember = (key: string, item: Series | Episode, rowKey: string, position: number) => {
    setMenuOpen(false); contentFocus.current = key; setPreview(item);
    setActivePositions((old) => old[rowKey] === position ? old : { ...old, [rowKey]: position });
  };
  const cardArrow = (index: number) => (direction: string) => {
    if (direction === 'left' && index === 0) { showMenu(); return false; }
    return true;
  };
  const sidebarArrow = (direction: string) => {
    if (direction === 'right') { hideMenu(); return false; }
    return true;
  };

  const onHome = route.kind === 'home';
  const featured = preview;
  const description = route.kind === 'series' ? seriesDetail?.overview || '' : route.kind === 'season' ?
    `来自「${route.series.name}」 · ${route.season.name}` : (preview && 'overview' in preview ? preview.overview : '') || (preview && 'type' in preview && preview.type === 'episode' ? '从上次看到的位置继续。' : '');
  const metadata = route.kind === 'season' ? duration((preview as Episode)?.runtimeMs) :
    featured && 'type' in featured && featured.type === 'episode' ? duration(featured.runtimeMs) : featured && 'episodeCount' in featured && featured.episodeCount !== undefined ? (featured.episodeCount === 0 ? '暂无剧集' : `${featured.episodeCount} 集`) : '';

  return <FocusRegion focusKey="screen" className="app">
    {menuOpen && <button type="button" className="menu-scrim" tabIndex={-1} aria-label="关闭菜单" onClick={hideMenu} />}
    <FocusRegion focusKey="sidebar" className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`} hidden={!menuOpen} boundary={menuOpen}>
      <div className="wordmark">MollyTime</div>
      <nav aria-label="电视导航">
        <FocusButton focusKey="back" className={`nav-item ${onHome ? 'active' : ''}`} disabled={!!overlay || !menuOpen} onArrow={sidebarArrow} onClick={() => {
          if (onHome) hideMenu();
          else { setMenuOpen(false); history.current = []; setRoute({ kind: 'home' }); }
        }}><Icon name="home" /><span>首页</span></FocusButton>
        {children.length > 0 && <FocusButton focusKey="children" className="nav-item" ariaLabel={selectedChild?.name ?? '选择儿童'} disabled={!!overlay || !menuOpen}
          onArrow={sidebarArrow} onClick={() => openOverlay('children')}><Icon name="people" /><span>谁在看</span></FocusButton>}
        <FocusButton focusKey="settings" className="nav-item" disabled={!!overlay || !menuOpen} onArrow={sidebarArrow} onClick={() => openOverlay('settings')}>
          <Icon name="settings" /><span>设置</span></FocusButton>
      </nav>
      {!authenticated ? <FocusButton focusKey="connect-sidebar" className="viewer connect-viewer" disabled={!!overlay || !menuOpen} onClick={() => openOverlay('pairing')}><Icon name="people" /><span>绑定电视</span></FocusButton> : <div className="viewer"><span className="viewer-avatar">{selectedChild?.name.slice(0, 1) ?? <Icon name="people" />}</span>
        <div><strong>{selectedChild?.name ?? '家庭媒体库'}</strong>{selectedChild && <span>正在观看</span>}</div></div>}
    </FocusRegion>
    <main className="content-shell">
      <div className="topbar"><FocusButton focusKey="menu" className="menu-trigger" ariaLabel="打开菜单" disabled={!!overlay || menuOpen} onClick={showMenu} onArrow={(direction) => { if (direction === 'left') { showMenu(); return false; } return true; }}><Icon name="menu" /></FocusButton>
        <span className="topbar-brand">MollyTime</span>{!onHome && <FocusButton focusKey="route-back" className="route-back" disabled={!!overlay}
        onClick={() => { back(); }}><Icon name="back" /><span>返回</span></FocusButton>}
        <span className="breadcrumbs">{onHome ? '首页' : route.series.name}{route.kind === 'season' && <><b>/</b>{route.season.name}</>}</span>
        <span className="topbar-label">{selectedChild?.name}</span>
      </div>
      <FocusRegion focusKey="content" className="content-panels">
        {authenticated && <Feature item={featured} loading={busy} eyebrow={onHome ? (featured && 'type' in featured && featured.type === 'episode' ? '继续观看' : '') : route.series.name} description={description} meta={metadata}
          label={route.kind === 'season' ? '剧集' : route.kind === 'series' ? '季' : (featured as Series)?.type === 'episode' ? '继续观看' : '系列'} />}
        <FocusRegion focusKey="shelves" className="shelves-scroll" scrollRef={viewport}>
          {!authenticated && !busy ? <div className="state connect-state"><h1>MollyTime</h1><FocusButton focusKey="connect-home" className="primary" onArrow={cardArrow(0)} disabled={!!overlay} onClick={() => openOverlay('pairing')}>绑定家庭媒体库</FocusButton></div> : busy ? <div role="status" className="state">正在加载内容…</div> : (!error || overlay) && (onHome ? home.rows.map((row, rowIndex) => {
            const rowKey = `home-row-${rowIndex}`;
            return <Shelf key={rowKey} focusKey={rowKey} title={row.title} total={row.items.length} position={activePositions[rowKey]}>
              {row.items.map((item, index) => { const key = homeFocus(rowIndex, item); return <FocusButton key={item.id} focusKey={key} className="poster" disabled={!!overlay}
                onArrow={cardArrow(index)} onFocus={() => remember(key, item, rowKey, index + 1)}
                onClick={() => item.type === 'episode' ? void play(item.id) : navigate({ kind: 'series', series: item })}>
                <Cover item={item} /><div className="card-copy"><strong>{item.name}</strong><span>{item.type === 'episode' ? '继续观看' : item.episodeCount === 0 ? '暂无剧集' : item.episodeCount === undefined ? '' : `${item.episodeCount} 集`}<Icon name="play" /></span></div>
              </FocusButton>; })}
            </Shelf>;
          }) : route.kind === 'series' ? <Shelf focusKey="seasons-row" title="选择一季" total={seasons.length} position={activePositions['seasons-row']} kind="season-shelf">
            {seasons.map((season, index) => <FocusButton key={season.id} focusKey={`season-${season.id}`} className="poster season" disabled={!!overlay}
              onArrow={cardArrow(index)} onFocus={() => remember(`season-${season.id}`, { ...seriesDetail ?? route.series, id: season.id, name: season.name, episodeCount: season.episodeCount, image: season.image ?? (seriesDetail ?? route.series).image }, 'seasons-row', index + 1)}
              onClick={() => navigate({ kind: 'season', series: route.series, season })}>
              <Cover item={{ ...route.series, id: season.id, name: season.name, image: season.image ?? route.series.image }} /><div className="card-copy"><strong>{season.name}</strong><span>{season.episodeCount === undefined ? '' : `${season.episodeCount} 集`}<Icon name="play" /></span></div>
            </FocusButton>)}
          </Shelf> : <Shelf focusKey="episodes-row" title={route.season.name} total={episodes.length} position={activePositions['episodes-row']} kind="episode-shelf">
            {episodes.map((episode, index) => <FocusButton key={episode.id} focusKey={`episode-${episode.id}`} className="poster" disabled={!!overlay}
              onArrow={cardArrow(index)} onFocus={() => remember(`episode-${episode.id}`, episode, 'episodes-row', index + 1)} onClick={() => { void play(episode.id); }}>
              <Cover item={episode} /><div className="card-copy"><strong>{episode.name}</strong><span>{duration(episode.runtimeMs) || '播放'}<Icon name="play" /></span></div>
            </FocusButton>)}
          </Shelf>)}
          {authenticated && !busy && !error && (onHome ? home.rows.length === 0 : route.kind === 'series' ? seasons.length === 0 : episodes.length === 0) &&
            <div className="state empty-state"><h2>{onHome ? '媒体库还没有内容' : '这里还没有可看的剧集'}</h2><p>请家长在管理后台上传并发布视频。</p></div>}
          {authenticated && !overlay && error && <div className="state"><p role="alert" className="error">{error}</p><FocusButton focusKey="retry" className="primary" onClick={() => {
            setError(''); setReload((value) => value + 1);
          }}>重试</FocusButton></div>}
        </FocusRegion>
      </FocusRegion>
      <footer><span><span className="keycap">↑ ↓ ← →</span> 选择</span><span><span className="keycap">确定</span> 打开</span><span><span className="keycap">返回</span> 上一页</span>
        {playing && <span role="status" className="player-status">正在打开播放器…</span>}</footer>
    </main>
    {overlay && <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="overlay-title">
      <FocusRegion focusKey="overlay" className={`overlay-panel ${overlay === 'children' ? 'profiles-panel' : overlay === 'pairing' ? 'account-panel' : 'settings-panel'}`} boundary>
        <h1 id="overlay-title">{overlay === 'children' ? '谁在看？' : overlay === 'pairing' ? '扫码绑定电视' : overlay === 're-pair' ? '重新配对？' : '电视设置'}</h1>
        {overlay === 're-pair' ? <div className="re-pair-confirm">
          <p>重新配对会断开当前家庭媒体库，需要家长再次扫码确认。</p>
          {window.MollyBridge && !capabilities?.devicePairingReset && <p className="error">请先更新电视客户端，再重新配对。</p>}
          <div className="re-pair-actions"><FocusButton focusKey="cancel-re-pair" className="text-button" disabled={busy} onClick={closeOverlay}>取消</FocusButton>
            <FocusButton focusKey="confirm-re-pair" className="primary" disabled={busy || (!!window.MollyBridge && !capabilities?.devicePairingReset)} onClick={() => { void rePair(); }}>{busy ? '正在断开…' : '确认重新配对'}</FocusButton></div>
        </div> : overlay === 'pairing' ? <PairingPanel capabilities={capabilities} done={completePairing} /> : overlay === 'children' ? <div className="children-list">{children.map((profile) => <FocusButton key={profile.id} focusKey={`child-${profile.id}`} className="child"
          ariaLabel={profile.name} selected={profile.id === child} disabled={selectingChild} onClick={() => selectChild(profile.id)}>
          <span className="avatar" style={{ '--avatar-tone': tone(profile.id) } as CSSProperties}>{profile.name.slice(0, 1)}</span>
          <strong>{profile.name}</strong><span className="profile-status">{profile.id === child ? <><Icon name="check" />正在观看</> : '选择这个片单'}</span>
        </FocusButton>)}</div> : <div className="settings-list">
          {window.MollyBridge && <FocusButton focusKey="connection" className="settings-item" onClick={() => { void call('connection').catch(fail); }}><Icon name="settings" /><span><strong>连接设置</strong><small>修改家庭媒体库地址</small></span><span>›</span></FocusButton>}
          {!authenticated ? <FocusButton focusKey="connect-account" className="settings-item" onClick={() => openOverlay('pairing')}><Icon name="people" /><span><strong>绑定电视</strong></span><span>›</span></FocusButton> : <FocusButton focusKey="re-pair" ariaLabel="重新配对" className="settings-item" disabled={busy} onClick={() => { setError(''); setOverlay('re-pair'); }}><Icon name="people" /><span><strong>重新配对</strong><small>换一个家庭媒体库</small></span><span>›</span></FocusButton>}
        </div>}
        {selectingChild && <p role="status" className="state">正在打开片单…</p>}
        {error && <p role="alert" className="error">{error}</p>}
        {overlay !== 're-pair' && <FocusButton focusKey="close-overlay" className="text-button" disabled={selectingChild} onClick={closeOverlay}>返回媒体库</FocusButton>}
      </FocusRegion>
    </div>}
  </FocusRegion>;
}
createRoot(document.getElementById('root')!).render(<><App /><BrowserPlaybackHost /></>);
