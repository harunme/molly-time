import { WatchControls } from "./watch-control";
import { useMobileLayout } from "./mobile/layout";
import { useDocumentScroll } from "./scroll-restoration";
import { startLifecycle, useRevalidation } from "./lifecycle";
import { InstallApp, OfflineStart, PwaStatus, useOnline } from "./pwa";
import { FileUploadStatus, useItemUploads } from "./upload-status";
import { CoverArtwork } from "./cover-artwork";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Empty } from "@/components/ui/empty";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loading, type LoadingVariant } from "@/components/ui/loading";
import { FileUpload, FileUploadField } from "@/components/ui/upload";
import { Toaster } from "@/components/ui/sonner";
import { FeedbackDialogs, confirmAction, promptText } from "./feedback";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select";
import { Operations } from "./operations";
import { FamilyUsage } from "./usage";
import { Trash, TrashRetentionSettings } from "./trash";
import { publicationLabel, showPublicationStatus, useLibraryPublication } from "./library-publication";
import { ResourceDesktop } from "./resource-desktop";
import { LibraryDataProvider, useLibraryData } from "./library-data";
import { useContinuousData, ContinuousListStatus } from "./continuous-list";
import { LibraryAddTile } from "./library-add-tile";
import { queueVideoFiles, type VideoUploadBatch } from "./video-upload";
import { MediaPreview, SubtitleSettings } from "./media";
import { ShareDialog, ShareReceive } from "./shares";
import { PairingProvider } from "./pairing";
import { Televisions } from "./televisions";
import { BindEmail, InviteActivation } from "./accounts";
import { Overview } from "./overview";
import { BrandMark, BrandWordmark } from "./brand";
import { useReminderData } from "./reminders";
import { DeviceNotifications } from "./device-notifications";
import { DeviceErrorLogs } from "./device-error-logs";
import { Pagination, usePagedData } from "./pagination";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import {
  api,
  bytes,
  dateTime,
  minutes,
  setSession,
  type Resource,
  type Session,
  type Upload,
} from "./api";
import { enqueue, hasFile, live, pause, resume, stopUploads, restoreUploads, forgetUpload } from "./uploads";
import { getUploadLimits, useUploadLimits, validateUploadSize } from "./upload-limits";
import {
  FolderOpen,
  UploadCloud,
  ListTodo,
  LayoutDashboard,
  Users,
  Monitor,
  Settings2,
  Film,
  ChevronRight,
  ExternalLink,
  LogOut,
  CircleCheck,
  Search,
  MoreHorizontal,
  FileVideo,
  Captions,
  Pencil,
  Archive,
  Trash2,
  Eye,
  ShieldCheck,
  UserRound,
  KeyRound,
  LoaderCircle,
  ScrollText,
  Smartphone,
} from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge as UiBadge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import "./style.css";
import "./styles/mobile.css";

const MobileApp = React.lazy(() => import("./mobile/app").then(module => ({ default: module.MobileApp })));

export type Run = (action: () => Promise<void>) => Promise<void>;
function useData<T>(path: string, initial: T, serial = 0) {
  const revision = useRevalidation();
  const [data, setData] = useState(initial),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!path) { setLoading(false); return; }
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<T>(path, "GET", undefined, undefined, controller.signal)
      .then((value) => {
        if (alive) setData(value);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [path, serial, revision]);
  return { data, error, loading };
}
function Icon({ name }: { name: string; }) {
  const icons: Record<string, typeof FolderOpen> = {
    library: FolderOpen,
    trash: Trash2,
    overview: LayoutDashboard,
    family: Users,
    devices: Monitor,
    operations: Settings2,
    logs: ScrollText,
  };
  const Component = icons[name] || Film;
  return (
    <Component className="size-[18px]" strokeWidth={1.7} aria-hidden="true" />
  );
}
function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
}) {
  const [error, setError] = useState("");
  useEffect(() => {
    const failed = (e: Event) => setError((e as CustomEvent<string>).detail);
    window.addEventListener("mollytime:error", failed);
    return () => window.removeEventListener("mollytime:error", failed);
  }, []);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="manage-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {error && (
          <Alert variant="destructive" className="error" role="alert"><AlertDescription>
            {error}
          </AlertDescription></Alert>
        )}
        {children}
      </DialogContent>
    </Dialog>
  );
}

function State({ loading, error, variant = "list" }: { loading?: boolean; error?: string; variant?: LoadingVariant; }) {
  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  return loading ? <Loading variant={variant} size="sm" /> : null;
}
function Badge({ value }: { value: string; }) {
  const names: Record<string, string> = {
    draft: "草稿",
    published: "已发布",
    archived: "已归档",
    uploading: "上传中",
    processing: "检查中",
    ready: "文件就绪",
    failed: "检查失败",
    cancelled: "已取消",
  };
  return (
    <UiBadge variant="secondary" className={`badge ${value}`}>
      {names[value] || value}
    </UiBadge>
  );
}

