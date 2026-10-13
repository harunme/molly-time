import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Empty } from "@/components/ui/empty";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loading } from "@/components/ui/loading";
import { FileUpload, FileUploadField } from "@/components/ui/upload";
import { Toaster } from "@/components/ui/sonner";
import { FeedbackDialogs, confirmAction, promptText } from "./feedback";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { dateKey, parseDateKey } from "@/lib/date-only";
import { SelectField } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Operations } from "./operations";
import { FamilyUsage } from "./usage";
import { MediaPreview, TvDownloads, SubtitleSettings } from "./media";
import { PairingPage } from "./pairing";
import { BindEmail, InviteActivation } from "./accounts";
import { Overview } from "./overview";
import { ParentReminders } from "./reminders";
import { Pagination, ResourcePicker, useDebounced, usePagedData } from "./pagination";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import {
  api,
  bytes,
  dateTime,
  minutes,
  setSession,
  type Child,
  type Resource,
  type Session,
  type Upload,
  type WatchReport,
} from "./api";
import { enqueue, hasFile, live, pause, resume, stopUploads } from "./uploads";
import { getUploadLimits, useUploadLimits, validateUploadSize } from "./upload-limits";
import {
  FolderOpen,
  UploadCloud,
  LayoutDashboard,
  ChartNoAxesCombined,
  Users,
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
  Eye,
  ShieldCheck,
  UserRound,
  KeyRound,
  LoaderCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge as UiBadge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import "./style.css";

export type Run = (action: () => Promise<void>) => Promise<void>;
function useData<T>(path: string, initial: T, serial = 0) {
  const [data, setData] = useState(initial),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
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
  }, [path, serial]);
  return { data, error, loading };
}
function Icon({ name }: { name: string; }) {
  const icons: Record<string, typeof FolderOpen> = {
    library: FolderOpen,
    upload: UploadCloud,
    overview: LayoutDashboard,
    watch: ChartNoAxesCombined,
    family: Users,
    operations: Settings2,
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

function State({ loading, error }: { loading?: boolean; error?: string; }) {
  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  return loading ? <Loading size="sm" className="min-h-32" /> : null;
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
  const navigation = useRef<HTMLElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const inviteToken = new URLSearchParams(location.search).get("token");
  const pairCode = new URLSearchParams(location.search).get("code") || "";
  const page = location.pathname.split("/")[1];
  const [session, updateSession] = useState<Session>(),
    [checking, setChecking] = useState(true);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    setError("");
    setNotice("");
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [location.pathname, location.search]);
  useEffect(() => {
    api<Session>("/auth/session")
      .then((value) => {
        setSession(value);
        updateSession(value);
      })
      .catch(() => { })
      .finally(() => setChecking(false));
    const expired = () => {
      stopUploads();
      updateSession(undefined);
      setSession(undefined);
    };
    window.addEventListener("mollytime:unauthorized", expired);
    return () => window.removeEventListener("mollytime:unauthorized", expired);
  }, []);
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
  if (checking) return <Loading className="min-h-dvh" label="正在打开家庭媒体库…" />;
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
  if (location.pathname === "/pair")
    return (
      <PairingPage
        key={pairCode}
        initialCode={pairCode}
        session={session}
        close={() => {
          navigate("/family", { replace: true });
        }}
      />
    );
  const names = [
    ["overview", "概览"],
    ["watch", "观看记录"],
    ["library", "资源库"],
    ["upload", "上传任务"],
    ["family", "家庭设置"],
  ];
  if (session.user.role === "superadmin")
    names.push(["operations", "运营设置"]);
  const readonly = !["admin", "superadmin"].includes(session.user.role);
  return (
    <div className="workspace">
      <header className="workspace-brandbar">
        <Link className="wordmark" to="/overview">
          <span className="brand-symbol">
            <Film className="size-5" />
          </span>
          <span className="brand-copy">
            MollyTime<small>家庭媒体管理</small>
          </span>
        </Link>
        <span className="brandbar-area">家庭媒体管理</span>
        <div className="brandbar-identity">
          <span>{session.family.name}</span>
          <a className="brandbar-tv-link" href="/tv/" target="_blank" rel="noreferrer" aria-label="打开 TV 网页">
            <ExternalLink className="size-3.5" />
            <span>打开 TV 网页</span>
          </a>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="user-avatar" aria-label="账号菜单">
                <Avatar className="size-7"><AvatarFallback className="bg-white text-foreground">{session.user.name[0].toUpperCase()}</AvatarFallback></Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>
                {session.user.name} · {session.user.role === "superadmin" ? "平台超管" : readonly ? "家长成员" : "家庭管理员"}
              </DropdownMenuLabel>
              <DropdownMenuLabel>{session.user.email}</DropdownMenuLabel>
              <DropdownMenuLabel>账号 ID：{session.user.accountId}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => {
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
          <strong>{session.user.name}</strong>
        </div>
      </header>
      <aside className="manage-sidebar">
        <nav ref={navigation} aria-label="管理导航">
          {names.map(([id, name]) => (
            <Button
              variant="ghost"
              asChild
              key={id}
              className={page === id ? "nav-link active" : "nav-link"}
            >
              <NavLink to={`/${id}`}>
                <Icon name={id} />
                {name}
                {page === id && <ChevronRight className="ml-auto size-3.5" />}
              </NavLink>
            </Button>
          ))}
        </nav>
        <div className="sidebar-footnote">
          <Film className="size-4" />
          <span>好故事，一起看。</span>
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
            <Route path="overview" element={<Overview familyName={session.family.name} navigate={(destination) => navigate(`/${destination}`)} run={run} readonly={readonly} notify={setNotice} />} />
            <Route path="library" element={<Library run={run} readonly={readonly} />} />
            <Route path="library/:folderId" element={<FolderLibrary run={run} readonly={readonly} />} />
            <Route path="upload" element={<Uploads run={run} readonly={readonly} />} />
            <Route path="watch" element={<Reports />} />
            <Route path="operations/*" element={session.user.role === "superadmin"
              ? <Operations notify={setNotice} />
              : <Navigate to="/overview" replace />} />
            <Route path="family" element={<Family
              run={run}
              readonly={readonly}
              notify={setNotice}
              onPair={() => navigate("/pair")}
            />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
          <footer className="manage-footer">
            <span>MollyTime · 家庭放映室</span>
            <span>为下一次一起观看做准备</span>
          </footer>
        </div>
      </main>
    </div>
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
          <div className="wordmark">MollyTime</div>
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
  const folder = useData<Resource | undefined>(`/resources/${encodeURIComponent(folderId)}`, undefined);
  if (folder.error) return <><State error={folder.error} /><Button asChild variant="bordered"><Link to="/library">全部文件夹</Link></Button></>;
  if (folder.loading || folder.data?.id !== folderId) return <State loading />;
  if (folder.data.type !== "Series") return <Navigate to="/library" replace />;
  return <Library key={folderId} run={run} readonly={readonly} parent={folder.data} />;
}

function Library({ run, readonly, parent }: { run: Run; readonly: boolean; parent?: Resource; }) {
  const navigate = useNavigate();
  const [serial, refresh] = useState(0),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState("");
  const [edit, setEdit] = useState<Resource | "new">(),
    [upload, setUpload] = useState<Resource | "new">(),
    [preview, setPreview] = useState<Resource>();
  const [selected, setSelected] = useState<string[]>([]);
  const [uploadKind, setUploadKind] = useState("video");
  const query = useDebounced(search);
  const list = usePagedData<Resource>(
    `${parent ? `/folders/${parent.id}/videos` : "/resources"}?q=${encodeURIComponent(query)}&status=${encodeURIComponent(status)}`,
    serial,
  );
  const kind = !parent ? "Series" : "Episode";
  const filtered = list.data;
  useEffect(() => { setSelected([]); }, [parent?.id, query, status, list.page]);
  const changed = () => {
    refresh((v) => v + 1);
    setSelected([]);
  };
  const openEditor = (item: Resource) => {
    void run(async () => setEdit(await api<Resource>(`/resources/${item.id}`)));
  };
  const action = (ids: string[], mode: string) => {
    void run(async () => {
      const errors: string[] = [];
      for (const id of ids) {
        try {
          await api(`/resources/${id}/${mode}`, "POST");
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      changed();
      if (errors.length) throw new Error(errors.join("；"));
    });
  };
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{parent?.name || "资源库"}</h1>
          <p>先整理和预览，发布后在电视上观看。</p>
        </div>
        <div className="actions">
          {!readonly && (
            <>
              <Button variant="bordered" onClick={() => setEdit("new")}>
                新建{kind === "Series" ? "文件夹" : "视频"}
              </Button>
              <Button
                variant="default"
                aria-label="＋ 上传资源"
                className="primary"
                onClick={() => {
                  setUploadKind("video");
                  setUpload("new");
                }}
              >
                <UploadCloud className="size-4" />
                上传资源
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="breadcrumbs">
        <Button
          variant="bordered"
          onClick={() => {
            navigate("/library");
            setSelected([]);
          }}
        >
          全部文件夹
        </Button>
        {parent && (
          <React.Fragment>
            <span> / </span>
            <Button
              variant="bordered"
              onClick={() => {
                navigate(`/library/${encodeURIComponent(parent.id)}`);
                setSelected([]);
              }}
            >
              {parent.name}
            </Button>
          </React.Fragment>
        )}
      </div>
      <div className="toolbar library-toolbar">
        <InputGroup className="search-field">
          <InputGroupAddon><Search /></InputGroupAddon>
          <InputGroupInput
            aria-label="搜索资源"
            placeholder="搜索名称…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </InputGroup>
        <SelectField
          aria-label="资源状态"
          value={status}
          onValueChange={(value) => setStatus(value)}
          options={[({ value: "", label: <> 全部状态 </> }), ({ value: "published", label: <> 已发布 </> }), ({ value: "draft", label: <> 草稿 </> }), ({ value: "archived", label: <> 已归档 </> })]} />
        <span className="toolbar-count">
          {list.total} 个{parent ? "视频" : "文件夹"}
        </span>
      </div>
      <State loading={list.loading} error={list.error} />
      {!list.loading && !list.error && (
        <div className="resource-list">
          <div className="resource-list-heading">
            <span>名称</span>
            <span>状态</span>
            <span>操作</span>
          </div>
          {filtered.length ? (
            filtered.map((item) => (
              <article key={item.id} className="resource-row">
                {!readonly && (
                  <Checkbox
                    aria-label={`选择 ${item.name}`}
                    checked={selected.includes(item.id)}
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked === true
                          ? [...selected, item.id]
                          : selected.filter((id) => id !== item.id),
                      )
                    }
                  />
                )}
                <div
                  className={
                    item.type === "Series"
                      ? "thumbnail folder-thumbnail"
                      : "thumbnail"
                  }
                >
                  <img
                    key={item.imageUrl}
                    src={item.imageUrl}
                    alt=""
                    loading="lazy"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                  <span>
                    {item.type === "Series" ? (
                      <FolderOpen className="size-6" />
                    ) : (
                      <FileVideo className="size-5" />
                    )}
                  </span>
                </div>
                <div className="resource-name">
                  <Button
                    variant="bordered"
                    className="name-button"
                    onClick={() =>
                      item.type === "Episode"
                        ? setPreview(item)
                        : navigate(`/library/${encodeURIComponent(item.id)}`)
                    }
                  >
                    {item.name}
                  </Button>
                  <small>
                    {item.type === "Episode"
                      ? `${item.indexNumber ? `第 ${item.indexNumber} 集 · ` : ""}${item.runtimeMs ? minutes(item.runtimeMs) : "待检查文件"}`
                      : "文件夹 · 打开查看视频"}
                  </small>
                </div>
                <div className="resource-state">
                  <Badge value={item.status} />
                  {item.type === "Episode" && !item.ready && (
                    <small>尚未就绪</small>
                  )}
                </div>
                <div className="row-actions">
                  <Button
                    variant="ghost"
                    className="quiet"
                    onClick={() => openEditor(item)}
                  >
                    <Pencil className="size-3.5" />
                    {readonly ? "详情" : "编辑"}
                  </Button>
                  {!readonly && (
                    <>
                      <Button
                        variant="ghost"
                        className="quiet"
                        disabled={item.status !== "published" && !item.ready}
                        onClick={() =>
                          action(
                            [item.id],
                            item.status === "published"
                              ? "unpublish"
                              : "publish",
                          )
                        }
                      >
                        {item.status === "published" ? "下架" : "发布"}
                      </Button>
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
                        <DropdownMenuContent align="end">
                          {item.type === "Episode" && (
                            <>
                              <DropdownMenuItem
                                onSelect={() => setPreview(item)}
                              >
                                <Eye />
                                预览视频
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => {
                                  setUploadKind("subtitle");
                                  setUpload(item);
                                }}
                              >
                                <Captions />
                                上传字幕
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => {
                                  setUploadKind("video");
                                  setUpload(item);
                                }}
                              >
                                <UploadCloud />
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
                                  `归档“${item.name}”？电视将无法开始播放此内容。`,
                                )
                              )
                                action([item.id], "archive");
                            }}
                          >
                            <Archive />
                            归档
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )}
                </div>
              </article>
            ))
          ) : (
            <Empty className="empty">
              <FolderOpen className="size-9" />
              <h3>
                {search || status ? "没有匹配的资源" : "放入第一份好故事"}
              </h3>
              <p>
                {search || status
                  ? "试试其他名称或状态。"
                  : "上传视频，检查完成后预览并发布。"}
              </p>
            </Empty>
          )}
        </div>
      )}
      <Pagination {...list} loading={list.refreshing} label="资源库分页" />
      {!!selected.length && (
        <div className="selection-bar">
          已选 {selected.length} 项
          {parent && (
            <ResourcePicker
              label="移动到文件夹"
              placeholder="移动到文件夹…"
              exclude={[parent.id]}
              onChange={(folderId) => {
                if (!folderId) return;
                void run(async () => {
                  const errors: string[] = [];
                  for (const id of selected) {
                    try {
                      await api(`/resources/${id}/move`, "POST", { folderId });
                    } catch (error) {
                      errors.push((error as Error).message);
                    }
                  }
                  changed();
                  if (errors.length) throw new Error(errors.join("；"));
                });
              }}
            />
          )}
          <Button variant="bordered" onClick={() => action(selected, "publish")}>
            批量发布
          </Button>
          <Button
            variant="bordered"
            onClick={() => action(selected, "unpublish")}
          >
            批量下架
          </Button>
          <Button
            variant="ghost"
            className="quiet"
            onClick={() => setSelected([])}
          >
            取消选择
          </Button>
        </div>
      )}
      {edit && (
        <ResourceEditor
          item={edit === "new" ? undefined : edit}
          type={kind}
          parentId={parent?.id}
          readonly={readonly}
          close={() => setEdit(undefined)}
          saved={changed}
          run={run}
          attach={(item) => {
            setEdit(undefined);
            setUploadKind("video");
            setUpload(item);
          }}
        />
      )}
      {upload && (
        <UploadDialog
          initialKind={uploadKind}
          item={upload === "new" ? undefined : upload}
          parent={parent}
          run={run}
          close={() => {
            setUpload(undefined);
            changed();
          }}
        />
      )}
      {preview && (
        <Preview item={preview} close={() => setPreview(undefined)} />
      )}
    </>
  );
}

function ResourceEditor({
  item,
  type,
  parentId,
  readonly,
  close,
  saved,
  run,
  attach,
}: {
  item?: Resource;
  type: string;
  parentId?: string;
  readonly: boolean;
  close: () => void;
  saved: () => void;
  run: Run;
  attach: (item: Resource) => void;
}) {
  const [name, setName] = useState(item?.name || ""),
    [overview, setOverview] = useState(item?.overview || ""),
    [index, setIndex] = useState(item?.indexNumber?.toString() || ""),
    [busy, setBusy] = useState(false);
  return (
    <Modal
      title={
        item
          ? `${readonly ? "资源详情" : "编辑"} · ${item.name}`
          : `新建${type === "Series" ? "文件夹" : "视频"}`
      }
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void run(async () => {
            await api(
              item ? `/resources/${item.id}` : "/resources",
              item ? "PATCH" : "POST",
              {
                name,
                overview,
                indexNumber: index ? Number(index) : null,
                ...(!item ? { type, parentId: parentId || null } : {}),
              },
            );
            saved();
            close();
          }).finally(() => setBusy(false));
        }}
      >
        <Label>
          名称
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={256}
            required
            disabled={readonly}
          />
        </Label>
        {(item?.type || type) !== "Series" && (
          <Label>
            排序序号
            <Input
              type="number"
              min="1"
              max="100000"
              value={index}
              onChange={(e) => setIndex(e.target.value)}
              disabled={readonly}
            />
          </Label>
        )}
        <Label>
          介绍
          <Textarea
            value={overview}
            onChange={(e) => setOverview(e.target.value)}
            rows={3}
            disabled={readonly}
          />
        </Label>
        {item && (
          <section className="file-list">
            <h3>配套文件</h3>
            {item.files.length ? (
              item.files.map((file) => (
                <div key={file.id}>
                  <span>
                    {file.kind === "video"
                      ? "视频"
                      : file.kind === "subtitle"
                        ? "字幕"
                        : "封面"}{" "}
                    · {file.name}
                  </span>
                  <small>{bytes(file.size)}</small>
                </div>
              ))
            ) : (
              <p className="muted">还没有文件</p>
            )}
            {item.legacy && (
              <p className="muted">从原有媒体库导入，沿用之前的发布状态。</p>
            )}
            {!readonly && (
              <Button
                variant="bordered"
                type="button"
                onClick={() => attach(item)}
              >
                {item.type === "Episode"
                  ? "上传 / 替换视频、字幕或封面"
                  : "上传封面"}
              </Button>
            )}
          </section>
        )}
        {item?.type === "Episode" && (
          <>
            <SubtitleSettings item={item} readonly={readonly} />
            <TvDownloads item={item} readonly={readonly} />
          </>
        )}
        {!readonly && (
          <DialogFooter className="modal-actions">
            <Button variant="bordered" type="button" onClick={close}>
              取消
            </Button>
            <Button variant="default" className="primary" disabled={busy}>
              {busy ? "正在保存…" : "保存"}
            </Button>
          </DialogFooter>
        )}
      </form>
    </Modal>
  );
}

