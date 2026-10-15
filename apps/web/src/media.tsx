import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { SelectField } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEffect, useState } from "react";
import { api, type Resource } from "./api";

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
export function MediaPreview({ id }: { id: string; }) {
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
          onError={(event) => {
            const code = event.currentTarget.error?.code;
            setError(code === 3 || code === 4
              ? "浏览器无法解码或不支持此视频，请在电视客户端尝试播放"
              : "播放地址可能已过期或网络异常，请重试播放");
          }}
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
          <Button variant="bordered" onClick={() => setRefresh((v) => v + 1)}>
            重试播放
          </Button>
        </p>
      )}
    </>
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
      <h3>字幕资源</h3>
      {files.map((file) => (
        <fieldset disabled={readonly || busy} key={file.id}>
          <legend>{file.name}</legend>
          <Label>
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
          </Label>
          <Label>
            字幕类型
            <SelectField
              aria-label="字幕类型"
              value={file.language}
              onValueChange={(value) =>
                setFiles(
                  files.map((f) =>
                    f.id === file.id ? { ...f, language: value } : f,
                  ),
                )
              }
              options={[({ value: "und", label: <> 未指定 </> }), ({ value: "zh", label: <> 中文 </> }), ({ value: "en", label: <> 英文 </> }), ({ value: "zh-en", label: <> 中英文 </> }), !["und", "zh", "en", "zh-en"].includes(file.language) && ({ value: file.language, label: <> {file.language} </> })]} />
          </Label>
          <Label>
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
          </Label>
          {!readonly && (
            <Button
              variant="bordered"
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
                  },
                )
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              保存字幕信息
            </Button>
          )}
        </fieldset>
      ))}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
