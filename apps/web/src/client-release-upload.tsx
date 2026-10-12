import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { api, bytes, uploadApi } from "./api";

type Options = { canUpload: boolean; ossConfigured: boolean; maxSize: number };
export function ClientReleaseUpload({ published }: { published: () => void }) {
  const [options, setOptions] = useState<Options>();
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [file, setFile] = useState<File>();
  const [storage, setStorage] = useState("local");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    api<Options>("/operations/client-releases/upload-options")
      .then((value) => { if (alive.current) setOptions(value); })
      .catch((failure) => { if (alive.current) setError(failure instanceof Error ? failure.message : "上传配置加载失败，请刷新页面"); })
      .finally(() => { if (alive.current) setOptionsLoading(false); });
    return () => { alive.current = false; request.current?.abort(); };
  }, []);

  const submit = async () => {
    if (!file || !options?.canUpload || request.current) return;
    setError(""); setSuccess("");
    if (!/\.apk$/i.test(file.name) || file.size <= 0 || file.size > options.maxSize) {
      setError(`请选择完整的 APK 文件，最大 ${bytes(options.maxSize)}`); return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setPercent(0);
    let ticketId: string | undefined;
    try {
      const ticket = await api<{ id: string }>("/operations/client-releases/uploads", "POST", { filename: file.name, size: file.size, storage, notes });
      ticketId = ticket.id;
      if (!alive.current || controller.signal.aborted) {
        await api(`/operations/client-releases/uploads/${ticket.id}`, "DELETE").catch(() => {});
        if (alive.current) setError("上传已取消");
        return;
      }
      const result = await uploadApi<{ release: { versionName: string; packageName: string } }>(
        `/operations/client-releases/uploads/${ticket.id}`, file,
        (value) => { if (alive.current) setPercent(value); }, controller.signal,
      );
      if (!alive.current) return;
      const channel = result.release.packageName.endsWith(".debug") ? "Debug 测试版" : "正式版";
      setSuccess(`${channel} ${result.release.versionName} 已发布，电视下次检查更新时可获取。`);
      setFile(undefined); setNotes("");
      if (input.current) input.current.value = "";
      published();
    } catch (failure) {
      if (controller.signal.aborted && ticketId) await api(`/operations/client-releases/uploads/${ticketId}`, "DELETE").catch(() => {});
      if (alive.current) setError(failure instanceof Error ? failure.message : "安装包上传失败，请重试");
    } finally {
      request.current = undefined;
      if (alive.current) setBusy(false);
    }
  };

  return <details className="client-release-upload">
    <summary>上传 APK</summary>
    <p className="muted">选择已签名的安装包。验证通过后会设为对应渠道的当前发布版本。</p>
    {optionsLoading && <p role="status">正在加载上传配置…</p>}
    {options && !options.canUpload && <p className="error">服务端尚未配置 APK 校验工具，请联系服务器维护者配置后上传。</p>}
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={busy || !options?.canUpload}>
        <div className="form-grid">
          <label>APK 安装包<Input ref={input} type="file" accept=".apk,application/vnd.android.package-archive" required onChange={(event) => { setFile(event.target.files?.[0]); setError(""); setSuccess(""); }} /></label>
          <label>安装包存储<NativeSelect aria-label="安装包存储" value={storage} onChange={(event) => setStorage(event.target.value)}>
            <option value="local">服务器</option><option value="oss" disabled={!options?.ossConfigured}>私有 OSS{!options?.ossConfigured ? "（尚未配置）" : ""}</option>
          </NativeSelect></label>
        </div>
        {file && <p className="muted">{file.name} · {bytes(file.size)}</p>}
        <label>更新说明<Textarea value={notes} maxLength={4000} rows={3} placeholder="说明这次更新的内容" onChange={(event) => setNotes(event.target.value)} /></label>
        <Button type="submit" disabled={!file || !options?.canUpload}>上传并发布</Button>
      </fieldset>
    </form>
    {busy && <div className="client-release-upload-progress"><Progress aria-label="APK 上传进度" value={percent} /><p role="status">{percent < 100 ? `正在上传 ${percent}%` : "正在验证并发布安装包…"}</p><Button variant="outline" disabled={percent >= 100} onClick={() => request.current?.abort()}>取消上传</Button></div>}
    {error && <p role="alert" className="error">{error}</p>}
    {success && <p role="status">{success}</p>}
  </details>;
}