function Preview({ item, close }: { item: Resource; close: () => void; }) {
  return (
    <Modal title={`家长预览 · ${item.name}`} close={close}>
      <MediaPreview id={item.id} />
      <p className="muted">预览不计入儿童观看时长，也不修改儿童续播位置。</p>
    </Modal>
  );
}

function UploadDialog({
  item,
  parent,
  run,
  close,
  initialKind = "video",
}: {
  initialKind?: string;
  item?: Resource;
  parent?: Resource;
  run: Run;
  close: () => void;
}) {
  const [seriesId, setSeriesId] = useState(
    parent?.type === "Series" ? parent.id : "",
  ),
    [newSeries, setNewSeries] = useState("");
  const [kind, setKind] = useState(
    item?.type === "Episode" || !item ? initialKind : "image",
  ),
    [language, setLanguage] = useState("und");
  const [rows, setRows] = useState<
    { file: File; name: string; index: string; itemId?: string; }[]
  >([]),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const uploadPolicy = useUploadLimits();
  const submit = () => {
    setBusy(true);
    setError("");
    void (async () => {
      if (!rows.length) throw new Error("请先选择文件");
      const limits = await getUploadLimits();
      for (const row of rows) validateUploadSize(row.file, kind, limits);
      let target = parent?.id || "";
      if (!item && !target) {
        let sid = seriesId;
        if (!sid) {
          if (!newSeries.trim())
            throw new Error("请选择文件夹或填写新文件夹名称");
          sid = (
            await api<Resource>("/resources", "POST", {
              name: newSeries,
              type: "Series",
            })
          ).id;
          setSeriesId(sid);
        }
        target = sid;
      }
      for (const row of rows) {
        const id =
          item?.id ||
          row.itemId ||
          (
            await api<Resource>("/resources", "POST", {
              name: row.name,
              type: "Episode",
              parentId: target,
              indexNumber: row.index ? Number(row.index) : null,
            })
          ).id;
        if (!item && !row.itemId)
          setRows((current) =>
            current.map((r) =>
              r.file === row.file ? { ...r, itemId: id } : r,
            ),
          );
        await enqueue(row.file, id, kind, language);
        setRows((current) => current.filter((r) => r.file !== row.file));
      }
      close();
    })()
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <Modal title={item ? `上传文件 · ${item.name}` : "上传资源"} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {!item && !parent && (
          <div className="form-grid">
            <div className="picker-field">
              <span>文件夹</span>
              <ResourcePicker
                label="文件夹"
                value={seriesId}
                placeholder="新建文件夹"
                onChange={setSeriesId}
              />
            </div>
            {!seriesId && (
              <Label>
                新文件夹名称
                <Input
                  value={newSeries}
                  onChange={(e) => setNewSeries(e.target.value)}
                  required
                />
              </Label>
            )}
          </div>
        )}
        {item && (
          <Label>
            文件用途
            <SelectField
              value={kind}
              onValueChange={(value) => {
                setKind(value);
                setRows([]);
              }}
              options={[item.type === "Episode" && (
                [({ value: "video", label: <> 视频（替换当前视频） </> }), ({ value: "subtitle", label: <> 新增字幕 </> })]
              ), ({ value: "image", label: <> 封面（替换当前封面） </> })]} />
          </Label>
        )}
        {kind === "subtitle" && (
          <Label>
            字幕类型
            <SelectField
              value={language}
              onValueChange={(value) => setLanguage(value)}
              options={[({ value: "und", label: <> 未指定 </> }), ({ value: "zh", label: <> 中文 </> }), ({ value: "en", label: <> 英文 </> }), ({ value: "zh-en", label: <> 中英文 </> })]} />
          </Label>
        )}
        <FileUpload className="file-drop" inputLabel="选择上传文件"
          multiple={!item || kind === "subtitle"}
          disabled={busy || !uploadPolicy.limits}
          accept={kind === "video" ? ".mp4" : kind === "subtitle" ? ".srt,.vtt" : ".jpg,.jpeg,.png,.webp"}
          onFilesSelect={(files) => {
            try {
              if (!uploadPolicy.limits) return;
              for (const file of files) validateUploadSize(file, kind, uploadPolicy.limits);
              setError("");
              setRows(files.map((file) => ({ file, name: file.name.replace(/\.[^.]+$/, ""), index: "" })));
            } catch (failure) {
              setRows([]);
              setError((failure as Error).message);
            }
          }}>
          <UploadCloud className="size-8" />
          <strong>
            选择
            {kind === "video" ? "视频" : kind === "subtitle" ? "字幕" : "封面"}
            文件
          </strong>
          <span>
            {kind === "video"
              ? "MP4；可批量选择，播放兼容性取决于电视设备"
              : kind === "subtitle"
                ? "UTF-8 编码的 SRT / VTT"
                : "JPG / PNG / WebP"}
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
        {!uploadPolicy.limits && !uploadPolicy.error && <p role="status">正在加载上传限制…</p>}
        {uploadPolicy.error && <Alert variant="destructive" role="alert"><AlertDescription>{uploadPolicy.error}</AlertDescription></Alert>}
        {rows.map((row, index) => (
          <div className="upload-plan" key={index}>
            <div>
              <strong>{row.file.name}</strong>
              <small>{bytes(row.file.size)}</small>
            </div>
            {!item && (
              <>
                <Input
                  aria-label={`视频名称 ${index + 1}`}
                  value={row.name}
                  required
                  onChange={(e) =>
                    setRows(
                      rows.map((r, i) =>
                        i === index ? { ...r, name: e.target.value } : r,
                      ),
                    )
                  }
                />
                <Input
                  aria-label={`排序序号 ${index + 1}`}
                  placeholder="排序"
                  type="number"
                  min="1"
                  value={row.index}
                  onChange={(e) =>
                    setRows(
                      rows.map((r, i) =>
                        i === index ? { ...r, index: e.target.value } : r,
                      ),
                    )
                  }
                />
              </>
            )}
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

function Uploads({ run, readonly }: { run: Run; readonly: boolean; }) {
  const [serial, refresh] = useState(0),
    [localSerial, localRefresh] = useState(0);
  const list = usePagedData<Upload>("/uploads", serial);
  useEffect(() => {
    const changed = () => localRefresh((v) => v + 1);
    window.addEventListener("mollytime:uploads", changed);
    return () => {
      window.removeEventListener("mollytime:uploads", changed);
    };
  }, []);
  void localSerial;
  return (
    <>
      <div className="page-title">
        <div>
          <h1>上传任务</h1>
          <p>上传完成、文件就绪、内容发布，是三个不同的步骤。</p>
        </div>
      </div>
      {list.error && <State error={list.error} />}
      <div className="pipeline">
        <span>选择文件</span>
        <span>上传</span>
        <span>检查与封面</span>
        <span>预览后发布</span>
      </div>
      <State loading={list.loading} />
      {!list.loading && !list.data.length && (
        <Empty className="empty">
          <h3>还没有上传任务</h3>
          <p>到资源库选择视频，或给已有视频添加字幕和封面。</p>
        </Empty>
      )}
      {list.data.map((row) => {
        const current = live.get(row.id),
          offset = Math.max(row.offset, current?.offset || 0);
        return (
          <Card className="upload-task" key={row.id}>
            <div className="task-top">
              <div>
                <strong>{row.filename}</strong>
                <small>
                  {bytes(offset)} / {bytes(row.size)}
                </small>
              </div>
              <Badge value={row.status} />
            </div>
            <Progress
              value={Math.min(100, (offset / row.size) * 100)}
              aria-label={`${row.filename} 上传进度`}
            />
            {(row.error || current?.error) && (
              <p className="error">{row.error || current?.error}</p>
            )}
            <div className="task-bottom">
              <span className="muted">
                {row.status === "ready"
                  ? "文件检查完成，请在资源库预览并发布新视频。"
                  : row.status === "processing"
                    ? "正在检查编码、时长和封面。"
                    : current?.paused
                      ? "已暂停，可继续上传。"
                      : row.status === "uploading"
                        ? "离开此页面仍可上传；关闭浏览器会暂停。"
                        : ""}
              </span>
              {!readonly && (
                <div className="actions">
                  {row.status === "failed" && row.taskId && (
                    <Button
                      variant="bordered"
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
                        <Button variant="bordered" onClick={() => pause(row.id)}>
                          暂停
                        </Button>
                      ) : hasFile(row.id) ? (
                        <Button
                          variant="bordered"
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
                        variant="ghost"
                        className="quiet"
                        onClick={() => {
                          pause(row.id);
                          void run(async () => {
                            await api(`/uploads/${row.id}/cancel`, "POST");
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
                      variant="ghost"
                      className="quiet"
                      onClick={() => {
                        void run(async () => {
                          await api(`/uploads/${row.id}/cancel`, "POST");
                          refresh((v) => v + 1);
                        });
                      }}
                    >
                      删除失败文件
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Card>
        );
      })}
      <Pagination {...list} loading={list.refreshing} label="上传任务分页" />
    </>
  );
}

function Reports() {
  const children = usePagedData<Child>("/children", 0, 20, true, true),
    [child, setChild] = useState("");
  const today = new Date();
  const week = new Date(today);
  week.setDate(week.getDate() - 6);
  const [start, setStart] = useState(dateKey(week)),
    [end, setEnd] = useState(dateKey(today));
  const reportKey = `${start}|${end}|${child}`;
  const [position, setPosition] = useState({ key: reportKey, session: 1, content: 1 });
  const pages = position.key === reportKey ? position : { key: reportKey, session: 1, content: 1 };
  const report = useData<(WatchReport & { sessionTotal: number; contentTotal: number; pageSize: number; }) | undefined>(
    `/reports/watch-time?start=${start}&end=${end}${child ? `&childId=${encodeURIComponent(child)}` : ""}&sessionPage=${pages.session}&contentPage=${pages.content}&pageSize=20`,
    undefined,
  );
  const data = report.data,
    max = Math.max(...(data?.days.map((d) => d.playedMs) || [0]), 60000);
  return (
    <>
      <div className="page-title">
        <div>
          <h1>观看记录</h1>
          <p>统计真实播放时间，暂停、缓冲和拖动不计入。</p>
        </div>
      </div>
      <div className="toolbar report-filters">
        <Label>
          儿童
          <SelectField
            value={child}
            onValueChange={(value) => setChild(value)}
            options={[child && children.known[child] && !children.data.some((c) => c.id === child) && ({ value: child, label: <> {children.known[child].name} </> }), ({ value: "", label: <> 全家庭 </> }), children.data.map((c) => (
              ({ value: c.id, label: <> {c.name} </> })
            ))]} />
        </Label>
        <Label>
          开始日期
          <DatePicker
            aria-label="开始日期"
            data-testid="watch-start-date"
            value={parseDateKey(start)}
            onValueChange={(date) => { if (date) setStart(dateKey(date)); }}
          />
        </Label>
        <Label>
          结束日期
          <DatePicker
            aria-label="结束日期"
            data-testid="watch-end-date"
            value={parseDateKey(end)}
            onValueChange={(date) => { if (date) setEnd(dateKey(date)); }}
          />
        </Label>
        <Button
          variant="ghost"
          className="quiet"
          onClick={() => {
            setStart(dateKey(today));
            setEnd(dateKey(today));
          }}
        >
          今天
        </Button>
        <Button
          variant="ghost"
          className="quiet"
          onClick={() => {
            setStart(dateKey(week));
            setEnd(dateKey(today));
          }}
        >
          近 7 天
        </Button>
      </div>
      {children.total > children.pageSize && <Pagination {...children} loading={children.refreshing} label="儿童筛选分页" />}
      <State error={children.error} />
      <State loading={report.loading} error={report.error} />
      {!report.loading &&
        !report.error &&
        data &&
        (!data.statisticsSince ? (
          <Empty className="empty">
            <h3>等待第一条正式播放记录</h3>
            <p>已绑定的 TV 客户端播放视频后，记录会出现在这里；选择儿童后可按儿童统计。</p>
            <p>原有记录仅用于续播，无法还原历史观看时长。</p>
          </Empty>
        ) : (
          <>
            <div className="watch-summary">
              <div>
                <span>实际播放时长</span>
                <strong>{minutes(data.totalPlayedMs)}</strong>
              </div>
              <div>
                <span>播放过的视频</span>
                <strong>
                  {data.episodeCount}
                  <small> 个</small>
                </strong>
              </div>
              <div className="sync">
                <span>最后同步</span>
                <strong>{dateTime(data.lastSync)}</strong>
              </div>
            </div>
            <Card className="report-section">
              <h2>每日播放时间</h2>
              <div className="chart" role="img" aria-label="每日播放时长柱状图">
                {data.days.map((d) => (
                  <div
                    key={d.date}
                    title={`${d.date} · ${minutes(d.playedMs)}`}
                  >
                    <span className="bar-value">
                      {d.playedMs ? minutes(d.playedMs) : ""}
                    </span>
                    <div className="bar-track">
                      <span
                        style={{ height: `${(d.playedMs / max) * 100}%` }}
                      />
                    </div>
                    <small>{d.date.slice(5)}</small>
                  </div>
                ))}
              </div>
              <p className="muted">
                时区：{data.timezone} · 统计开始于{" "}
                {dateTime(data.statisticsSince)}
                。按设备播放时间累计，可能包含同时播放。
              </p>
            </Card>
            <Card className="report-section">
              <h2>内容分布</h2>
              {data.contents.length ? (
                data.contents.map((c) => (
                  <div className="content-duration" key={c.id}>
                    <span>{c.name}</span>
                    <Progress aria-label={`${c.name}播放时长占比`} value={c.playedMs / (data.totalPlayedMs || 1) * 100} className="w-1/4" />
                    <strong>{minutes(c.playedMs)}</strong>
                  </div>
                ))
              ) : (
                <p className="muted">所选日期内没有有效播放。</p>
              )}
              <Pagination page={pages.content} pageSize={data.pageSize} total={data.contentTotal} setPage={(content) => setPosition({ ...pages, content })} label="内容分布分页" />
            </Card>
            <Card className="report-section">
              <h2>播放明细</h2>
              <div className="table-scroll">
                <Table className="watch-sessions-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>开始时间</TableHead>
                      <TableHead>儿童 / 设备</TableHead>
                      <TableHead>内容</TableHead>
                      <TableHead>播放时长</TableHead>
                      <TableHead>结束情况</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.sessions.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell>{dateTime(s.startedAt)}</TableCell>
                        <TableCell>
                          {s.childName}
                          <small>{s.deviceName}</small>
                        </TableCell>
                        <TableCell>{s.name}</TableCell>
                        <TableCell>{minutes(s.playedMs)}</TableCell>
                        <TableCell>{s.ended ? "正常结束" : "播放中或未正常结束"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="muted">
                家长预览不计入。断网记录会补传；未能保存的崩溃尾段无法补算。
              </p>
              <Pagination page={pages.session} pageSize={data.pageSize} total={data.sessionTotal} setPage={(session) => setPosition({ ...pages, session })} label="播放明细分页" />
            </Card>
          </>
        ))}
    </>
  );
}

function Family({
  run,
  readonly,
  notify,
  onPair,
}: {
  run: Run;
  readonly: boolean;
  notify: (value: string) => void;
  onPair: () => void;
}) {
  const [serial, refresh] = useState(0),
    [childName, setChildName] = useState(""),
    [timezone, setTimezone] = useState("");
  const [defaultSubtitle, setDefaultSubtitle] = useState("zh");
  const [currentPassword, setCurrentPassword] = useState(""),
    [newPassword, setNewPassword] = useState("");
  const children = usePagedData<Child>("/children", serial),
    devices = usePagedData<
      { id: string; name: string; revoked: boolean; lastSeen: string; }
    >("/devices", serial);
  const settings = useData<
    | {
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
      setDefaultSubtitle(settings.data.defaultSubtitle ?? "zh");
    }
  }, [settings.data]);
  return (
    <>
      <div className="page-title">
        <div>
          <h1>家庭设置</h1>
          <p>儿童档案、电视设备、播放偏好与家庭用量。</p>
        </div>
      </div>
      <div className="settings-grid">
        <div className="settings-column">
          <FamilyUsage />
          <Card className="settings-card">
            <h2>儿童档案</h2>
            <State loading={children.loading} error={children.error} />
            {children.data.map((c) => (
              <div className="settings-row" key={c.id}>
                <span className="child-avatar">{c.name[0]}</span>
                <strong>{c.name}</strong>
                {!readonly && (
                  <Button
                    variant="ghost"
                    className="quiet"
                    onClick={async () => {
                      const name = await promptText("修改儿童名称", c.name);
                      if (name)
                        void run(async () => {
                          await api(`/children/${c.id}`, "PATCH", { name });
                          refresh((v) => v + 1);
                        });
                    }}
                  >
                    修改名称
                  </Button>
                )}
              </div>
            ))}
            <Pagination {...children} loading={children.refreshing} label="儿童档案分页" />
            {!readonly && (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await api("/children", "POST", { name: childName });
                    setChildName("");
                    children.setPage(Math.max(1, Math.ceil((children.total + 1) / children.pageSize)));
                    refresh((v) => v + 1);
                  });
                }}
              >
                <Input
                  aria-label="儿童名称"
                  placeholder="儿童名称"
                  value={childName}
                  maxLength={64}
                  onChange={(e) => setChildName(e.target.value)}
                  required
                />
                <Button variant="bordered">添加儿童</Button>
              </form>
            )}
          </Card>
          <Card className="settings-card">
            <h2>播放偏好</h2>
            <State loading={settings.loading} error={settings.error} />
            {settings.data && <form onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api("/settings", "PUT", { defaultSubtitle });
                refresh((v) => v + 1);
                notify("默认字幕已更新，下一次播放生效。");
              });
            }}>
              <Label htmlFor="default-subtitle">默认字幕</Label>
              <SelectField id="default-subtitle" value={defaultSubtitle} onValueChange={(value) => setDefaultSubtitle(value)} disabled={readonly} options={[({ value: "zh", label: <> 中文 </> }), ({ value: "en", label: <> 英文 </> }), ({ value: "zh-en", label: <> 中英文 </> }), ({ value: "off", label: <> 关闭字幕 </> })]} />
              <p className="muted">所有视频共用此偏好，与电视设置同步。没有匹配类型时关闭字幕；中英文需要对应的双语字幕文件。</p>
              {!readonly && <Button variant="bordered">保存默认字幕</Button>}
            </form>}
          </Card>
          <Card className="settings-card">
            <h2>时区与存储</h2>
            <State error={settings.error} />
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
                  云端文件默认长期保留；保存到电视后重复观看优先读取本地副本。
                </p>
              </>
            )}
          </Card>
        </div>
        <div className="settings-column">
          <Card className="settings-card">
            <div className="section-heading">
              <h2>TV 设备</h2>
              {!readonly && (
                <Button variant="bordered" onClick={onPair}>
                  绑定电视
                </Button>
              )}
            </div>
            <p className="muted">
              扫码或输入电视上的配对码绑定。取消配对后，电视需重新扫码。
            </p>
            <State loading={devices.loading} error={devices.error} />
            {devices.data.length ? (
              devices.data.map((d) => (
                <div className="device-row" key={d.id}>
                  <div>
                    <strong>{d.name}</strong>
                    <small>
                      {d.revoked
                        ? "已取消配对"
                        : `最近连接：${dateTime(d.lastSeen)}`}
                    </small>
                  </div>
                  {!readonly && !d.revoked && (
                    <div>
                      <Button
                        variant="ghost"
                        className="quiet"
                        onClick={async () => {
                          const name = await promptText("设备名称", d.name);
                          if (name)
                            void run(async () => {
                              await api(`/devices/${d.id}`, "PATCH", { name });
                              refresh((v) => v + 1);
                            });
                        }}
                      >
                        改名
                      </Button>
                      <Button
                        variant="ghost"
                        className="danger quiet"
                        onClick={async () => {
                          if (
                            await confirmAction(
                              `取消“${d.name}”的配对？电视将无法继续访问家庭媒体库。`,
                            )
                          )
                            void run(async () => {
                              await api(`/devices/${d.id}/revoke`, "POST");
                              refresh((v) => v + 1);
                            });
                        }}
                      >
                        取消配对
                      </Button>
                    </div>
                  )}
                </div>
              ))
            ) : (
              !devices.loading && <Empty className="empty">还没有绑定电视</Empty>
            )}
            <Pagination {...devices} loading={devices.refreshing} label="设备分页" />
          </Card>
          <ParentReminders readonly={readonly} run={run} notify={notify} />
          {!readonly && (
            <Card className="settings-card">
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
      </div>
    </>
  );
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
normalizeEntryLinks();
window.addEventListener("popstate", normalizeEntryLinks);
window.addEventListener("hashchange", normalizeEntryLinks);

createRoot(document.getElementById("root")!).render(
  <>
    <HashRouter><App /></HashRouter>
    <FeedbackDialogs />
    <Toaster />
  </>,
);
