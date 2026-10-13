import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, dateTime, type Page } from "./api";
import { confirmAction } from "./feedback";

type Invitation = { id: string; email: string; familyName: string; status: string; expiresAt: string; createdAt: string };
const status: Record<string, string> = { pending: "待激活", accepted: "已激活", revoked: "已撤销", expired: "已过期" };

export function Invitations() {
  const [email, setEmail] = useState(""), [familyName, setFamilyName] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [link, setLink] = useState(""), [copied, setCopied] = useState(false);
  const [page, setPage] = useState(1), [serial, setSerial] = useState(0);
  const [data, setData] = useState<Page<Invitation>>(), [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true; setLoading(true);
    api<Page<Invitation>>(`/operations/invitations?page=${page}&pageSize=20`)
      .then((value) => { if (alive) setData(value); })
      .catch((failure) => { if (alive) setError(failure.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [page, serial]);
  return <Card className="settings-card invitations-card">
    <h2>邀请用户</h2><p>仅通过邀请加入。每位受邀用户激活后拥有独立家庭，默认成为该家庭的管理员。</p>
    <form onSubmit={(event) => {
      event.preventDefault(); setBusy(true); setError(""); setLink(""); setCopied(false);
      void api<Invitation & { activationUrl: string }>("/operations/invitations", "POST", { email, familyName })
        .then((value) => { setLink(value.activationUrl); setEmail(""); setFamilyName(""); setPage(1); setSerial((s) => s + 1); })
        .catch((failure) => setError(failure.message)).finally(() => setBusy(false));
    }}><fieldset disabled={busy}><div className="form-grid">
      <label>受邀邮箱<Input type="email" autoComplete="off" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      <label>家庭名称<Input maxLength={128} value={familyName} onChange={(e) => setFamilyName(e.target.value)} required /></label>
    </div><p className="muted">邀请七天有效，只能使用一次。向同一邮箱重新邀请会使旧链接失效。</p>
      <Button type="submit" className="primary">{busy ? "正在生成…" : "生成邀请链接"}</Button>
    </fieldset></form>
    {link && <div className="invitation-link" role="status">
      <label>邀请链接<Input value={link} readOnly onFocus={(e) => e.target.select()} /></label>
      <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(() => setError("请选中邀请链接并手动复制")); }}>{copied ? "已复制" : "复制链接"}</Button>
      <p className="muted">链接仅展示这一次，请发送给受邀邮箱的使用者。</p>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
    <h3>邀请记录</h3>
    {loading ? <p role="status">正在加载邀请记录…</p> : !data?.items.length ? <p className="empty">还没有邀请。填写邮箱，邀请第一位用户。</p> : <>
      <div className="table-scroll"><table><thead><tr><th>邮箱</th><th>家庭</th><th>状态</th><th>有效至</th><th>操作</th></tr></thead><tbody>
        {data.items.map((row) => <tr key={row.id}><td>{row.email}</td><td>{row.familyName}</td><td>{status[row.status]}</td><td>{dateTime(row.expiresAt)}</td><td>{row.status === "pending" && <Button variant="ghost" disabled={busy} onClick={() => {
          void (async () => {
            if (!await confirmAction(`撤销给 ${row.email} 的邀请？链接将立即失效。`)) return;
            setBusy(true); setError("");
            try { await api(`/operations/invitations/${row.id}/revoke`, "POST"); setLink(""); setSerial((s) => s + 1); }
            catch (failure) { setError(failure instanceof Error ? failure.message : "撤销失败"); }
            finally { setBusy(false); }
          })();
        }}>撤销邀请</Button>}</td></tr>)}
      </tbody></table></div>
      <div className="actions invitation-pagination"><span>共 {data.total} 条邀请</span><Button variant="outline" disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>上一页</Button><Button variant="outline" disabled={busy || page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>下一页</Button></div>
    </>}
  </Card>;
}