function App() {
  const mobileLayout = useMobileLayout();
  const revision = useRevalidation();
  const online = useOnline();
  const [sessionError, setSessionError] = useState(false);
  const navigation = useRef<HTMLElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const inviteToken = new URLSearchParams(location.search).get("token");
  const pairCode = new URLSearchParams(location.search).get("code") || "";
  const page = location.pathname.split("/")[1];
  const [session, updateSession] = useState<Session>(),
    [checking, setChecking] = useState(true);
  const reminders = useReminderData(true, !!session?.user.email);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    setError("");
    setNotice("");
  }, [location.pathname, location.search]);
  useDocumentScroll(location.pathname, session?.user.id);
  useEffect(() => {
    let alive = true;
    api<Session>("/auth/session")
      .then((value) => {
        if (!alive) return;
        setSessionError(false);
        setSession(value);
        updateSession(value);
      })
      .catch((failure) => { if (alive) setSessionError(failure.status !== 401); })
      .finally(() => { if (alive) setChecking(false); });
    const expired = () => {
      stopUploads();
      updateSession(undefined);
      setSession(undefined);
    };
    window.addEventListener("mollytime:unauthorized", expired);
    return () => { alive = false; window.removeEventListener("mollytime:unauthorized", expired); };
  }, [revision]);
  useEffect(() => {
    if (session) void restoreUploads(`${session.family.id}:${session.user.id}`);
  }, [session?.family.id, session?.user.id]);
  useEffect(() => {
    const nav = navigation.current;
    if (!nav) return;
    const reveal = () => {
      const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!active || nav.scrollWidth <= nav.clientWidth) return;
      const container = nav.getBoundingClientRect();
      const item = active.getBoundingClientRect();
      if (item.left < container.left) nav.scrollLeft += item.left - container.left;
      else if (item.right > container.right) nav.scrollLeft += item.right - container.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [page, session]);
  const run: Run = async (action) => {
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      const message = e instanceof Error ? e.message : "操作失败";
      setError(message);
      window.dispatchEvent(
        new CustomEvent("mollytime:error", { detail: message }),
      );
    }
  };
  if ((!online || sessionError) && !session) return <OfflineStart retry={() => window.dispatchEvent(new Event("mollytime:revalidate"))} />;
  if (checking) return <Loading variant="page" label="正在打开家庭媒体库…" />;
  if (/^\/share\/[^/]+$/.test(location.pathname))
    return <ShareReceive session={session} onSession={(value) => { setSession(value); updateSession(value); }} readonly={!!session && !["admin", "superadmin"].includes(session.user.role)} standalone />;
  if (location.pathname === "/invite")
    return <InviteActivation key={inviteToken || ""} token={inviteToken || ""} login={(email) => {
      void run(async () => {
        if (session) await api("/auth/logout", "POST");
        stopUploads(); setSession(undefined); updateSession(undefined);
        navigate("/login", { replace: true, state: { account: email } });
      });
    }} />;
  const returnTo = typeof location.state?.from === "string" &&
    location.state.from.startsWith("/") && !location.state.from.startsWith("//") &&
    location.state.from.split(/[?#]/)[0] !== "/login"
    ? location.state.from : "/overview";
  if (!session && location.pathname !== "/login")
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search + location.hash }} />;
  if (!session)
    return (
      <Login
        initialAccount={location.state?.account || ""}
        invite={() => navigate("/invite")}
        done={(value) => {
          setSession(value);
          updateSession(value);
          setError("");
          navigate(returnTo, { replace: true });
        }}
      />
    );
  if (location.pathname === "/login")
    return <Navigate to={returnTo} replace />;
  if (!session.user.email)
    return <BindEmail session={session} bound={(user) => {
      const value = { ...session, user }; setSession(value); updateSession(value);
    }} logout={() => {
      void run(async () => {
        await api("/auth/logout", "POST"); stopUploads(); setSession(undefined); updateSession(undefined);
      });
    }} />;
  const names = [
    ["overview", "概览"],
    ["devices", "我的电视"],
    ["library", "资源库"],
    ["trash", "回收站"],
    ["family", "家庭设置"],
  ];
  if (session.user.role === "superadmin")
    names.push(["operations", "运营设置"], ["logs", "系统日志"]);
  const readonly = !["admin", "superadmin"].includes(session.user.role);
  if (mobileLayout) return <PairingProvider key={session.family.id} session={session} devices={reminders.devices} devicesError={reminders.error}>
    {error && <div className="m-global-error" role="alert">{error}</div>}
    <React.Suspense fallback={<Loading variant="page" label="正在打开家庭应用…" />}><MobileApp session={session} readonly={readonly} reminders={reminders} run={run}
      logout={() => { void run(async () => { await api('/auth/logout', 'POST'); stopUploads(); setSession(undefined); updateSession(undefined); }); }}
      family={<Family embedded run={run} readonly={readonly} notify={setNotice} session={session} familyRenamed={name => updateSession(current => current && ({ ...current, family: { ...current.family, name } }))} />}
      televisions={<Televisions run={run} readonly={readonly} notify={setNotice} />}
      deviceControls={deviceId => <WatchControls key={deviceId} editDeviceId={deviceId} onEditorClose={() => { navigate('/devices', { replace: true }); void reminders.reload(); }} readonly={readonly} devices={(reminders.devices ?? []).filter(device => device.id === deviceId)} total={1} serial={0} pairing={null} listState={null} empty={false} footer={null}
        rename={async device => { const name = await promptText('设备名称', device.name); if (name && name !== device.name) { await api(`/devices/${device.id}`, 'PATCH', { name }); await reminders.reload(); } }}
        revoke={async device => { if (await confirmAction(`取消“${device.name}”的配对？电视将无法继续访问家庭媒体库。`)) { await api(`/devices/${device.id}/revoke`, 'POST'); await reminders.reload(); } }} />}

      trash={<Trash readonly={readonly} />} operations={<Operations notify={setNotice} />} logs={<DeviceErrorLogs />} uploads={<Uploads run={run} readonly={readonly} />}
      editor={(kind, item, close) => kind === 'preview' ? <Preview item={item} close={close} /> : kind === 'upload' ? <UploadDialog item={item} initialKind="video" close={close} /> : kind === 'share' ? <ShareDialog resource={item} close={close} /> : <Modal title={`字幕设置 · ${item.name}`} close={close}><SubtitleSettings item={item} readonly={readonly} /></Modal>}
    /></React.Suspense>
    {notice && <button className="m-notice" role="status" onClick={() => setNotice('')}>{notice}</button>}
  </PairingProvider>;
  const primaryPages = new Set(["overview", "devices", "library", "family"]);
  const secondaryActive = !primaryPages.has(page);
  return (
    <PairingProvider key={session.family.id} session={session} devices={reminders.devices} devicesError={reminders.error}>
    <div className="workspace">
      <aside className="manage-sidebar">
        <Link className="wordmark" to="/overview">
          <BrandMark transparent />
          <span className="brand-copy">
            <BrandWordmark onDark />
          </span>
        </Link>
        <nav ref={navigation} className={names.length > 5 ? "has-operations" : undefined} aria-label="管理导航">
          {[{ label: "媒体管理", items: names.slice(0, 4) }, { label: "家庭与设置", items: names.slice(4) }].map((group) => (
            <div className="sidebar-nav-group" key={group.label}>
              <span className="sidebar-nav-label">{group.label}</span>
              {group.items.map(([id, name]) => (
                <Button
                  variant="ghost"
                  asChild
                  key={id}
                  className={`nav-link${page === id ? " active" : ""}${primaryPages.has(id) ? "" : " nav-secondary"}`}
                >
                  <NavLink to={`/${id}`} onClick={event => {
                    if (location.pathname === `/${id}`) {
                      event.preventDefault();
                      window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
                    }
                  }}>
                    <Icon name={id} />
                    {name}
                    {page === id && <ChevronRight className="ml-auto size-3.5" />}
                  </NavLink>
                </Button>
              ))}
            </div>
          ))}
        </nav>
        <div className="brandbar-identity">
          <div className="desktop-app-tools"><InstallApp /><DeviceNotifications key={session.family.id} familyId={session.family.id} devices={reminders.devices} /></div>
          <a className="brandbar-tv-link" href="/tv/" target="_blank" rel="noreferrer" aria-label="打开 TV 网页">
            <ExternalLink className="size-3.5" />
            <span>打开 TV 网页</span>
          </a>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className={`sidebar-account-button${secondaryActive ? " is-secondary-active" : ""}`} aria-label="账号菜单">
                <Avatar className="size-7"><AvatarFallback className="bg-accent text-foreground">{session.user.name[0].toUpperCase()}</AvatarFallback></Avatar>
                <strong>{session.user.name}</strong>
                <ChevronRight className="ml-auto size-3.5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>
                {session.user.name} · {session.user.role === "superadmin" ? "平台超管" : readonly ? "家长成员" : "家庭管理员"}
              </DropdownMenuLabel>
              <DropdownMenuLabel>{session.user.email}</DropdownMenuLabel>
              <DropdownMenuLabel>账号 ID：{session.user.accountId}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <div className="mobile-account-links">
                {names.filter(([id]) => !primaryPages.has(id)).map(([id, label]) => <DropdownMenuItem asChild key={id}><Link to={`/${id}`}><Icon name={id} />{label}</Link></DropdownMenuItem>)}
                <DropdownMenuItem onSelect={() => navigate('/family?app=1')}><Smartphone />应用与通知</DropdownMenuItem>
                <DropdownMenuSeparator />
              </div>
              <DropdownMenuItem variant="destructive" className="rounded-full" onSelect={() => {
                void run(async () => {
                  await api("/auth/logout", "POST");
                  stopUploads();
                  setSession(undefined);
                  updateSession(undefined);
                });
              }}>
                <LogOut />退出账号
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
      <main className="manage-main">
        <div className="page-content">
          {error && (
            <Alert className="mb-5" variant="destructive">
              <AlertDescription>{error}</AlertDescription>
              <Button
                variant="ghost"
                size="icon"
                aria-label="关闭错误"
                onClick={() => setError("")}
              >
                ×
              </Button>
            </Alert>
          )}
          {notice && (
            <Alert className="mb-5" role="status">
              <CircleCheck className="size-4 shrink-0" />
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}
          {readonly && (
            <Alert className="mb-5"><AlertDescription>当前账号可查看资料和观看记录，编辑需要管理员账号。</AlertDescription></Alert>
          )}
          <Routes>
            <Route index element={<Navigate to="/overview" replace />} />
            <Route path="overview" element={<Overview navigate={(destination) => navigate(destination === "upload" ? "/library?uploads=1" : `/${destination}`)} run={run} readonly={readonly} notify={setNotice} reminders={reminders} />} />
            <Route path="devices" element={<Televisions run={run} readonly={readonly} notify={setNotice} />} />
            <Route path="devices/settings" element={<Televisions run={run} readonly={readonly} notify={setNotice} />} />
            <Route path="library" element={<LibraryDataProvider key={`${session.user.id}:${session.family.id}`} />}>
              <Route index element={<Library run={run} readonly={readonly} />} />
              <Route path=":folderId" element={<FolderLibrary run={run} readonly={readonly} />} />
            </Route>
            <Route path="share" element={<Navigate to="/library" replace />} />
            <Route path="trash" element={<Trash readonly={readonly} />} />
            <Route path="upload" element={<Navigate to="/library?uploads=1" replace />} />
            <Route path="watch" element={<Navigate to="/overview?watch=1" replace />} />
            <Route path="operations/*" element={session.user.role === "superadmin"
              ? <Operations notify={setNotice} />
              : <Navigate to="/overview" replace />} />
            <Route path="logs" element={session.user.role === "superadmin"
              ? <DeviceErrorLogs />
              : <Navigate to="/overview" replace />} />
            <Route path="family/*" element={<Family
              run={run}
              readonly={readonly}
              notify={setNotice}
              session={session}
              familyRenamed={(name) => updateSession((current) => current && {
                ...current, family: { ...current.family, name },
              })}
            />} />
            <Route path="pair" element={<Navigate to={`/devices?${new URLSearchParams({ pair: "1", code: pairCode })}`} replace />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
          <footer className="manage-footer">
            <span>为下一次一起观看做准备</span>
          </footer>
        </div>
      </main>
    </div>
    </PairingProvider>
  );
}

function Login({ done, initialAccount, invite }: { done: (session: Session) => void; initialAccount: string; invite: () => void; }) {
  const [username, setUsername] = useState(initialAccount),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <main className="login">
      <section className="login-story">
        <header className="login-brand">
          <div className="wordmark"><BrandMark transparent /><BrandWordmark onDark /></div>
          <span className="login-brand-divider" aria-hidden="true" />
          <p>家庭放映室</p>
        </header>
        <div className="login-story-content">
          <div className="login-story-accent" aria-hidden="true" />
          <p className="login-eyebrow">属于我们家的内容</p>
          <h2>
            挑好故事，
            <br />
            <span>留给好奇的眼睛。</span>
          </h2>
          <p className="login-story-description">
            整理家庭资源，绑定电视，了解孩子的播放时间。
          </p>
        </div>
        <footer className="login-story-footer">
          <span>MollyTime · 家庭放映室</span>
          <span>为下一次一起观看做准备</span>
        </footer>
      </section>
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-panel-content">
          <header className="login-heading">
            <p className="login-product">MollyTime 管理后台</p>
            <h1 id="login-title">进入管理后台</h1>
            <p className="login-description">登录后管理片单、字幕和电视设备。</p>
          </header>
          <form
            aria-busy={busy}
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              void api<Session>("/auth/login", "POST", {
                username,
                password,
              })
                .then(done)
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <Label>
              账号
              <InputGroup>
                <InputGroupAddon><UserRound aria-hidden="true" /></InputGroupAddon>
                <InputGroupInput
                  autoComplete="username"
                  placeholder="邮箱或数字 ID"
                  maxLength={254}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </InputGroup>
            </Label>
            <Label>
              密码
              <InputGroup>
                <InputGroupAddon><KeyRound aria-hidden="true" /></InputGroupAddon>
                <InputGroupInput
                  type="password"
                  autoComplete="current-password"
                  placeholder="请输入密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </InputGroup>
            </Label>
            {error && (
              <Alert variant="destructive" role="alert" className="error"><AlertDescription>
                {error}
              </AlertDescription></Alert>
            )}
            <Button
              type="submit"
              variant="default"
              className="primary"
              disabled={busy}
            >
              {busy && <LoaderCircle className="animate-spin" aria-hidden="true" />}
              {busy ? "正在登录…" : "登录"}
            </Button>
          </form>
          <Button variant="ghost" className="login-invite-action" onClick={invite}>使用邀请码</Button>
          <div className="login-help">
            <ShieldCheck aria-hidden="true" />
            <p>使用邮箱或数字 ID 登录。新用户需邀请码；已有旧账号可继续登录并绑定邮箱。</p>
          </div>
        </div>
      </section>
    </main>
  );
}

