import { FeedbackDialogs, confirmAction, promptText } from "./feedback";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Operations } from "./operations";
import { MediaPreview, TvDownloads, SubtitleSettings } from "./media";
import { PairingPage } from "./pairing";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  bytes,
  dateTime,
  minutes,
  scope,
  setSession,
  type Child,
  type Config,
  type Content,
  type Home,
  type Resource,
  type Row,
  type Session,
  type Upload,
  type WatchReport,
} from "./api";
import { enqueue, hasFile, live, pause, resume, stopUploads } from "./uploads";
import {
  FolderOpen,
  UploadCloud,
  PanelsTopLeft,
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
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
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
    setLoading(true);
    setError("");
    api<T>(path)
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
    };
  }, [path, serial]);
  return { data, error, loading };
}
function Icon({ name }: { name: string }) {
  const icons: Record<string, typeof FolderOpen> = {
    library: FolderOpen,
    upload: UploadCloud,
    home: PanelsTopLeft,
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
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {children}
      </DialogContent>
    </Dialog>
  );
}

function State({ loading, error }: { loading?: boolean; error?: string }) {
  return loading || error ? (
    <p className={error ? "error" : "empty"} role={error ? "alert" : "status"}>
      {error || "正在加载…"}
    </p>
  ) : null;
}
function Badge({ value }: { value: string }) {
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
  const [pairCode, setPairCode] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("pair"),
  );
  const [session, updateSession] = useState<Session>(),
    [checking, setChecking] = useState(true);
  const [page, setPage] = useState("library"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    api<Session>("/auth/session")
      .then((value) => {
        setSession(value);
        updateSession(value);
      })
      .catch(() => {})
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
    const reveal = () =>
      nav
        .querySelector('[aria-current="page"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
  if (checking) return <div className="boot">正在打开家庭媒体库…</div>;
  if (!session)
    return (
      <Login
        done={(value) => {
          setSession(value);
          updateSession(value);
          setError("");
        }}
      />
    );
  if (pairCode !== null)
    return (
      <PairingPage
        initialCode={pairCode}
        session={session}
        close={() => {
          const url = new URL(location.href);
          url.searchParams.delete("pair");
          history.replaceState(null, "", url.pathname + url.search + url.hash);
          setPairCode(null);
          setPage("family");
        }}
      />
    );
  const names = [
    ["library", "资源库"],
    ["upload", "上传任务"],
    ["home", "首页编排"],
    ["watch", "观看记录"],
    ["family", "家庭设置"],
  ];
  if (session.user.role === "superadmin")
    names.push(["operations", "运营设置"]);
  const readonly = !["admin", "superadmin"].includes(session.user.role);
  const currentPage = names.find(([id]) => id === page)?.[1] || "资源库";
  return (
    <div className="workspace">
      <aside className="manage-sidebar">
        <a className="wordmark" href="/manage/">
          <span className="brand-symbol">
            <Film className="size-5" />
          </span>
          <span className="brand-copy">
            MollyTime<small>家庭媒体管理</small>
          </span>
        </a>
        <div className="family-name">
          <span className="family-avatar">{session.family.name[0]}</span>
          <div>
            <strong>{session.family.name}</strong>
            <small>家庭工作空间</small>
          </div>
        </div>
        <p className="nav-label">媒体管理</p>
        <nav ref={navigation} aria-label="管理导航">
          {names.map(([id, name]) => (
            <Button
              variant="ghost"
              key={id}
              className={page === id ? "nav-link active" : "nav-link"}
              aria-current={page === id ? "page" : undefined}
              onClick={() => {
                setPage(id);
                setError("");
                setNotice("");
              }}
            >
              <Icon name={id} />
              {name}
              {page === id && <ChevronRight className="ml-auto size-3.5" />}
            </Button>
          ))}
        </nav>
        <div className="sidebar-footnote">
          <Film className="size-4" />
          <span>好故事，一起看。</span>
        </div>
        <div className="sidebar-bottom">
          <span className="user-avatar">
            {session.user.name[0].toUpperCase()}
          </span>
          <div>
            <strong>{session.user.name}</strong>
            <small>
              {session.user.role === "superadmin"
                ? "平台超管"
                : readonly
                  ? "家长成员"
                  : "家庭管理员"}
            </small>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="退出账号"
            onClick={() => {
              void run(async () => {
                await api("/auth/logout", "POST");
                stopUploads();
                setSession(undefined);
                updateSession(undefined);
              });
            }}
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </aside>
      <main className="manage-main">
        <header className="topbar">
          <div>
            <span>工作空间</span>
            <ChevronRight className="size-3.5" />
            <strong>{currentPage}</strong>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href="/tv/" target="_blank" rel="noreferrer">
                <ExternalLink className="size-3.5" />
                打开 TV 网页
              </a>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="lg:hidden"
                  aria-label="账号菜单"
                >
                  <Users className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{session.user.name}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    void run(async () => {
                      await api("/auth/logout", "POST");
                      stopUploads();
                      setSession(undefined);
                      updateSession(undefined);
                    });
                  }}
                >
                  <LogOut />
                  退出账号
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <div className="page-content">
          {error && (
            <div className="banner error" role="alert">
              {error}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="关闭错误"
                onClick={() => setError("")}
              >
                ×
              </Button>
            </div>
          )}
          {notice && (
            <div className="banner notice" role="status">
              <CircleCheck className="size-4 shrink-0" />
              {notice}
            </div>
          )}
          {readonly && (
            <p className="banner">
              当前账号可查看资料和观看记录，编辑需要管理员账号。
            </p>
          )}
          {page === "library" && <Library run={run} readonly={readonly} />}
          {page === "upload" && <Uploads run={run} readonly={readonly} />}
          {page === "home" && (
            <HomeEditor run={run} readonly={readonly} notify={setNotice} />
          )}
          {page === "watch" && <Reports />}
          {page === "operations" && session.user.role === "superadmin" && (
            <Operations notify={setNotice} />
          )}
          {page === "family" && (
            <Family
              run={run}
              readonly={readonly}
              notify={setNotice}
              onPair={() => setPairCode("")}
            />
          )}
          <footer className="manage-footer">
            <span>MollyTime · 家庭放映室</span>
            <span>为下一次一起观看做准备</span>
          </footer>
        </div>
      </main>
    </div>
  );
}

