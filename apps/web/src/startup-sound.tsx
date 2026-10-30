import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loading } from "@/components/ui/loading";
import { api } from "./api";

type StartupSoundConfig = { configured: boolean; filename: string; durationMs: number; version: string; audioUrl: string | null };
export function StartupSound({ notify }: { notify: (message: string) => void }) {
  const [config, setConfig] = useState<StartupSoundConfig>();
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    api<StartupSoundConfig>("/operations/startup-sound").then(value => { if (alive.current) setConfig(value); })
      .catch(e => { if (alive.current) setError(e.message); });
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!file) { setPreview(""); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const save = async (remove = false) => {
    if (!remove && !file) return;
    setBusy(true); setError(""); notify("");
    try {
      const value = await api<StartupSoundConfig>(`/operations/startup-sound${remove ? "" : `?filename=${encodeURIComponent(file!.name)}`}`, remove ? "DELETE" : "PUT", remove ? undefined : file);
      if (!alive.current) return;
      setConfig(value); setFile(undefined); if (input.current) input.current.value = "";
      notify(remove ? "启动音效已移除，电视启动时将保持静音。" : "启动音效已保存，下次打开电视 App 时生效。");
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "保存失败，请重试"); }
    finally { if (alive.current) setBusy(false); }
  };
  return <Card className="settings-card operations-card">
    <h2>启动音效</h2>
    <p className="muted">电视 App 启动时，伴随茉莉花 Logo 动画播放一次。未配置时保持静音。</p>
    {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
    {!config && !error ? <Loading variant="form" label="正在加载启动音效…" /> : <>
      <img src={`${import.meta.env.BASE_URL}brand/mollytime-animated.svg`} alt="MollyTime 启动动画" width="144" height="144" />
      <p>{config?.configured ? `当前音效：${config.filename} · ${(config.durationMs / 1000).toFixed(1)} 秒` : "当前未配置启动音效"}</p>
      <form onSubmit={e => { e.preventDefault(); void save(); }}>
        <fieldset disabled={busy}>
          <Label htmlFor="startup-sound-file">选择音频</Label>
          <Input ref={input} id="startup-sound-file" type="file" accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/ogg,.mp3,.wav,.m4a,.ogg" onChange={e => {
            const selected = e.target.files?.[0]; setError("");
            if (selected && selected.size > 5 * 1024 * 1024) { setError("请选择不超过 5 MB 的音频"); e.target.value = ""; setFile(undefined); return; }
            setFile(selected);
          }} />
          <p className="muted">支持 MP3、WAV、M4A 和 OGG，最长 5 秒，最大 5 MB。建议使用 2 秒左右的轻柔音效。</p>
          {(preview || config?.audioUrl) && <div className="my-4"><Label>试听{file ? "所选音频" : "当前音效"}</Label><audio key={preview || config?.audioUrl} controls preload="metadata" src={preview || config?.audioUrl || undefined} /></div>}
          <div className="actions">
            <Button type="submit" disabled={!file || busy}>{busy ? "正在处理…" : "保存启动音效"}</Button>
            {config?.configured && <Button type="button" variant="bordered" disabled={busy} onClick={() => void save(true)}>移除音效</Button>}
          </div>
        </fieldset>
      </form>
    </>}
  </Card>;
}