function FolderLibrary({ run, readonly }: { run: Run; readonly: boolean; }) {
  const { folderId = "" } = useParams();
  const libraryData = useLibraryData();
  const [serial, refresh] = useState(0);
  const folder = useData<Resource | undefined>(`/resources/${encodeURIComponent(folderId)}`, undefined, serial);
  const cached = [...(libraryData?.pages.values() ?? [])].flatMap(page => page.items).find(item => item.id === folderId);
  const current = folder.data?.id === folderId ? folder.data : cached;
  if (folder.error) return <><State error={folder.error} /><Button asChild variant="bordered"><Link to="/library">全部文件夹</Link></Button></>;
  if (!current) return <Loading variant="cards" label="正在打开文件夹…" />;
  if (current.status === "archived") return <Navigate to="/trash" replace />;
  if (current.type !== "Series" && current.type !== "Season") return <Navigate to="/library" replace />;
  return <Library key={folderId} run={run} readonly={readonly} parent={current} parentChanged={() => refresh(value => value + 1)} />;
}

function Library({ run, readonly, parent, parentChanged }: { run: Run; readonly: boolean; parent?: Resource; parentChanged?: () => void; }) {
  const libraryData = useLibraryData();
  const navigate = useNavigate();
  const location = useLocation();
  const tasksOpen = new URLSearchParams(location.search).get("uploads") === "1";
  const [serial, refresh] = useState(0);
  const [upload, setUpload] = useState<Resource>(),
    [preview, setPreview] = useState<Resource>();
  const [subtitleSettings, setSubtitleSettings] = useState<Resource>();
  const [share, setShare] = useState<Resource>();
  const [uploadKind, setUploadKind] = useState("video");
  const videoInput = useRef<HTMLInputElement>(null);
  const quickBatch = useRef<VideoUploadBatch>({ folderId: parent?.id, rows: [] });
  const quickLock = useRef(false);
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickError, setQuickError] = useState('');
  const [createdFolder, setCreatedFolder] = useState<Resource>();
  const [folderCreating, setFolderCreating] = useState(false);
  const [folderError, setFolderError] = useState('');
  const [renaming, setRenaming] = useState<{ item: Resource; name: string; error: string; saving: boolean }>();
  const folderNameInput = useRef<HTMLInputElement>(null);
  const folderCreateLock = useRef(false);
  const folderRenameLock = useRef(false);
  const renameFromMenu = useRef(false);
  const coverInput = useRef<HTMLInputElement>(null);
  const previewInput = useRef<HTMLInputElement>(null);
  const coverTarget = useRef<Resource | undefined>(undefined);
  const coverLock = useRef(false);
  const [coverUploading, setCoverUploading] = useState<{ id: string; kind: 'image' | 'preview' }>();
  const [coverError, setCoverError] = useState<{ id: string; message: string }>();
  useEffect(() => {
    if (renaming && !renaming.saving) {
      folderNameInput.current?.focus();
      folderNameInput.current?.select();
    }
  }, [renaming?.item.id, renaming?.saving]);

  const previousTasksOpen = useRef(tasksOpen);
  useEffect(() => {
    if (previousTasksOpen.current && !tasksOpen) refresh((value) => value + 1);
    previousTasksOpen.current = tasksOpen;
  }, [tasksOpen]);
  const setTasksOpen = (open: boolean) => {
    const params = new URLSearchParams(location.search);
    params.delete("uploads");
    const background = location.pathname + (params.size ? `?${params}` : "");
    if (open) {
      params.set("uploads", "1");
      navigate(`${location.pathname}?${params}`, { state: { uploadsReturnTo: background } });
    } else if (location.state?.uploadsReturnTo === background) {
      navigate(-1);
    } else {
      navigate(background, { replace: true });
    }
  };
  const list = useContinuousData<Resource>(
    `/resources?${parent ? `parentId=${encodeURIComponent(parent.id)}&` : ""}sort=manual`,
    serial, true, libraryData,
  );
  const backgroundList = useContinuousData<Resource>(
    `/resources?${parent?.parentId ? `parentId=${encodeURIComponent(parent.parentId)}&` : ""}sort=manual`,
    serial, !!parent, libraryData,
  );
  const parentName = parent?.ancestors?.[parent.ancestors.length - 1]?.name || "全部文件夹";
  const closeFolder = () => navigate(parent?.parentId ? `/library/${encodeURIComponent(parent.parentId)}` : "/library");
  const pendingUploads = usePendingUploads(serial, 1);
  const fileUploads = useItemUploads(list.data.filter(item => item.type === "Episode").map(item => item.id), () => refresh(value => value + 1));
  useEffect(() => {
    let ids = [...live.keys()].sort().join(',');
    const update = () => {
      const next = [...live.keys()].sort().join(',');
      if (next !== ids) { ids = next; refresh(value => value + 1); }
    };
    window.addEventListener('mollytime:uploads', update);
    return () => window.removeEventListener('mollytime:uploads', update);
  }, []);
  const filtered = createdFolder ? [createdFolder, ...list.data.filter(item => item.id !== createdFolder.id)] : list.data;
  useEffect(() => {
    if (createdFolder && !renaming && list.data.some(item => item.id === createdFolder.id && item.name === createdFolder.name)) {
      setCreatedFolder(undefined);
    }
  }, [list.data, createdFolder, renaming]);
  const changed = () => {
    refresh((v) => v + 1);
  };
  const publication = useLibraryPublication({
    items: filtered, parent, scope: parent?.id || "root", readonly,
    refreshing: list.refreshing || !!list.error, changed: () => { changed(); parentChanged?.(); },
  });
  const openItem = (item: Resource) => {
    if (publication.selecting && item.type === "Episode") { publication.toggle(item.id); return; }
    if (item.type === "Episode") setPreview(item);
    else navigate(`/library/${encodeURIComponent(item.id)}`);
  };
  const saveFolderName = async () => {
    if (!renaming || folderRenameLock.current) return;
    const name = renaming.name.trim();
    if (!name) {
      setRenaming({ ...renaming, error: "名称不能为空" });
      folderNameInput.current?.focus();
      return;
    }
    if (name === renaming.item.name) { setRenaming(undefined); return; }
    folderRenameLock.current = true;
    setRenaming({ ...renaming, saving: true, error: "" });
    try {
      const item = await api<Resource>(`/resources/${renaming.item.id}`, "PATCH", {
        name,
      });
      setCreatedFolder(item);
      setRenaming(undefined);
      changed();
    } catch (error) {
      setRenaming({ ...renaming, saving: false, error: (error as Error).message });
    } finally { folderRenameLock.current = false; }
  };
  const createFolder = async () => {
    if (readonly || folderCreateLock.current || renaming) { folderNameInput.current?.focus(); return; }
    folderCreateLock.current = true;
    setFolderCreating(true); setFolderError("");
    try {
      const item = await api<Resource>("/resources", "POST", {
        name: "新建文件夹", type: "Series", parentId: parent?.id || null, autoName: true,
      });
      setCreatedFolder(item);
      setRenaming({ item, name: item.name, error: "", saving: false });
      changed();
    } catch (error) { setFolderError((error as Error).message); }
    finally { folderCreateLock.current = false; setFolderCreating(false); }
  };
  const uploadCover = async (item: Resource, file: File, kind: 'image' | 'preview' = 'image') => {
    if (readonly || coverLock.current) return;
    coverLock.current = true; setCoverUploading({ id: item.id, kind }); setCoverError(undefined);
    try {
      await enqueue(file, item.id, kind);
      changed();
    } catch (error) {
      setCoverError({ id: item.id, message: (error as Error).message });
    } finally { coverLock.current = false; setCoverUploading(undefined); }
  };
  const action = (id: string, mode: string) => {
    void run(async () => { await api(`/resources/${id}/${mode}`, "POST"); changed(); });
  };
  const uploadVideos = async (files: File[] = []) => {
    if (readonly || quickLock.current) return;
    quickLock.current = true; setQuickBusy(true); setQuickError('');
    try {
      await queueVideoFiles(quickBatch.current, files, () => {
        changed();
      });
      if (!parent && quickBatch.current.folderId) navigate(`/library/${encodeURIComponent(quickBatch.current.folderId)}`);
    } catch (error) {
      const filename = quickBatch.current.rows[0]?.file.name;
      setQuickError(`${filename ? filename + '：' : ''}${(error as Error).message || '未能建立上传任务，请重试。'}`);
    } finally {
      if (!quickBatch.current.rows.length) quickBatch.current.folderId = parent?.id;
      quickLock.current = false; setQuickBusy(false);
    }
  };
  const quickFeedback = quickError && <Alert variant="destructive" role="alert" className="mb-4">
    <AlertDescription>{quickError}{quickBatch.current.rows.length > 0 &&
      <Button variant="ghost" size="sm" disabled={quickBusy} onClick={() => void uploadVideos()}>重试上传</Button>}
    </AlertDescription>
  </Alert>;
  const videoPicker = <input ref={videoInput} type="file" accept=".mp4,video/mp4" multiple hidden aria-label="选择上传视频"
    disabled={readonly || quickBusy} onChange={event => {
      const files = Array.from(event.currentTarget.files || []);
      event.currentTarget.value = '';
      if (files.length) void uploadVideos(files);
    }} />;
  const toolbar = <>{publication.toolbar}{!parent && pendingUploads.total > 0 && <div className="toolbar library-toolbar">
    <Button variant="bordered" aria-label="上传任务" onClick={() => setTasksOpen(true)}>
      <ListTodo className="size-4" />查看全部上传
    </Button>
  </div>}</>;
  return (
    <Dialog open={tasksOpen} onOpenChange={setTasksOpen}>
      <div className="page-title">
        <div>
          <h1>{parent?.ancestors?.[parent.ancestors.length - 1]?.name || "资源库"}</h1>
          <p>{parent?.type === "Season" ? "按集数整理本季视频，上架后按顺序观看。" : "整理文件夹，挑选视频，留给下一次观看。"}</p>
        </div>
      </div>
      <div className="resource-library-card">
            <ResourceDesktop items={filtered} enabled={!readonly && !list.refreshing && !list.error && !renaming && !publication.selecting && !publication.busy} canArrange
              input={videoPicker}
              exitSelection={publication.selecting ? publication.exit : undefined}
              leadingTile={!readonly && !publication.selecting ? <LibraryAddTile onCreate={() => void createFolder()} onUpload={() => videoInput.current?.click()} creating={folderCreating || !!renaming} uploading={quickBusy} /> : undefined}
              toolbar={toolbar} feedback={<>{publication.feedback}{quickFeedback}{fileUploads.error && <Alert variant="destructive" role="alert"><AlertDescription>上传状态暂时无法更新：{fileUploads.error}</AlertDescription></Alert>}{folderError && <Alert variant="destructive" role="alert"><AlertDescription>{folderError}</AlertDescription></Alert>}</>}
              suspended={!!(upload || preview || share || subtitleSettings || tasksOpen || publication.busy)}
              loading={list.loading} loadError={list.error}
              footer={<ContinuousListStatus {...list} />}
              empty={<Empty className="empty"><FolderOpen className="size-9" /><h3>还没有内容</h3><p>新建文件夹或上传视频。</p></Empty>}
              folder={parent ? {
                id: parent.id, name: parent.name, parentId: parent.parentId, parentName,
                scrollTop: libraryData?.positions.get(`scroll:${parent.id}`),
                rememberScroll: top => { libraryData?.positions.set(`scroll:${parent.id}`, top); },
                background: backgroundList.data, backgroundLoading: backgroundList.loading,
                backgroundLeadingTile: !readonly ? <LibraryAddTile /> : undefined,
                backgroundToolbar: !parent.parentId && <>
                  <div className="library-publication-controls"><div className="library-selection-toolbar"><span className="library-selection-hint">上架后可在电视观看。</span></div></div>
                  {pendingUploads.total > 0 && <div className="toolbar library-toolbar">
                  <Button variant="bordered"><ListTodo className="size-4" />查看全部上传</Button>
                </div>}</>,
                backgroundError: backgroundList.error,
                backgroundFooter: <ContinuousListStatus {...backgroundList} />,
                close: closeFolder,
                path: parent.ancestors || [],
                open: id => navigate(id ? `/library/${encodeURIComponent(id)}` : "/library"),
                dismiss: () => navigate("/library"),
              } : undefined}
              reorder={async (id, beforeId, afterId) => {
                await api(`/resources/${id}/position`, "PUT", { beforeId, afterId });
                refresh((value) => value + 1);
              }}
              move={async (id, folderId) => {
                await api(`/resources/${id}/move`, "POST", { folderId });
                changed();
              }}
              render={(item) => <>

                <div className="desktop-cover-wrap" data-selected={publication.selecting && publication.selected.includes(item.id)}>
                <button type="button" data-drag-surface className={`desktop-cover ${item.type !== "Episode" ? "desktop-folder" : "desktop-video"}`}
                  aria-label={publication.selecting && item.type === "Episode" ? `切换选择 ${item.name}` : `打开 ${item.name}`}
                  disabled={publication.busy}
                  onClick={() => openItem(item)}>
                  <span className="desktop-cover-art">
                    <CoverArtwork key={item.imageUrl} src={item.imageUrl} preview={item.imagePreviewUrl} />
                    {item.type !== "Episode" ? <FolderOpen className="desktop-fallback-icon" /> : <FileVideo className="desktop-fallback-icon" />}
                    {item.type !== "Episode" && <span className="desktop-folder-badge" aria-hidden="true"><FolderOpen /></span>}
                    {item.type !== "Series" && <span className="desktop-cover-caption">{item.type === "Season" ? (item.indexNumber ? `SEASON ${String(item.indexNumber).padStart(2, "0")}` : "分季") : (item.indexNumber ? `EP ${String(item.indexNumber).padStart(2, "0")}` : "视频")}</span>}
                    {item.type === "Episode" && !!item.runtimeMs && <span className="desktop-runtime">{minutes(item.runtimeMs)}</span>}
                    {coverUploading?.id === item.id && <span className="desktop-cover-status" role="status">{coverUploading.kind === 'preview' ? '正在上传动态预览…' : '正在上传封面…'}</span>}
                  </span>
                </button>
                {publication.selector(item)}
                <div className="desktop-card-menu">
                  {!readonly && !publication.selecting && (
                    <>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`更多操作 ${item.name}`}
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="desktop-resource-menu" onCloseAutoFocus={event => {
                          if (renameFromMenu.current) { event.preventDefault(); renameFromMenu.current = false; folderNameInput.current?.focus(); }
                        }}>
                          <DropdownMenuItem disabled={!!renaming} onSelect={() => {
                            renameFromMenu.current = true;
                            setRenaming({ item, name: item.name, error: "", saving: false });
                          }}>重命名</DropdownMenuItem>
                          <DropdownMenuItem disabled={!!coverUploading || !!renaming} onSelect={() => {
                            coverTarget.current = item;
                            coverInput.current?.click();
                          }}>上传封面</DropdownMenuItem>
                          <DropdownMenuItem disabled={!!coverUploading || !!renaming} title="悬停时播放动图，移开后显示封面" onSelect={() => {
                            coverTarget.current = item;
                            previewInput.current?.click();
                          }}>上传动态预览</DropdownMenuItem>
                          {item.hasOwnPreview && <DropdownMenuItem disabled={!!coverUploading || !!renaming} onSelect={() => {
                            void run(async () => { await api(`/resources/${item.id}/preview`, 'DELETE'); changed(); });
                          }}>移除动态预览</DropdownMenuItem>}
                          {parent && (parent.parentId || item.type === "Series") && <DropdownMenuItem onSelect={() => {
                            void run(async () => { await api(`/resources/${item.id}/move`, "POST", { folderId: parent.parentId }); changed(); });
                          }}>移到上一级</DropdownMenuItem>}
                          <DropdownMenuItem disabled={publication.busy || (item.status !== "published" && !item.ready)}
                            aria-label={item.type === "Episode" ? (item.status === "published" ? "下架" : "上架") : (item.status === "published" ? "下架目录" : "上架目录")}
                            onSelect={() => void publication.changeItem(item)}>
                            {item.type === "Episode" ? (item.status === "published" ? "下架" : "上架") : <span className="library-publication-menu-label">
                              <span>{item.status === "published" ? "下架目录" : "上架目录"}</span>
                              <small>{item.status === "published" ? "整个目录暂时不可观看，保留视频状态" : "恢复观看其中已上架的视频"}</small>
                            </span>}
                          </DropdownMenuItem>
                          {item.type !== "Episode" && <DropdownMenuItem disabled={publication.busy} onSelect={() => void publication.publishFolder(item)}>上架目录内全部视频</DropdownMenuItem>}
                          <DropdownMenuSeparator />
                          {item.status === "published" && !item.shared && item.type !== "Season" && <DropdownMenuItem onSelect={() => setShare(item)}>分享内容</DropdownMenuItem>}
                          {item.type === "Episode" && (
                            <>
                              <DropdownMenuItem onSelect={() => {
                                void run(async () => setSubtitleSettings(await api<Resource>(`/resources/${item.id}`)));
                              }}>字幕设置</DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => setPreview(item)}
                              >
                                预览视频
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => {
                                  setUploadKind("subtitle");
                                  setUpload(item);
                                }}
                              >
                                上传字幕
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => {
                                  setUploadKind("video");
                                  setUpload(item);
                                }}
                              >
                                替换视频
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                            </>
                          )}
                          <DropdownMenuItem
                            className="text-destructive"
                            onSelect={async () => {
                              if (
                                await confirmAction(
                                  `将“${item.name}”移入回收站？${item.type !== "Episode" ? "其中的所有内容也会移入回收站。" : ""}电视将无法开始播放此内容。保留期内可恢复，到期后按回收站策略彻底删除文件。`,
                                )
                              )
                                action(item.id, "archive");
                            }}
                          >
                            移入回收站
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )}
                </div>
                </div>
                <div className="resource-name">
                  {renaming?.item.id === item.id ? <div className="folder-inline-name">
                    <Input ref={folderNameInput} autoFocus data-folder-rename aria-label={item.type === "Episode" ? "视频名称" : "文件夹名称"} maxLength={256}
                      value={renaming.name} disabled={renaming.saving}
                      aria-invalid={!!renaming.error} aria-describedby={renaming.error ? "folder-name-error" : undefined}
                      onFocus={event => { event.currentTarget.select(); event.currentTarget.scrollIntoView({ block: "nearest" }); }}
                      onChange={event => setRenaming({ ...renaming, name: event.target.value, error: "" })}
                      onBlur={() => void saveFolderName()}
                      onKeyDown={event => {
                        event.stopPropagation();
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === "Enter") { event.preventDefault(); void saveFolderName(); }
                        if (event.key === "Escape") { event.preventDefault(); setRenaming(undefined); }
                      }} />
                    {renaming.error && <p id="folder-name-error" role="alert">{renaming.error}</p>}
                    {renaming.saving && <span role="status">正在保存…</span>}
                  </div> :
                  <Button
                    variant="bordered"
                    className="name-button"
                    onClick={() => openItem(item)}
                  >
                    {item.name}
                  </Button>}
                </div>
                {fileUploads.forItem(item.id).length ? fileUploads.forItem(item.id).map(row => <FileUploadStatus key={row.id} row={row} readonly={readonly} changed={fileUploads.refresh} />) : showPublicationStatus(item) && <p className="library-item-status" data-published={item.status === "published" && item.ready && !item.hiddenByFolder}
                  title={item.hiddenByFolder ? `上级目录“${item.hiddenByFolder.name}”已下架` : undefined}>
                  <span>{publicationLabel(item)}</span>
                </p>}
                {coverError?.id === item.id && <p className="desktop-cover-error" role="alert">{coverError.message}</p>}
              </>}
            />
      </div>
      <input ref={coverInput} type="file" hidden accept=".jpg,.jpeg,.png,.webp" aria-label="选择封面图片" onChange={event => {
        const file = event.currentTarget.files?.[0], item = coverTarget.current;
        event.currentTarget.value = "";
        if (file && item) void uploadCover(item, file);
      }} />
      <input ref={previewInput} type="file" hidden accept=".webp,.gif,.png" aria-label="选择动态预览" onChange={event => {
        const file = event.currentTarget.files?.[0], item = coverTarget.current;
        event.currentTarget.value = "";
        if (file && item) void uploadCover(item, file, 'preview');
      }} />
      {subtitleSettings && <Modal title={`字幕设置 · ${subtitleSettings.name}`} close={() => setSubtitleSettings(undefined)}>
        <SubtitleSettings item={subtitleSettings} readonly={readonly} />
      </Modal>}
      {upload && (
        <UploadDialog
          initialKind={uploadKind}
          item={upload}
          close={() => {
            setUpload(undefined);
            changed();
          }}
        />
      )}
      {share && <ShareDialog resource={share} close={() => setShare(undefined)} />}
      {preview && (
        <Preview item={preview} close={() => setPreview(undefined)} />
      )}
      <DialogContent className="upload-tasks-dialog" onCloseAutoFocus={event => {
        event.preventDefault();
        (document.querySelector<HTMLButtonElement>(parent ? '.folder-panel-body button[aria-label="添加内容"]' : 'button[aria-label="上传任务"]')
          ?? document.querySelector<HTMLButtonElement>('.resource-desktop button[aria-label="添加内容"]'))?.focus();
      }}>
        <DialogHeader>
          <DialogTitle>上传任务</DialogTitle>
          <DialogDescription>仅显示未完成的任务，可继续上传或重试处理。关闭弹窗不影响上传。</DialogDescription>
        </DialogHeader>
        <DialogBody>{quickFeedback}<Uploads run={run} readonly={readonly} /></DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function Preview({ item, close }: { item: Resource; close: () => void; }) {
  return (
    <Modal title={`家长预览 · ${item.name}`} close={close}>
      <MediaPreview id={item.id} />
      <p className="muted">预览不计入家庭观看时长，也不修改电视续播位置。</p>
    </Modal>
  );
}