function Login({ done }: { done: (session: Session) => void }) {
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [family, setFamily] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="login">
      <section className="login-story">
        <div className="wordmark">
          MollyTime<span>家庭放映室</span>
        </div>
        <div>
          <p className="eyebrow">属于我们家的内容</p>
          <h1>
            挑好故事，
            <br />
            留给好奇的眼睛。
          </h1>
          <p>整理资源，安排首页，了解孩子的播放时间。</p>
          <div className="login-reels" aria-hidden="true">
            <div>
              <Film />
              <span>故事</span>
            </div>
            <div>
              <Captions />
              <span>语言</span>
            </div>
            <div>
              <PanelsTopLeft />
              <span>发现</span>
            </div>
          </div>
        </div>
      </section>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          void api<Session>("/auth/login", "POST", {
            username,
            password,
            ...(family ? { familyId: family } : {}),
          })
            .then(done)
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <span className="login-badge">
          <ShieldCheck className="size-3.5" />
          家庭管理
        </span>
        <h2>进入管理后台</h2>
        <p className="login-description">登录后管理片单、字幕和电视设备。</p>
        <label>
          账号
          <Input
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label>
          密码
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <details>
          <summary>指定家庭（可选）</summary>
          <label>
            家庭 ID
            <Input value={family} onChange={(e) => setFamily(e.target.value)} />
          </label>
        </details>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <Button variant="default" className="primary" disabled={busy}>
          {busy ? "正在登录…" : "登录"}
        </Button>
        <p className="muted">使用超管、家庭管理员或成员账号。</p>
      </form>
    </div>
  );
}

