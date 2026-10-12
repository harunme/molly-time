import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { init, setFocus, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { ApiError, call, request, imageSource, type Capabilities, type Child, type Episode, type Home, type Season, type Series } from './api';
import './style.css';

init({ debug: false, visualDebug: false, throttle: 100, shouldFocusDOMNode: true,
  domNodeFocusOptions: { preventScroll: true }, shouldUseNativeEvents: true });

function FocusButton({ focusKey, children, onClick, className = '', disabled = false, onFocus }: {
  focusKey: string; children: React.ReactNode; onClick: () => void; className?: string; disabled?: boolean; onFocus?: () => void;
}) {
  const { ref, focused, focusSelf } = useFocusable({ focusKey, focusable: !disabled, onEnterPress: onClick,
    onFocus: () => { ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); onFocus?.(); } });
  return <button type="button" ref={ref} data-focus={focusKey} className={`${className} ${focused ? 'focused' : ''}`}
    disabled={disabled} onFocus={() => focusSelf()} onClick={onClick}>{children}</button>;
}

function FocusInput({ focusKey, value, onChange, password = false }: {
  focusKey: string; value: string; onChange: (value: string) => void; password?: boolean;
}) {
  const { ref, focusSelf } = useFocusable({ focusKey });
  return <input ref={ref} data-focus={focusKey} type={password ? 'password' : 'text'}
    autoComplete={password ? 'current-password' : 'username'} value={value}
    onFocus={() => focusSelf()} onChange={(e) => onChange(e.target.value)} />;
}

function Cover({ item }: { item: Series | Episode }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let canceled = false, objectUrl = '';
    setSrc('');
    if (item.image?.url) imageSource(item.image.url).then((url) => {
      objectUrl = url;
      if (canceled && url.startsWith('blob:')) URL.revokeObjectURL(url);
      else if (!canceled) setSrc(url);
    }).catch(() => {});
    return () => { canceled = true; if (objectUrl.startsWith('blob:')) URL.revokeObjectURL(objectUrl); };
  }, [item.image?.url]);
  return <div className="cover">{src ? <img src={src} alt="" loading="lazy" onError={() => setSrc('')} /> :
    <span className="cover-fallback">{item.name.slice(0, 2)}</span>}</div>;
}

type Route = { kind: 'home' } | { kind: 'series'; series: Series } | { kind: 'season'; series: Series; season: Season };
type RouteSnapshot = { route: Route; focus: string; scroll: number };

