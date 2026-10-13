import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEffect, useState } from "react";
import { api, bytes, dateTime, type Resource } from "./api";
import { Pagination, usePagedData } from "./pagination";

type Playback = {
  mediaId: string;
  url: string;
  subtitles: {
    index: number;
    url: string;
    language: string;
    label: string;
    isDefault: boolean;
  }[];
};
export function MediaPreview({ id }: { id: string }) {
  const [source, setSource] = useState<Playback>(),
    [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch(`/api/episodes/${id}/playback`, {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error("文件检查完成后才能预览");
        return r.json();
      })
      .then((data) => {
        if (alive) {
          setSource(data);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [id, refresh]);
  return (
    <>
      {source && (
        <video
          key={refresh}
          src={source.url}
          controls
          autoPlay
          crossOrigin="anonymous"
          className="video-preview"
          onError={() => setError("播放地址可能已过期，请重试播放")}
        >
          {source.subtitles.map((sub) => (
            <track
              key={sub.index}
              kind="subtitles"
              src={sub.url}
              srcLang={sub.language}
              label={sub.label}
              default={sub.isDefault}
            />
          ))}
        </video>
      )}
      {error && (
        <p className="error">
          {error}{" "}
          <Button variant="outline" onClick={() => setRefresh((v) => v + 1)}>
            重试播放
          </Button>
        </p>
      )}
    </>
  );
}

type Download = {
  id: string;
  mediaId: string;
  deviceId: string;
  deviceName: string;
  status: string;
  size: number;
  downloadedBytes: number;
  error: string;
  updatedAt: string;
  desired: string;
  deviceLastSeen: string;
};
const statuses: Record<string, string> = {
  queued: "等待电视连接",
  downloading: "正在下载",
  saved: "已保存到电视",
  failed: "保存失败",
  removed: "已清理",
};
export function TvDownloads({
  item,
  readonly,
}: {
  item: Resource;
  readonly: boolean;
}) {
  const [serial, refresh] = useState(0);
  const devices = usePagedData<{ id: string; name: string; revoked: boolean }>("/devices?activeOnly=true", serial);
  const mediaId = item.files.find((file) => file.kind === "video")?.id;
  const params = new URLSearchParams({ deviceIds: devices.data.map((device) => device.id).join(","), mediaId: mediaId ?? "" });
  const downloads = usePagedData<Download>(`/resources/${item.id}/downloads?${params}`, serial, 100, !!devices.data.length && !!mediaId);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const command = async (deviceId: string, desired: string) => {
    setBusy(true);
    setError("");
    try {
      await api(`/resources/${item.id}/downloads`, "POST", {
        deviceId,
        desired,
      });
      refresh((value) => value + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h3>保存到电视</h3>
      <p className="muted">
        电视连接后自动下载。保存的视频不会被普通缓存清理，云端原文件仍保留。
      </p>
      {devices.data
        .map((d) => {
          const row = downloads.data.find(
            (r) =>
              r.deviceId === d.id &&
              r.mediaId === item.files.find((f) => f.kind === "video")?.id &&
              r.desired === "saved",
          );
          return (
            <div className="settings-row" key={d.id}>
              <span>
                {d.name}
                <small> · {row ? statuses[row.status] : "尚未保存"}</small>
                {row && (
                  <p className="muted">
                    {bytes(row.downloadedBytes)} / {bytes(row.size)} · 最后确认{" "}
                    {dateTime(row.updatedAt)} · 电视最后连接{" "}
                    {dateTime(row.deviceLastSeen)}
                    {row.error && ` · ${row.error}`}
                  </p>
                )}
              </span>
              {!readonly && (
                <>
                  <Button
                    variant="outline"
                    type="button"
                    disabled={busy || downloads.refreshing || !item.ready}
                    onClick={() => void command(d.id, "saved")}
                  >
                    {row?.status === "failed" ? "重试保存" : "保存到电视"}
                  </Button>
                  {row && (
                    <Button
                      variant="outline"
                      type="button"
                      disabled={busy}
                      onClick={() => void command(d.id, "removed")}
                    >
                      清理电视副本
                    </Button>
                  )}
                </>
              )}
            </div>
          );
        })}
      {!devices.loading && !devices.data.length && (
        <p className="muted">先在家庭设置中绑定电视。</p>
      )}
      <Pagination {...devices} loading={devices.refreshing || busy} label="电视保存设备分页" />
      {(error || devices.error || downloads.error) && <p role="alert" className="error">{error || devices.error || downloads.error}</p>}
    </section>
  );
}

export function SubtitleSettings({
  item,
  readonly,
}: {
  item: Resource;
  readonly: boolean;
}) {
  const [files, setFiles] = useState(
    item.files.filter((f) => f.kind === "subtitle"),
  );
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <section>
      <h3>字幕设置</h3>
      {files.map((file) => (
        <fieldset disabled={readonly || busy} key={file.id}>
          <legend>{file.name}</legend>
          <label>
            显示名称
            <Input
              value={file.name}
              maxLength={256}
              onChange={(e) =>
                setFiles(
                  files.map((f) =>
                    f.id === file.id ? { ...f, name: e.target.value } : f,
                  ),
                )
              }
            />
          </label>
          <label>
            语言
            <Input
              value={file.language}
              maxLength={16}
              onChange={(e) =>
                setFiles(
                  files.map((f) =>
                    f.id === file.id ? { ...f, language: e.target.value } : f,
                  ),
                )
              }
            />
          </label>
          <label>
            时间偏移（毫秒，正值延后）
            <Input
              type="number"
              min={-600000}
              max={600000}
              value={file.offsetMs}
              onChange={(e) =>
                setFiles(
                  files.map((f) =>
                    f.id === file.id
                      ? { ...f, offsetMs: Number(e.target.value) }
                      : f,
                  ),
                )
              }
            />
          </label>
          <label className="check-label">
            <Checkbox
              checked={file.isDefault}
              onCheckedChange={(checked) =>
                setFiles(
                  files.map((f) => ({
                    ...f,
                    isDefault:
                      f.id === file.id
                        ? checked === true
                        : checked === true
                          ? false
                          : f.isDefault,
                  })),
                )
              }
            />
            默认字幕
          </label>
          {!readonly && (
            <Button
              variant="outline"
              type="button"
              onClick={() => {
                setBusy(true);
                setError("");
                void api(
                  `/resources/${item.id}/subtitles/${file.id}`,
                  "PATCH",
                  {
                    language: file.language,
                    label: file.name,
                    offsetMs: file.offsetMs,
                    isDefault: file.isDefault,
                  },
                )
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              保存字幕设置
            </Button>
          )}
        </fieldset>
      ))}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