function UploadDialog({ item, close, initialKind = "video" }: {
  initialKind?: string;
  item: Resource;
  close: () => void;
}) {
  const [kind, setKind] = useState(initialKind),
    [language, setLanguage] = useState("und");
  const [rows, setRows] = useState<
    { file: File; }[]
  >([]),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const uploadPolicy = useUploadLimits();
  const submit = () => {
    if (busy) return;
    setBusy(true);
    setError("");
    void (async () => {
      if (!rows.length) throw new Error("请先选择文件");
      const limits = await getUploadLimits();
      for (const row of rows) validateUploadSize(row.file, kind, limits);
      for (const row of rows) {
        await enqueue(row.file, item.id, kind, language);
        setRows((current) => current.filter((r) => r.file !== row.file));
      }
      close();
    })()
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <Modal title={`上传文件 · ${item.name}`} close={() => { if (!busy) close(); }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {item && (
          <Label>
            文件用途
            <SelectField
              value={kind}
              disabled={busy}
              onValueChange={(value) => {
                setKind(value);
                setRows([]);
              }}
              options={[{ value: "video", label: "视频（替换当前视频）" }, { value: "subtitle", label: "新增字幕" }]} />
          </Label>
        )}
        {kind === "subtitle" && (
          <Label>
            字幕类型
            <SelectField
              value={language}
              disabled={busy}
              onValueChange={(value) => setLanguage(value)}
              options={[({ value: "und", label: <> 未指定 </> }), ({ value: "zh", label: <> 中文 </> }), ({ value: "en", label: <> 英文 </> }), ({ value: "zh-en", label: <> 中英文 </> })]} />
            {language === "und" && <span className="muted">请选择字幕的实际类型；未指定类型的字幕不会自动匹配默认字幕语言。</span>}
          </Label>
        )}
        <FileUpload className="file-drop" inputLabel="选择上传文件"
          multiple={kind === "subtitle"}
          disabled={busy || !uploadPolicy.limits}
          accept={kind === "video" ? ".mp4" : ".srt,.vtt"}
          onFilesSelect={(files) => {
            try {
              if (!uploadPolicy.limits) return;
              for (const file of files) validateUploadSize(file, kind, uploadPolicy.limits);
              setError("");
              setRows(files.map((file) => ({ file })));
            } catch (failure) {
              setRows([]);
              setError((failure as Error).message);
            }
          }}>
          <UploadCloud className="size-8" />
          <strong>
            选择
            {kind === "video" ? "视频" : "字幕"}
            文件
          </strong>
          <span>
            {kind === "video"
              ? "MP4；可批量选择，播放兼容性取决于电视设备"
              : "UTF-8 编码的 SRT / VTT"}
          </span>
          <Button asChild variant="bordered">
            <span>
              {rows.length ? `已选择 ${rows.length} 个文件` : "选择本地文件"}
            </span>
          </Button>

        </FileUpload>
        {uploadPolicy.limits && <p className="muted">
          单个文件上限：{bytes(uploadPolicy.limits[kind as keyof typeof uploadPolicy.limits])}
        </p>}
        {!uploadPolicy.limits && !uploadPolicy.error && <Loading variant="inline" size="sm" label="正在加载上传限制…" />}
        {uploadPolicy.error && <Alert variant="destructive" role="alert"><AlertDescription>{uploadPolicy.error}</AlertDescription></Alert>}
        {rows.map((row, index) => (
          <div className="upload-plan" key={index}>
            <div>
              <strong>{row.file.name}</strong>
              <small>{bytes(row.file.size)}</small>
            </div>

          </div>
        ))}
        <p className="muted">
          上传后自动检查文件。新视频先保存为草稿，确认后再发布；替换已有视频会保留旧文件。
        </p>
        {error && (
          <Alert variant="destructive" className="error" role="alert"><AlertDescription>
            {error}
          </AlertDescription></Alert>
        )}
        <DialogFooter className="modal-actions">
          <Button
            variant="bordered"
            type="button"
            disabled={busy}
            onClick={close}
          >
            取消
          </Button>
          <Button
            variant="default"
            className="primary"
            disabled={busy || !rows.length || !uploadPolicy.limits}
          >
            {busy
              ? "正在建立上传任务…"
              : `开始上传${rows.length ? ` ${rows.length} 个文件` : ""}`}
          </Button>
        </DialogFooter>
      </form>
    </Modal>
  );
}

function usePendingUploads(serial: number, pageSize = 20) {
  const [updates, refresh] = useState(0);
  useEffect(() => {
    let ids = new Set(live.keys());
    const changed = () => {
      const next = new Set(live.keys());
      if (next.size !== ids.size || [...next].some((id) => !ids.has(id))) refresh((value) => value + 1);
      ids = next;
    };
    const timer = window.setInterval(() => refresh((value) => value + 1), 5000);
    window.addEventListener("mollytime:uploads", changed);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("mollytime:uploads", changed);
    };
  }, []);
  return usePagedData<Upload>("/uploads?pending=true", serial + updates, pageSize);
}