function App() {
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [authenticated, setAuthenticated] = useState(false);
  const [route, setRoute] = useState<Route>({ kind: 'home' });
  const [home, setHome] = useState<Home>({ rows: [] });
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [children, setChildren] = useState<Child[]>([]);
  const [child, setChild] = useState('');
  const [showChildren, setShowChildren] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [preview, setPreview] = useState<Series>();
  const [playing, setPlaying] = useState(false);
  const history = useRef<RouteSnapshot[]>([]);
  const focus = useRef('');
  const restore = useRef<{ focus: string; scroll: number } | undefined>(undefined);
  const viewport = useRef<HTMLElement>(null);
  const loadSerial = useRef(0);

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) { setAuthenticated(false); history.current = []; setRoute({ kind: 'home' }); }
    setError(e instanceof Error ? e.message : '连接失败，请检查网络后重试');
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
    request<Child[]>('/api/families/me/children').then((data) => { if (!canceled) setChildren(data); }).catch(fail);
    return () => { canceled = true; };
  }, [authenticated, fail]);

  useEffect(() => {
    if (!authenticated) return;
    const serial = ++loadSerial.current;
    setBusy(true); setError('');
    const task = route.kind === 'home' ? request<Home>('/api/home').then((data) => {
      if (serial === loadSerial.current) { setHome(data); setPreview(data.rows[0]?.items[0]); }
    }) : route.kind === 'series' ? request<{ seasons: Season[] }>(`/api/series/${route.series.id}`).then((data) => {
      if (serial === loadSerial.current) setSeasons(data.seasons);
    }) : request<{ episodes: Episode[] }>(`/api/seasons/${route.season.id}`).then((data) => {
      if (serial === loadSerial.current) setEpisodes(data.episodes);
    });
    task.catch((e) => { if (serial === loadSerial.current) fail(e); })
      .finally(() => { if (serial === loadSerial.current) setBusy(false); });
    return () => { loadSerial.current++; };
  }, [authenticated, route, reload, fail]);

  useEffect(() => {
    if (busy) return;
    const timer = setTimeout(() => {
      const snapshot = restore.current;
      const fallback = error ? 'retry' : !authenticated ? 'login' : showChildren ? `child-${children[0]?.id}` :
        route.kind === 'home' ? `series-${home.rows[0]?.items[0]?.id}` :
        route.kind === 'series' ? `season-${seasons[0]?.id}` : `episode-${episodes[0]?.id}`;
      const target = snapshot?.focus && document.querySelector(`[data-focus="${snapshot.focus}"]`) ? snapshot.focus : fallback;
      setFocus(document.querySelector(`[data-focus="${target}"]`) ? target : 'back');
      if (snapshot && viewport.current) viewport.current.scrollTop = snapshot.scroll;
      restore.current = undefined;
    }, 60);
    return () => clearTimeout(timer);
  }, [busy, authenticated, route, home, seasons, episodes, error, showChildren, children]);

  const navigate = (next: Route) => {
    history.current.push({ route, focus: focus.current, scroll: viewport.current?.scrollTop ?? 0 });
    setRoute(next);
  };
  const back = useCallback(() => {
    if (showChildren) { setShowChildren(false); return true; }
    const last = history.current.pop();
    if (last) { restore.current = last; setRoute(last.route); return true; }
    return false;
  }, [showChildren]);
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
      setTimeout(() => setFocus(focus.current), 80);
      if (viewport.current && restore.current) viewport.current.scrollTop = restore.current.scroll;
      restore.current = undefined;
    };
    window.addEventListener('molly:playbackClosed', returned);
    return () => window.removeEventListener('molly:playbackClosed', returned);
  }, [route.kind]);

  const login = async () => {
    if (!username.trim() || !password) { setError('请输入账号和密码'); return; }
    setBusy(true); setError('');
    try { await call('login', { username: username.trim(), password }); setPassword(''); setAuthenticated(true); }
    catch (e) { fail(e); }
    finally { setBusy(false); }
  };
  const play = async (id: string) => {
    if (playing) return;
    setPlaying(true); setError('');
    restore.current = { focus: focus.current, scroll: viewport.current?.scrollTop ?? 0 };
    try { await call('playEpisode', { episodeId: id }); }
    catch (e) { setPlaying(false); fail(e); }
  };
  const selectedChild = children.find((c) => c.id === child);

  if (!authenticated) return <div className="login-screen">
    <section className="login-intro"><div className="wordmark">molly<span>TV</span></div>
      <h1>今天，<br />一起看点什么？</h1><p>属于我们家的小小放映室。</p></section>
    <form className="login-form" onSubmit={(event) => { event.preventDefault(); void login(); }}>
      <h2>进入家庭媒体库</h2><p>使用家长创建的账号登录。</p>
      <label>账号<FocusInput focusKey="username" value={username} onChange={setUsername} /></label>
      <label>密码<FocusInput focusKey="password" value={password} onChange={setPassword} password /></label>
      {error && <p role="alert" className="error">{error}</p>}
      <FocusButton focusKey="login" className="primary" disabled={busy || !capabilities} onClick={() => { void login(); }}>
        {busy ? '正在连接…' : '进入媒体库'}</FocusButton>
      {portAvailable() && <FocusButton focusKey="connection-login" className="text-button" onClick={() => { void call('connection'); }}>连接设置</FocusButton>}
    </form>
  </div>;

  return <div className="app">
    <header><div className="wordmark">molly<span>TV</span></div>
      <nav><FocusButton focusKey="back" className="text-button" onClick={() => { if (!back()) { history.current = []; setRoute({ kind: 'home' }); } }}>
        {route.kind === 'home' ? '我的媒体库' : '返回'}</FocusButton>
        {children.length > 0 && <FocusButton focusKey="children" className="text-button" onClick={() => setShowChildren(true)}>{selectedChild?.name ?? '选择儿童'}</FocusButton>}
        {portAvailable() && <FocusButton focusKey="connection" className="text-button" onClick={() => { void call('connection'); }}>连接设置</FocusButton>}
        <FocusButton focusKey="logout" className="text-button" onClick={() => {
          setBusy(true); void call('logout').catch(fail).finally(() => {
            setAuthenticated(false); setChild(''); setChildren([]); setBusy(false); history.current = []; setRoute({ kind: 'home' });
          });
        }}>退出账号</FocusButton></nav>
    </header>
    <main ref={viewport}>
      {showChildren ? <section><h1>谁在看？</h1><div className="children-list">{children.map((c) =>
        <FocusButton key={c.id} focusKey={`child-${c.id}`} className="child" onClick={() => {
          setBusy(true); void request(`/api/children/${c.id}/select`, 'POST').then(() => {
            setChild(c.id); setShowChildren(false); setReload((value) => value + 1);
          }).catch(fail).finally(() => setBusy(false));
        }}><span className="avatar">{c.name.slice(0, 1)}</span><strong>{c.name}</strong></FocusButton>)}</div>
        <FocusButton focusKey="close-children" className="text-button" onClick={() => setShowChildren(false)}>返回媒体库</FocusButton></section> : <>
        <section className="page-heading"><p className="context">{route.kind === 'home' ? '家庭放映室' : route.series.name}</p>
          <h1>{route.kind === 'home' ? '好奇心，从这里开始。' : route.kind === 'series' ? '选一季，开始看。' : route.season.name}</h1>
          <p>{route.kind === 'home' ? preview?.name ?? '挑一部喜欢的动画。' : route.kind === 'series' ? route.series.overview || '每一次发现，都有新的故事。' : '选择一集，接着上次的位置继续。'}</p>
        </section>
        {busy ? <div role="status" className="state">正在打开媒体库…</div> : !error && (
          route.kind === 'home' ? home.rows.map((row, index) => <section key={index} className="shelf"><h2>{row.title}</h2>
            <div className="poster-grid">{row.items.map((item) => <FocusButton key={item.id} focusKey={index === 0 ? `series-${item.id}` : `home-${index}-${item.id}`}
              className="poster" disabled={playing} onClick={() => item.type === 'episode' ? void play(item.id) : navigate({ kind: 'series', series: item })}
              onFocus={() => { focus.current = index === 0 ? `series-${item.id}` : `home-${index}-${item.id}`; setPreview(item); }}>
              <Cover item={item} /><strong>{item.name}</strong><span>{item.type === 'episode' ? '接着看' : `${item.episodeCount ?? 0} 集`}</span>
            </FocusButton>)}</div>{row.items.length === 0 && <p className="state">还没有内容，请家长先导入视频。</p>}</section>) :
          route.kind === 'series' ? <section className="season-list">{seasons.map((season) => <FocusButton key={season.id}
            focusKey={`season-${season.id}`} className="season" onFocus={() => { focus.current = `season-${season.id}`; }}
            onClick={() => navigate({ kind: 'season', series: route.series, season })}>
            <strong>{season.name}</strong><span>{season.episodeCount ?? 0} 集</span><span className="arrow">›</span>
          </FocusButton>)}{seasons.length === 0 && <p className="state">这一系列还没有可看的剧集。</p>}</section> :
          <section className="poster-grid episodes">{episodes.map((episode) => <FocusButton key={episode.id}
            focusKey={`episode-${episode.id}`} className="poster" disabled={playing}
            onFocus={() => { focus.current = `episode-${episode.id}`; }} onClick={() => { void play(episode.id); }}>
            <Cover item={episode} /><strong>{episode.name}</strong><span>{episode.runtimeMs ? `${Math.ceil(episode.runtimeMs / 60000)} 分钟` : '播放'}</span>
          </FocusButton>)}{episodes.length === 0 && <p className="state">这一季还没有可看的剧集。</p>}</section>
        )}
        {route.kind === 'home' && !busy && !error && home.rows.length === 0 && <p className="state">媒体库还没有内容，请家长先导入视频。</p>}
      </>}
      {playing && <p role="status" className="state">正在打开播放器…</p>}
      {error && <div className="state"><p role="alert" className="error">{error}</p><FocusButton focusKey="retry" className="primary" onClick={() => { setError(''); setReload((value) => value + 1); }}>重试</FocusButton></div>}
    </main>
    <footer><span>↑ ↓ ← → 选择</span><span>确定 打开</span><span>返回 上一页</span></footer>
  </div>;
}
function portAvailable() { return !!window.MollyBridge; }
createRoot(document.getElementById('root')!).render(<App />);