function Library({ run, readonly }: { run: Run; readonly: boolean }) {
  const [path, setPath] = useState<Resource[]>([]),
    [serial, refresh] = useState(0),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState("");
  const [edit, setEdit] = useState<Resource | "new">(),
    [upload, setUpload] = useState<Resource | "new">(),
    [preview, setPreview] = useState<Resource>();
  const [selected, setSelected] = useState<string[]>([]);
  const [uploadKind, setUploadKind] = useState("video");
  const parent = path[path.length - 1];
  const list = useData<Resource[]>(
    parent ? `/folders/${parent.id}/videos` : "/resources",
    [],
    serial,
  );
  const folders = useData<Resource[]>("/resources", [], serial);
  const kind = !parent ? "Series" : "Episode";
  const filtered = list.data.filter(
    (item) =>
      item.name.toLowerCase().includes(search.toLowerCase()) &&
      (!status || item.status === status),
  );
  const changed = () => {
    refresh((v) => v + 1);
    setSelected([]);
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
              <Button variant="outline" onClick={() => setEdit("new")}>
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
          variant="outline"
          onClick={() => {
            setPath([]);
            setSelected([]);
          }}
        >
          全部文件夹
        </Button>
        {path.map((p, i) => (
          <React.Fragment key={p.id}>
            <span> / </span>
            <Button
              variant="outline"
              onClick={() => {
                setPath(path.slice(0, i + 1));
                setSelected([]);
              }}
            >
              {p.name}
            </Button>
          </React.Fragment>
        ))}
      </div>
      <div className="toolbar library-toolbar">
        <div className="search-field">
          <Search className="size-4" />
          <Input
            aria-label="搜索资源"
            placeholder="搜索名称…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <NativeSelect
          aria-label="资源状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">全部状态</option>
          <option value="published">已发布</option>
          <option value="draft">草稿</option>
          <option value="archived">已归档</option>
        </NativeSelect>
        <Button variant="ghost" className="quiet" onClick={changed}>
          <RefreshCw className="size-3.5" />
          刷新
        </Button>
        <span className="toolbar-count">
          {filtered.length} 个{parent ? "视频" : "文件夹"}
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
                    variant="outline"
                    className="name-button"
                    onClick={() =>
                      item.type === "Episode"
                        ? setPreview(item)
                        : (setPath([...path, item]), setSelected([]))
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
                    onClick={() => setEdit(item)}
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
                            size="icon-sm"
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
            <div className="empty">
              <FolderOpen className="size-9" />
              <h3>
                {search || status ? "没有匹配的资源" : "放入第一份好故事"}
              </h3>
              <p>
                {search || status
                  ? "试试其他名称或状态。"
                  : "上传视频，检查完成后预览并发布。"}
              </p>
            </div>
          )}
        </div>
      )}
      {!!selected.length && (
        <div className="selection-bar">
          已选 {selected.length} 项
          {parent && (
            <NativeSelect
              aria-label="移动到文件夹"
              value=""
              onChange={(e) => {
                const folderId = e.target.value;
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
            >
              <option value="">移动到文件夹…</option>
              {folders.data
                .filter((f) => f.id !== parent.id)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </NativeSelect>
          )}
          <Button variant="outline" onClick={() => action(selected, "publish")}>
            批量发布
          </Button>
          <Button
            variant="outline"
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
        <label>
          名称
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={256}
            required
            disabled={readonly}
          />
        </label>
        {(item?.type || type) !== "Series" && (
          <label>
            排序序号
            <Input
              type="number"
              min="1"
              max="100000"
              value={index}
              onChange={(e) => setIndex(e.target.value)}
              disabled={readonly}
            />
          </label>
        )}
        <label>
          介绍
          <Textarea
            value={overview}
            onChange={(e) => setOverview(e.target.value)}
            rows={3}
            disabled={readonly}
          />
        </label>
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
                variant="outline"
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
          <div className="modal-actions">
            <Button variant="outline" type="button" onClick={close}>
              取消
            </Button>
            <Button variant="default" className="primary" disabled={busy}>
              {busy ? "正在保存…" : "保存"}
            </Button>
          </div>
        )}
      </form>
    </Modal>
  );
}

function Preview({ item, close }: { item: Resource; close: () => void }) {
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
  const series = useData<Resource[]>("/resources", []);
  const [seriesId, setSeriesId] = useState(
      parent?.type === "Series" ? parent.id : "",
    ),
    [newSeries, setNewSeries] = useState("");
  const [kind, setKind] = useState(
      item?.type === "Episode" || !item ? initialKind : "image",
    ),
    [language, setLanguage] = useState("und");
  const [rows, setRows] = useState<
      { file: File; name: string; index: string; itemId?: string }[]
    >([]),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = () => {
    setBusy(true);
    setError("");
    void (async () => {
      if (!rows.length) throw new Error("请先选择文件");
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
            <label>
              文件夹
              <NativeSelect
                value={seriesId}
                onChange={(e) => setSeriesId(e.target.value)}
              >
                <option value="">新建文件夹</option>
                {series.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            {!seriesId && (
              <label>
                新文件夹名称
                <Input
                  value={newSeries}
                  onChange={(e) => setNewSeries(e.target.value)}
                  required
                />
              </label>
            )}
          </div>
        )}
        {item && (
          <label>
            文件用途
            <NativeSelect
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setRows([]);
              }}
            >
              {item.type === "Episode" && (
                <>
                  <option value="video">视频（替换当前视频）</option>
                  <option value="subtitle">新增字幕</option>
                </>
              )}
              <option value="image">封面（替换当前封面）</option>
            </NativeSelect>
          </label>
        )}
        {kind === "subtitle" && (
          <label>
            字幕语言
            <NativeSelect
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option value="und">未指定</option>
              <option value="zh">中文</option>
              <option value="en">英语</option>
            </NativeSelect>
          </label>
        )}
        <label className="file-drop">
          <UploadCloud className="size-8" />
          <strong>
            选择
            {kind === "video" ? "视频" : kind === "subtitle" ? "字幕" : "封面"}
            文件
          </strong>
          <span>
            {kind === "video"
              ? "MP4 · H.264 / AAC；可批量选择"
              : kind === "subtitle"
                ? "UTF-8 编码的 SRT / VTT"
                : "JPG / PNG / WebP"}
          </span>
          <Button asChild variant="outline">
            <span>
              {rows.length ? `已选择 ${rows.length} 个文件` : "选择本地文件"}
            </span>
          </Button>
          <Input
            className="sr-only"
            aria-label="选择上传文件"
            type="file"
            multiple={!item || kind === "subtitle"}
            accept={
              kind === "video"
                ? ".mp4"
                : kind === "subtitle"
                  ? ".srt,.vtt"
                  : ".jpg,.jpeg,.png,.webp"
            }
            onChange={(e) =>
              setRows(
                Array.from(e.target.files || []).map((file) => ({
                  file,
                  name: file.name.replace(/\.[^.]+$/, ""),
                  index: "",
                })),
              )
            }
          />
        </label>
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
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={close}
          >
            取消
          </Button>
          <Button
            variant="default"
            className="primary"
            disabled={busy || !rows.length}
          >
            {busy
              ? "正在建立上传任务…"
              : `开始上传${rows.length ? ` ${rows.length} 个文件` : ""}`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Uploads({ run, readonly }: { run: Run; readonly: boolean }) {
  const [serial, refresh] = useState(0),
    [localSerial, localRefresh] = useState(0);
  const list = useData<Upload[]>("/uploads", [], serial);
  useEffect(() => {
    const timer = setInterval(() => refresh((v) => v + 1), 3000);
    const changed = () => localRefresh((v) => v + 1);
    window.addEventListener("mollytime:uploads", changed);
    return () => {
      clearInterval(timer);
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
      {!list.data.length && (
        <div className="empty">
          <h3>还没有上传任务</h3>
          <p>到资源库选择视频，或给已有视频添加字幕和封面。</p>
        </div>
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
                      variant="outline"
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
                        <Button variant="outline" onClick={() => pause(row.id)}>
                          暂停
                        </Button>
                      ) : hasFile(row.id) ? (
                        <Button
                          variant="outline"
                          onClick={() => {
                            void run(() => resume(row));
                          }}
                        >
                          继续上传
                        </Button>
                      ) : (
                        <label className="file-resume">
                          重新选择原文件
                          <Input
                            type="file"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) void run(() => resume(row, file));
                            }}
                          />
                        </label>
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
    </>
  );
}

function TvHomePreview({ home }: { home: Home }) {
  const featured = home.rows[0]?.items[0];
  const cover = (item: Home["rows"][number]["items"][number]) => (
    <div className="tv-cover" key={item.image?.url || item.id}>
      <span>{item.name.slice(0, 2)}</span>
      {item.image?.url && (
        <img
          src={item.image.url}
          alt=""
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      )}
    </div>
  );
  return (
    <div className="tv-preview">
      <div className="tv-sidebar">
        <div className="tv-wordmark">MollyTime</div>
        <span className="tv-nav-active">首页</span>
        <span>谁在看</span>
        <span>设置</span>
      </div>
      <div className="tv-preview-content">
        <small>我们的媒体库</small>
        <div className="tv-feature">
          <div>
            <small>现在想看什么？</small>
            <h3>{featured?.name || "家庭放映室"}</h3>
            {featured && (
              <p>
                确定 · {featured.type === "episode" ? "继续播放" : "打开文件夹"}
              </p>
            )}
          </div>
          {featured && cover(featured)}
        </div>
        <div className="tv-preview-rows">
          {home.rows.map((row, index) => (
            <div className="tv-shelf" key={index}>
              <strong>{row.title}</strong>
              <div>
                {row.items.map((item) => (
                  <Button variant="outline" key={item.id} title={item.name}>
                    {cover(item)}
                    <span>{item.name}</span>
                  </Button>
                ))}
              </div>
            </div>
          ))}
          {home.rows.length === 0 && (
            <p>还没有可展示的内容。选择已发布文件夹，或为儿童添加播放记录。</p>
          )}
        </div>
      </div>
    </div>
  );
}

function HomeEditor({
  run,
  readonly,
  notify,
}: {
  run: Run;
  readonly: boolean;
  notify: (value: string) => void;
}) {
  const children = useData<Child[]>("/children", []),
    series = useData<Resource[]>("/resources", []);
  const [child, setChild] = useState(""),
    [config, setConfig] = useState<Config>(),
    [content, setContent] = useState<Content>({ schemaVersion: 1, rows: [] });
  const [selected, setSelected] = useState(0),
    [preview, setPreview] = useState<Home>({ rows: [] }),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [history, setHistory] =
      useState<{ id: string; createdAt: string; content: Content }[]>(),
    [dirty, setDirty] = useState(false);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    api<Config>("/home-config" + scope(child))
      .then((value) => {
        if (alive) {
          setConfig(value);
          setContent(value.content);
          setDirty(false);
          setSelected(0);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [child]);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      api<Home>("/home-config/preview", "POST", {
        content,
        childId: child || null,
      })
        .then((value) => {
          if (alive) setPreview(value);
        })
        .catch(() => {
          if (alive) setPreview({ rows: [] });
        });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [content, child]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  const change = (value: Content) => {
    setContent(value);
    setDirty(true);
  };
  const editRow = (update: Partial<Row>) =>
    change({
      ...content,
      rows: content.rows.map((row, i) =>
        i === selected ? { ...row, ...update } : row,
      ),
    });
  const reorder = (index: number, delta: number) => {
    const rows = [...content.rows];
    if (index + delta < 0 || index + delta >= rows.length) return;
    [rows[index], rows[index + delta]] = [rows[index + delta], rows[index]];
    change({ ...content, rows });
    setSelected(index + delta);
  };
  const save = (publish: boolean) => {
    if (!config) return;
    setBusy(true);
    void run(async () => {
      let result = await api<Config>("/home-config" + scope(child), "PUT", {
        revision: config.revision,
        content,
      });
      // Retain the saved revision even if publication validation fails.
      setConfig(result);
      setDirty(false);
      if (publish) {
        result = await api<Config>(
          "/home-config/publish" + scope(child),
          "POST",
          { revision: result.revision },
        );
        setConfig(result);
      }
      notify(
        publish
          ? "首页已发布。电视进入或返回首页时更新。"
          : "草稿已保存，电视首页尚未改变。",
      );
    }).finally(() => setBusy(false));
  };
  const row = content.rows[selected];
  return (
    <>
      <div className="page-title">
        <div>
          <h1>首页编排</h1>
          <p>按栏目组织内容，发布后再出现在电视上。</p>
        </div>
        <div className="actions">
          {!readonly && (
            <>
              <Button
                variant="outline"
                disabled={busy || loading}
                onClick={() => save(false)}
              >
                保存草稿
              </Button>
              <Button
                variant="default"
                className="primary"
                disabled={busy || loading}
                onClick={() => save(true)}
              >
                {busy ? "正在保存…" : "发布首页"}
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="toolbar">
        <label>
          编辑对象
          <NativeSelect
            value={child}
            onChange={async (e) => {
              if (
                !dirty ||
                (await confirmAction("切换对象将放弃未保存修改，继续吗？"))
              )
                setChild(e.target.value);
            }}
          >
            <option value="">家庭默认首页</option>
            {children.data.map((c) => (
              <option value={c.id} key={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <span className="muted">
          {dirty
            ? "有未保存修改"
            : config?.followingFamily
              ? "当前跟随家庭首页；发布后独立配置"
              : config?.publishedId
                ? "已有发布版本"
                : "尚未独立发布"}
        </span>
        <Button
          variant="ghost"
          className="quiet"
          onClick={() => {
            void run(async () =>
              setHistory(await api("/home-config/revisions" + scope(child))),
            );
          }}
        >
          版本记录
        </Button>
        {child && !readonly && (
          <Button
            variant="ghost"
            className="quiet"
            onClick={async () => {
              if (
                await confirmAction(
                  "切回家庭首页？独立发布版本会保留在历史中。",
                )
              )
                void run(async () => {
                  const value = await api<Config>(
                    "/home-config" + scope(child),
                    "DELETE",
                  );
                  setConfig(value);
                  setContent(value.content);
                  setDirty(false);
                });
            }}
          >
            跟随家庭
          </Button>
        )}
      </div>
      <State loading={loading} error={error} />
      {!loading && !error && (
        <div className="home-editor">
          <Card className="column-editor">
            <h2>栏目顺序</h2>
            {content.rows.map((r, i) => (
              <div
                key={r.id}
                className={`column-row ${selected === i ? "selected" : ""}`}
              >
                <Button
                  variant="ghost"
                  className="quiet column-name"
                  onClick={() => setSelected(i)}
                >
                  {r.title}
                  <small>{r.enabled ? "显示" : "隐藏"}</small>
                </Button>
                {!readonly && (
                  <div>
                    <Button
                      variant="ghost"
                      className="quiet"
                      aria-label={`上移 ${r.title}`}
                      disabled={i === 0}
                      onClick={() => reorder(i, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      className="quiet"
                      aria-label={`下移 ${r.title}`}
                      disabled={i === content.rows.length - 1}
                      onClick={() => reorder(i, 1)}
                    >
                      ↓
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {!readonly && (
              <Button
                variant="outline"
                className="add-column"
                disabled={content.rows.length >= 12}
                onClick={() => {
                  change({
                    ...content,
                    rows: [
                      ...content.rows,
                      {
                        id: crypto.randomUUID(),
                        title: "新栏目",
                        source: "manual",
                        enabled: true,
                        limit: 12,
                        itemIds: [],
                      },
                    ],
                  });
                  setSelected(content.rows.length);
                }}
              >
                ＋ 添加栏目
              </Button>
            )}
            {row && (
              <fieldset disabled={readonly}>
                <legend>栏目设置</legend>
                <label>
                  栏目标题
                  <Input
                    value={row.title}
                    maxLength={40}
                    onChange={(e) => editRow({ title: e.target.value })}
                  />
                </label>
                <label>
                  内容来源
                  <NativeSelect
                    value={row.source}
                    onChange={(e) =>
                      editRow({
                        source: e.target.value as Row["source"],
                        itemIds: [],
                      })
                    }
                  >
                    <option value="manual">手选文件夹</option>
                    <option value="recent">最近发布</option>
                    <option value="continue">继续观看</option>
                  </NativeSelect>
                </label>
                <label>
                  最多显示
                  <Input
                    type="number"
                    min="1"
                    max="48"
                    value={row.limit}
                    onChange={(e) => editRow({ limit: Number(e.target.value) })}
                  />
                </label>
                <label className="check-label">
                  <Checkbox
                    checked={row.enabled}
                    onCheckedChange={(checked) =>
                      editRow({ enabled: checked === true })
                    }
                  />
                  显示这个栏目
                </label>
                {row.source === "manual" && (
                  <div className="series-picker">
                    <p>按选择顺序显示文件夹</p>
                    {row.itemIds.map((id, i) => (
                      <div className="picked-series" key={id}>
                        <span>
                          {series.data.find((s) => s.id === id)?.name ||
                            "资源已不可用"}
                        </span>
                        <Button
                          variant="ghost"
                          className="quiet"
                          type="button"
                          aria-label="前移文件夹"
                          disabled={i === 0}
                          onClick={() => {
                            const ids = [...row.itemIds];
                            [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                            editRow({ itemIds: ids });
                          }}
                        >
                          ↑
                        </Button>
                        <Button
                          variant="ghost"
                          className="quiet"
                          type="button"
                          aria-label="移除文件夹"
                          onClick={() =>
                            editRow({
                              itemIds: row.itemIds.filter((key) => key !== id),
                            })
                          }
                        >
                          ×
                        </Button>
                      </div>
                    ))}
                    <NativeSelect
                      aria-label="添加文件夹"
                      value=""
                      onChange={(e) => {
                        if (e.target.value)
                          editRow({
                            itemIds: [...row.itemIds, e.target.value],
                          });
                      }}
                    >
                      <option value="">＋ 选择文件夹</option>
                      {series.data
                        .filter((s) => !row.itemIds.includes(s.id))
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                            {s.status !== "published" ? "（未发布）" : ""}
                          </option>
                        ))}
                    </NativeSelect>
                  </div>
                )}
                {row.source === "continue" && (
                  <p className="muted">
                    根据儿童的未看完的视频自动显示。旧 TV 客户端会跳过此栏目。
                  </p>
                )}
                <Button
                  variant="ghost"
                  type="button"
                  className="danger quiet"
                  onClick={() => {
                    change({
                      ...content,
                      rows: content.rows.filter((_, i) => i !== selected),
                    });
                    setSelected(0);
                  }}
                >
                  删除栏目
                </Button>
              </fieldset>
            )}
          </Card>
          <section className="preview-panel">
            <div className="preview-label">
              <h2>TV 比例预览</h2>
              <span>
                {children.data.find((c) => c.id === child)?.name || "家庭默认"}
              </span>
            </div>
            <TvHomePreview home={preview} />
            <p className="muted">
              预览会过滤未发布或下架内容。首页顺序不限制儿童访问其他已发布内容。
            </p>
          </section>
        </div>
      )}
      {history && (
        <Modal title="已发布版本" close={() => setHistory(undefined)}>
          {history.length ? (
            history.map((r) => (
              <div className="history-row" key={r.id}>
                <span>{dateTime(r.createdAt)}</span>
                <Button
                  variant="outline"
                  disabled={readonly}
                  onClick={async () => {
                    if (
                      await confirmAction(
                        "将这个版本恢复到草稿？发布后电视才会更新。",
                      )
                    ) {
                      change(r.content);
                      setHistory(undefined);
                    }
                  }}
                >
                  恢复到草稿
                </Button>
              </div>
            ))
          ) : (
            <p className="empty">还没有发布记录</p>
          )}
        </Modal>
      )}
    </>
  );
}

function Reports() {
  const children = useData<Child[]>("/children", []),
    [child, setChild] = useState("");
  const today = new Date();
  const localDate = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const week = new Date(today);
  week.setDate(week.getDate() - 6);
  const [start, setStart] = useState(localDate(week)),
    [end, setEnd] = useState(localDate(today)),
    [serial, refresh] = useState(0);
  const report = useData<WatchReport | undefined>(
    `/reports/watch-time?start=${start}&end=${end}${child ? `&childId=${child}` : ""}`,
    undefined,
    serial,
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
        <Button variant="outline" onClick={() => refresh((v) => v + 1)}>
          刷新记录
        </Button>
      </div>
      <div className="toolbar report-filters">
        <label>
          儿童
          <NativeSelect
            value={child}
            onChange={(e) => setChild(e.target.value)}
          >
            <option value="">全家庭</option>
            {children.data.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label>
          开始日期
          <Input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          结束日期
          <Input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <Button
          variant="ghost"
          className="quiet"
          onClick={() => {
            setStart(localDate(today));
            setEnd(localDate(today));
          }}
        >
          今天
        </Button>
        <Button
          variant="ghost"
          className="quiet"
          onClick={() => {
            setStart(localDate(week));
            setEnd(localDate(today));
          }}
        >
          近 7 天
        </Button>
      </div>
      <State loading={report.loading} error={report.error} />
      {!report.loading &&
        !report.error &&
        data &&
        (!data.statisticsSince ? (
          <div className="empty">
            <h3>等待第一条正式播放记录</h3>
            <p>更新后的 TV 客户端选择儿童并播放视频后，记录会出现在这里。</p>
            <p>原有记录仅用于续播，无法还原历史观看时长。</p>
          </div>
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
                    <meter
                      min={0}
                      max={data.totalPlayedMs || 1}
                      value={c.playedMs}
                    />
                    <strong>{minutes(c.playedMs)}</strong>
                  </div>
                ))
              ) : (
                <p className="muted">所选日期内没有有效播放。</p>
              )}
            </Card>
            <Card className="report-section">
              <h2>播放明细</h2>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>开始时间</th>
                      <th>儿童 / 设备</th>
                      <th>内容</th>
                      <th>播放时长</th>
                      <th>结束情况</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sessions.map((s) => (
                      <tr key={s.id}>
                        <td>{dateTime(s.startedAt)}</td>
                        <td>
                          {s.childName}
                          <small>{s.deviceName}</small>
                        </td>
                        <td>{s.name}</td>
                        <td>{minutes(s.playedMs)}</td>
                        <td>{s.ended ? "正常结束" : "播放中或未正常结束"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted">
                家长预览不计入。断网记录会补传；未能保存的崩溃尾段无法补算。明细最多展示最近
                200 次。
              </p>
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
  const [currentPassword, setCurrentPassword] = useState(""),
    [newPassword, setNewPassword] = useState("");
  const children = useData<Child[]>("/children", [], serial),
    devices = useData<
      { id: string; name: string; revoked: boolean; lastSeen: string }[]
    >("/devices", [], serial);
  const settings = useData<
    | {
        timezone: string;
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
    if (settings.data) setTimezone(settings.data.timezone);
  }, [settings.data]);
  return (
    <>
      <div className="page-title">
        <div>
          <h1>家庭设置</h1>
          <p>儿童档案、电视设备与存储空间。</p>
        </div>
      </div>
      <div className="settings-grid">
        <Card className="settings-card">
          <h2>儿童档案</h2>
          <State error={children.error} />
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
          {!readonly && (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api("/children", "POST", { name: childName });
                  setChildName("");
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
              <Button variant="outline">添加儿童</Button>
            </form>
          )}
        </Card>
        <Card className="settings-card">
          <div className="section-heading">
            <h2>TV 设备</h2>
            {!readonly && (
              <Button variant="outline" onClick={onPair}>
                绑定电视
              </Button>
            )}
          </div>
          <p className="muted">
            扫码或输入电视上的配对码绑定。取消配对后，电视需重新扫码。
          </p>
          <State error={devices.error} />
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
            <p className="empty">还没有绑定电视</p>
          )}
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
                <label>
                  报表时区
                  <Input
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    disabled={readonly}
                  />
                </label>
                {!readonly && <Button variant="outline">保存时区</Button>}
              </form>
              <p className="muted">
                云端文件默认长期保留；保存到电视后重复观看优先读取本地副本。
              </p>
            </>
          )}
        </Card>
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
              <label>
                当前密码
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                />
              </label>
              <label>
                新密码
                <Input
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </label>
              <Button variant="outline">修改密码</Button>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <FeedbackDialogs />
  </>,
);