function Uploads({ run: execute, readonly }: { run: Run; readonly: boolean; }) {
  const [serial, refresh] = useState(0),
    [localSerial, localRefresh] = useState(0);
  const [actionError, setActionError] = useState("");
  const run: Run = async (action) => {
    setActionError("");
    await execute(action);
  };
  const list = usePendingUploads(serial);
  useEffect(() => {
    const changed = () => localRefresh((v) => v + 1);
    const failed = (event: Event) => setActionError((event as CustomEvent<string>).detail);
    window.addEventListener("mollytime:uploads", changed);
    window.addEventListener("mollytime:error", failed);
    return () => {
      window.removeEventListener("mollytime:uploads", changed);
      window.removeEventListener("mollytime:error", failed);
    };
  }, []);
  void localSerial;
  return (
    <>
      {actionError && <State error={actionError} />}
      {list.error && <State error={list.error} />}
      <State loading={list.loading} />
      {!list.loading && !list.data.length && (
        <Empty className="empty">
          <h3>没有正在上传的任务</h3>
          <p>未完成的任务会显示在这里，已完成的资源可在资源库中查看。</p>
        </Empty>
      )}
      {!!list.data.length && <Card className="upload-task-list">{list.data.map((row) => {
        const current = live.get(row.id),
          offset = Math.max(row.offset, current?.offset || 0);
        return (
          <div className="upload-task" data-status={row.status} key={row.id}>
            <div className="task-top">
              <div>
                <strong title={row.filename}>{row.filename}</strong>
                <small>
                  {bytes(offset)} / {bytes(row.size)}
                </small>
              </div>
              <Badge value={row.status} />
            </div>
            {row.status === "uploading" && <Progress
              value={Math.min(100, (offset / row.size) * 100)}
              aria-label={`${row.filename} 上传进度`}
            />}
            {current?.recovery && <p className="muted">{current.recovery}</p>}
            {row.status === "uploading" && !hasFile(row.id) && <p className="muted">等待重新选择原文件以续传，已上传进度会保留。</p>}
            {current?.preparing && <p className="muted" role="status">正在准备视频…</p>}
            {row.expiresAt && ["uploading", "failed"].includes(row.status) && <p className="muted">未完成或失败的文件将在 {dateTime(row.expiresAt)} 后自动清理。</p>}
            {(row.error || current?.error) && (
              <p className="error">{row.error || current?.error}</p>
            )}
            {(current?.paused || !readonly && ["uploading", "failed"].includes(row.status)) && <div className="task-bottom">
              <span className="muted">
                {current?.paused ? "已暂停，可继续上传。" : ""}
              </span>
              {!readonly && (
                <div className="actions">
                  {row.status === "failed" && row.taskId && (
                    <Button
                      variant="bordered" size="sm"
                      onClick={() => {
                        void run(async () => {
                          await api(`/tasks/${row.taskId}/retry`, "POST");
                          refresh((v) => v + 1);
                        });
                      }}
                    >
                      重试处理
                    </Button>
                  )}
                  {row.status === "uploading" && (
                    <>
                      {hasFile(row.id) && !current?.paused ? (
                        <Button variant="bordered" size="sm" onClick={() => pause(row.id)}>
                          暂停
                        </Button>
                      ) : hasFile(row.id) ? (
                        <Button
                          variant="bordered" size="sm"
                          onClick={() => {
                            void run(() => resume(row));
                          }}
                        >
                          继续上传
                        </Button>
                      ) : (
                        <FileUploadField className="file-resume" inputLabel="重新选择原文件" placeholder="重新选择原文件"
                          onFileSelect={(file) => { void run(() => resume(row, file)); }} />
                      )}
                      <Button
                        variant="ghost" size="sm"
                        className="quiet"
                        onClick={() => {
                          pause(row.id);
                          void run(async () => {
                            await api(`/uploads/${row.id}/cancel`, "POST");
                            forgetUpload(row.id);
                            refresh((v) => v + 1);
                          });
                        }}
                      >
                        取消任务
                      </Button>
                    </>
                  )}
                  {row.status === "failed" && (
                    <Button
                      variant="ghost" size="sm"
                      className="quiet"
                      onClick={() => {
                        void run(async () => {
                          await api(`/uploads/${row.id}/cancel`, "POST");
                            forgetUpload(row.id);
                          refresh((v) => v + 1);
                        });
                      }}
                    >
                      删除失败文件
                    </Button>
                  )}
                </div>
              )}
            </div>}
          </div>
        );
      })}</Card>}
      <Pagination {...list} loading={list.refreshing} label="上传任务分页" />
    </>
  );
}


