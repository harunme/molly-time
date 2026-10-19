import { Loading } from "@/components/ui/loading";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty } from "@/components/ui/empty";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select";
import { api, bytes } from "./api";
import { Pagination } from "./pagination";

type Release = {
  packageName: "com.molly.tv" | "com.molly.tv.debug";
  versionCode: number;
  versionName: string;
  minSdk: number;
  size: number;
  sha256: string;
  notes: string;
  storage: "local" | "oss";
  key: string;
  publishedAt: string | null;
  isCurrent: boolean;
  canDownload: boolean;
};
type Inventory = { items: Release[]; total: number; invalidRecords: number; };
const pageSize = 20;

export function ClientReleases() {
  const [channel, setChannel] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Inventory>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState("");
  const downloadActive = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true); setError(""); setData(undefined);
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (channel) query.set("packageName", channel);
    api<Inventory>(`/operations/client-releases?${query}`, "GET", undefined, undefined, controller.signal)
      .then((value) => { if (active) setData(value); })
      .catch((failure) => { if (active) setError(failure instanceof Error ? failure.message : "安装包列表加载失败，请重试"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [channel, page]);

  const download = async (release: Release) => {
    if (downloadActive.current) return;
    downloadActive.current = true;
    setDownloading(release.sha256); setError("");
    try {
      const { url } = await api<{ url: string; }>(`/operations/client-releases/${release.packageName}/${release.versionCode}/${release.sha256}/download-url`);
      if (!alive.current) return;
      const target = new URL(url, location.origin);
      if (target.protocol !== "https:" && target.origin !== location.origin) throw new Error("安装包下载地址无效");
      const link = document.createElement("a");
      link.href = target.href;
      link.download = `mollytime-tv${release.packageName.endsWith(".debug") ? "-debug" : ""}-${release.versionName}.apk`;
      link.rel = "noopener";
      document.body.appendChild(link); link.click(); link.remove();
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "安装包下载失败，请重试");
    } finally {
      downloadActive.current = false;
      if (alive.current) setDownloading("");
    }
  };

  return <Card className="settings-card client-releases-card">
    <h2>客户端版本</h2>
    <div className="client-releases-toolbar">
      <SelectField className="w-48" aria-label="发布渠道" value={channel} onValueChange={(value) => { setChannel(value); setPage(1); }} options={[({ value: "", label: <> 全部渠道 </> }), ({ value: "com.molly.tv", label: <> 正式版 </> }), ({ value: "com.molly.tv.debug", label: <> Debug 测试版 </> })]} />
      {data && <span className="muted">共 {data.total} 个安装包</span>}
    </div>
    {error && <Alert variant="destructive" role="alert" className="error"><AlertDescription>{error}</AlertDescription></Alert>}
    {!!data?.invalidRecords && <Alert variant="destructive" role="alert" className="error"><AlertDescription>{data.invalidRecords} 条版本记录无法读取，请恢复版本记录备份后重新进入此页。</AlertDescription></Alert>}
    {loading ? <Loading variant="table" label="正在加载安装包…" /> : data && !data.items.length ?
      <Empty className="empty">{data.total ? "本页没有安装包，请返回上一页。" : "暂无安装包。发布客户端版本后，安装包会显示在这里。"}</Empty> : data &&
      <div className="table-scroll"><Table className="client-releases-table"><TableHeader><TableRow>
        <TableHead scope="col">版本</TableHead><TableHead scope="col">渠道</TableHead><TableHead scope="col">发布状态</TableHead><TableHead scope="col">发布时间</TableHead><TableHead scope="col">大小</TableHead><TableHead scope="col">存储位置</TableHead><TableHead scope="col">操作</TableHead>
      </TableRow></TableHeader><TableBody>{data.items.map((release) => <TableRow className="hover:bg-transparent" key={`${release.packageName}-${release.versionCode}-${release.sha256}`}>
        <TableCell><div className="client-release-inline"><strong>{release.versionName}</strong><small className="muted">构建号 {release.versionCode}</small></div></TableCell>
        <TableCell>{release.packageName === "com.molly.tv" ? "正式版" : "Debug 测试版"}</TableCell>
        <TableCell><div className="client-release-inline"><Badge variant={release.isCurrent ? "default" : "secondary"}>{release.isCurrent ? "当前发布" : "历史版本"}</Badge>
          {!release.canDownload && <small className="error">文件缺失</small>}</div></TableCell>
        <TableCell>{release.publishedAt ? new Date(release.publishedAt).toLocaleString("zh-CN", { hour12: false }) : "未记录"}</TableCell>
        <TableCell>{bytes(release.size)}</TableCell><TableCell>{release.storage === "local" ? "服务器" : "私有 OSS"}</TableCell>
        <TableCell><div className="flex items-center gap-2">
          <Button variant="bordered" disabled={!release.canDownload || !!downloading} aria-label={`下载 ${release.packageName === "com.molly.tv" ? "正式版" : "Debug"} ${release.versionName}`} onClick={() => { void download(release); }}>{downloading === release.sha256 ? "准备下载…" : "下载 APK"}</Button>
          <Dialog>
            <DialogTrigger asChild><Button variant="bordered">更新说明与校验信息</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>更新说明与校验信息</DialogTitle>
                <DialogDescription>{release.packageName === "com.molly.tv" ? "正式版" : "Debug 测试版"} {release.versionName} · 构建号 {release.versionCode}</DialogDescription>
              </DialogHeader>
              <DialogBody className="client-release-details min-w-0">
                <p>{release.notes || "未填写更新说明"}</p>
                <dl>
                  <dt>包名</dt><dd>{release.packageName}</dd><dt>最低系统 API</dt><dd>{release.minSdk}</dd>
                  <dt>SHA-256</dt><dd><code>{release.sha256}</code></dd><dt>文件路径</dt><dd><code>{release.key}</code></dd>
                </dl>
              </DialogBody>
              <DialogFooter><DialogClose asChild><Button variant="bordered">关闭</Button></DialogClose></DialogFooter>
            </DialogContent>
          </Dialog>
        </div></TableCell>
      </TableRow>)}</TableBody></Table></div>}
    {data && data.total > pageSize && <Pagination page={page} pageSize={pageSize} total={data.total} loading={loading} setPage={setPage} label="客户端版本分页" />}
  </Card>;
}
