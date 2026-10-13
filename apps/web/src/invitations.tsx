import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty } from "@/components/ui/empty";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api, dateTime, type Page } from "./api";
import { message } from "@/components/ui/message";
import { confirmAction } from "./feedback";
import { Pagination } from "./pagination";

type Invitation = { id: string; code: string | null; email: string | null; familyName: string | null; status: string; expiresAt: string; createdAt: string; };
const status: Record<string, string> = { pending: "待注册", accepted: "已注册", revoked: "已撤销", expired: "已过期" };

export function Invitations() {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [page, setPage] = useState(1), [serial, setSerial] = useState(0);
  const [data, setData] = useState<Page<Invitation>>(), [loading, setLoading] = useState(true);
  const copyCode = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      message.success("邀请码已复制");
    } catch {
      message.error("请选中邀请码并手动复制");
    }
  };
  useEffect(() => {
    let alive = true; setLoading(true);
    api<Page<Invitation>>(`/operations/invitations?page=${page}&pageSize=20`)
      .then((value) => { if (alive) setData(value); })
      .catch((failure) => { if (alive) setError(failure.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [page, serial]);
  return <Card className="settings-card invitations-card">
    <h2>邀请码</h2><p>生成邀请码并交给受邀者。对方自行填写邮箱和家庭名称，注册后拥有独立家庭。</p>
    <form onSubmit={(event) => {
      event.preventDefault(); setBusy(true); setError(""); setCode("");
      void api<Invitation & { code: string; }>("/operations/invitations", "POST", {})
        .then((value) => { setCode(value.code); setPage(1); setSerial((s) => s + 1); })
        .catch((failure) => setError(failure.message)).finally(() => setBusy(false));
    }}><fieldset disabled={busy}>
        <p className="muted">一码一人，七天有效，可随时撤销。</p>
        <Button type="submit" className="primary invitation-generate">{busy ? "正在生成…" : "生成邀请码"}</Button>
      </fieldset></form>
    {code && <div className="invitation-code" role="status">
      <strong className="account-number">{code}</strong>
      <Button variant="bordered" className="invitation-copy-action" onClick={() => { void copyCode(code); }}>复制邀请码</Button>
      <p className="muted">邀请码已保存，可随时从邀请记录查看和复制。对方在登录页选择“使用邀请码”。</p>
    </div>}
    {error && <Alert variant="destructive" className="error" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
    <h3>邀请记录</h3>
    {loading ? <p role="status">正在加载邀请记录…</p> : !data?.items.length ? <Empty className="empty">还没有邀请，生成邀请码邀请第一位用户。</Empty> : <>
      <div className="table-scroll"><Table className="invitations-table"><TableHeader><TableRow><TableHead>邀请码</TableHead><TableHead>创建时间</TableHead><TableHead>注册邮箱</TableHead><TableHead>家庭</TableHead><TableHead>状态</TableHead><TableHead>有效至</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
        {data.items.map((row) => <TableRow key={row.id}><TableCell><span className="invitation-table-code">{row.code || "不可查看"}</span>{!row.code && <small>请生成新邀请码</small>}</TableCell><TableCell>{dateTime(row.createdAt)}</TableCell><TableCell>{row.email || "尚未注册"}</TableCell><TableCell>{row.familyName || "—"}</TableCell><TableCell>{status[row.status]}</TableCell><TableCell>{dateTime(row.expiresAt)}</TableCell><TableCell><div className="invitation-row-actions">{row.code && <Button variant="ghost" className="invitation-copy-action" onClick={() => {
          void copyCode(row.code!);
        }}>复制邀请码</Button>}{row.status === "pending" && <Button variant="ghost" disabled={busy} onClick={() => {
          void (async () => {
            if (!await confirmAction({
              title: "撤销邀请码？",
              description: "撤销后，这个邀请码将立即失效。",
              confirmText: "撤销邀请",
              detail: row.code ? { label: "邀请码", value: row.code } : { label: "创建时间", value: dateTime(row.createdAt) },
            })) return;
            setBusy(true); setError("");
            try { await api(`/operations/invitations/${row.id}/revoke`, "POST"); setCode(""); setSerial((s) => s + 1); }
            catch (failure) { setError(failure instanceof Error ? failure.message : "撤销失败"); }
            finally { setBusy(false); }
          })();
        }}>撤销邀请</Button>}</div></TableCell></TableRow>)}
      </TableBody></Table></div>
      <Pagination page={page} pageSize={data.pageSize} total={data.total} loading={busy} setPage={setPage} label="邀请记录分页" />
    </>}
  </Card>;
}