function Family({
  embedded = false,
  run,
  readonly,
  notify,
  session,
  familyRenamed,
}: {
  run: Run;
  readonly: boolean;
  notify: (value: string) => void;
  session: Session;
  familyRenamed: (name: string) => void;
  embedded?: boolean;
}) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const requestedSection = location.pathname.split("/")[2] || (params.get("pair") === "1" ? "devices" : "general");
  const [serial, refresh] = useState(0),
    [timezone, setTimezone] = useState("");
  const [familyName, setFamilyName] = useState(session.family.name);
  const [savingFamilyName, setSavingFamilyName] = useState(false);
  useEffect(() => setFamilyName(session.family.name), [session.family.name]);
  useEffect(() => {
    if (params.get('app') !== '1') return;
    const frame = requestAnimationFrame(() => document.querySelector('.mobile-app-settings')?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [location.search]);
  const [currentPassword, setCurrentPassword] = useState(""),
    [newPassword, setNewPassword] = useState("");
  const settings = useData<
    | {
      familyName: string;
      timezone: string;
      defaultSubtitle: string;
      storage: {
        total: number;
        free: number;
        backend: string;
        usedBytes: number;
        reservedBytes: number;
        limitBytes: number;
      };
    }
    | undefined
  >("/settings", undefined, serial);
  useEffect(() => {
    if (settings.data) {
      setTimezone(settings.data.timezone);
    }
  }, [settings.data]);
  if (["devices", "watching"].includes(requestedSection)) return <Navigate to={`/devices${location.search}`} replace />;
  if (!embedded && location.pathname !== "/family") return <Navigate to={`/family${location.search}`} replace />;
  return <>
    <div className="page-title"><div><h1>家庭设置</h1><p>管理家庭资料、存储和账号安全。</p></div></div>
    <div className="mobile-app-settings settings-card" data-requested={params.get('app') === '1'}>
      <h2>应用与通知</h2><p className="muted">添加到主屏幕，或设置应用运行期间的电视开机提醒。</p>
      <div className="mobile-app-settings-actions"><InstallApp /><DeviceNotifications devices={undefined} familyId={session.family.id} /></div>
    </div>
    <div className="family-settings-grid">
      <div className="settings-column family-settings-account">
          <Card className="settings-card family-info-card">
            <h2>家庭信息</h2>
            <form onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                setSavingFamilyName(true);
                try {
                  const result = await api<{ familyName: string }>("/settings", "PUT", { familyName: familyName.trim() });
                  familyRenamed(result.familyName);
                  notify("家庭名称已更新。");
                } finally {
                  setSavingFamilyName(false);
                }
              });
            }}>
              <Label htmlFor="family-name">家庭名称</Label>
              <Input id="family-name" value={familyName} maxLength={128} onChange={(e) => setFamilyName(e.target.value)} disabled={readonly || savingFamilyName} required />
              {!readonly && <Button variant="bordered" className="mt-3" disabled={savingFamilyName || !familyName.trim() || familyName.trim() === session.family.name}>保存家庭名称</Button>}
            </form>
          </Card>
          {!readonly && (
            <Card className="settings-card family-password-card">
              <h2>修改密码</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await api("/password", "POST", {
                      currentPassword,
                      newPassword,
                    });
                    setCurrentPassword("");
                    setNewPassword("");
                    notify("密码已修改。");
                  });
                }}
              >
                <Label>
                  当前密码
                  <Input
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    required
                  />
                </Label>
                <Label>
                  新密码
                  <Input
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                  />
                </Label>
                <Button variant="bordered">修改密码</Button>
              </form>
            </Card>
          )}
      </div>
      <div className="settings-column family-settings-storage">
          <Card className="settings-card family-storage-card">
            <h2>时区与存储</h2>
            <State loading={settings.loading && !settings.data} error={settings.error} variant="detail" />
            {settings.data && (
              <>
                <p>
                  家庭文件{" "}
                  <strong>{bytes(settings.data.storage.usedBytes)}</strong> ·
                  上传中预留 {bytes(settings.data.storage.reservedBytes)}
                  {settings.data.storage.limitBytes > 0 &&
                    ` / ${bytes(settings.data.storage.limitBytes)}`}
                </p>
                {settings.data.storage.backend === "local" && (
                  <p>服务器磁盘剩余 {bytes(settings.data.storage.free)}</p>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      await api("/settings", "PUT", { timezone });
                      refresh((v) => v + 1);
                      notify("时区已更新，观看记录会按新时区重新汇总。");
                    });
                  }}
                >
                  <Label>
                    报表时区
                    <Input
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                      disabled={readonly}
                    />
                  </Label>
                  {!readonly && <Button variant="bordered">保存时区</Button>}
                </form>
                <p className="muted">
                  云端文件默认长期保留；电视播放时自动缓存，重复观看优先读取本地缓存，空间不足时自动清理较久未用的缓存。
                </p>
              </>
            )}
          </Card>
          <div className="family-cleanup-panel"><TrashRetentionSettings readonly={readonly} run={run} notify={notify} /></div>
      </div>
      <div className="family-usage-panel"><FamilyUsage /></div>
    </div>
  </>;
}

// Normalize previously issued entry links before HashRouter reads the location.
// Invitation credentials stay in the browser fragment and never enter request URLs.
function normalizeEntryLinks() {
  const entryUrl = new URL(window.location.href);
  const legacyInvite = new URLSearchParams(entryUrl.hash.slice(1)).get("invite");
  const legacyPair = entryUrl.searchParams.get("pair");
  if (legacyInvite !== null || legacyPair !== null) {
    entryUrl.hash = legacyInvite !== null
      ? `/invite${legacyInvite ? `?${new URLSearchParams({ token: legacyInvite })}` : ""}`
      : `/pair?${new URLSearchParams({ code: legacyPair || "" })}`;
    entryUrl.searchParams.delete("pair");
    history.replaceState(history.state, "", entryUrl.pathname + entryUrl.search + entryUrl.hash);
  }
}
startLifecycle();
normalizeEntryLinks();
window.addEventListener("popstate", normalizeEntryLinks);
window.addEventListener("hashchange", normalizeEntryLinks);

createRoot(document.getElementById("root")!).render(
  <>
    <PwaStatus />
    <HashRouter><App /></HashRouter>
    <FeedbackDialogs />
    <Toaster />
  </>,
);
