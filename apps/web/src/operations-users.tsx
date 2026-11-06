import { useState } from "react";
import { Link } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loading } from "@/components/ui/loading";
import { message } from "@/components/ui/message";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, bytes } from "./api";
import { Pagination, useDebounced, usePagedData } from "./pagination";
import { GIB } from "./storage-format";

type Account = {
  id: string; name: string; accountId: string | null; email: string | null;
  role: string; disabled: boolean; familyId: string; familyName: string;
  storage: { usedBytes: number; reservedBytes: number; limitBytes: number };
};
const roles: Record<string, string> = { superadmin: "平台超管", admin: "家庭管理员", member: "家庭成员" };

export function OperationsUsers() {
  const [search, setSearch] = useState("");
  const query = useDebounced(search);
  const [revision, setRevision] = useState(0);
  const list = usePagedData<Account>(`/operations/users?q=${encodeURIComponent(query)}`, revision);
  const [editing, setEditing] = useState<Account>();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const numeric = Number(amount);
  const valid = amount.trim() !== "" && Number.isSafeInteger(numeric) && numeric >= 0 && Number.isSafeInteger(numeric * GIB);
  const lowerThanUsage = editing && valid && numeric > 0 && numeric * GIB < editing.storage.usedBytes + editing.storage.reservedBytes;
  return <Card className="settings-card">
    <div className="section-heading">
      <div><h2>用户管理</h2><p className="muted">新注册家庭默认 5 GiB。同一家庭的账号共用一份空间额度。</p></div>
      <Button variant="bordered" disabled={list.refreshing} onClick={() => setRevision(v => v + 1)}>刷新列表</Button>
    </div>
    <Label htmlFor="operations-user-search">搜索用户</Label>
    <Input id="operations-user-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="邮箱、账号 ID、用户名或家庭名称" />
    {list.error && <Alert variant="destructive" role="alert"><AlertDescription>{list.error}</AlertDescription></Alert>}
    {list.loading ? <Loading variant="table" label="正在加载用户…" /> : !list.error && !list.data.length ? <Empty>没有匹配的用户。</Empty> : !!list.data.length && <div className="table-scroll">
      <Table><TableHeader><TableRow>
        <TableHead>用户</TableHead><TableHead>所属家庭</TableHead><TableHead>角色</TableHead><TableHead>已用空间</TableHead><TableHead>上传预留</TableHead><TableHead>家庭空间额度</TableHead><TableHead>操作</TableHead>
      </TableRow></TableHeader><TableBody>{list.data.map(account => <TableRow key={account.id}>
        <TableCell><strong>{account.email || account.name}</strong><div className="muted">账号 ID：{account.accountId || "—"}{account.disabled ? " · 已停用" : ""}</div></TableCell>
        <TableCell>{account.familyName}</TableCell><TableCell>{roles[account.role] || account.role}</TableCell>
        <TableCell>{bytes(account.storage.usedBytes)}</TableCell><TableCell>{bytes(account.storage.reservedBytes)}</TableCell>
        <TableCell>{account.storage.limitBytes === 0 ? "不限额" : bytes(account.storage.limitBytes)}</TableCell>
        <TableCell><div className="flex flex-wrap gap-2"><Button variant="bordered" size="sm" aria-label={`配置 ${account.email || account.name} 的家庭空间额度`} onClick={() => {
          setEditing(account); setAmount(String(account.storage.limitBytes / GIB)); setFailure("");
        }}>配置额度</Button><Button variant="bordered" size="sm" asChild><Link to={`/operations/videos?userId=${encodeURIComponent(account.id)}`} aria-label={`查看 ${account.email || account.name} 的家庭视频`}>查看视频</Link></Button></div></TableCell>
      </TableRow>)}</TableBody></Table>
    </div>}
    <Pagination {...list} label="用户列表分页" loading={list.refreshing} />
    <Dialog open={!!editing} onOpenChange={open => { if (!open && !busy) setEditing(undefined); }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader><DialogTitle>配置家庭空间额度</DialogTitle><DialogDescription>{editing?.email || editing?.name} · {editing?.familyName}。修改对该家庭的所有账号生效。</DialogDescription></DialogHeader>
        <form onSubmit={event => {
          event.preventDefault();
          if (!editing || busy || !valid) return;
          setBusy(true); setFailure("");
          void api(`/operations/users/${encodeURIComponent(editing.id)}/storage`, "PUT", {
            limitBytes: numeric * GIB, expectedLimitBytes: editing.storage.limitBytes,
          }).then(() => {
            setEditing(undefined); setRevision(v => v + 1); message.success("家庭空间额度已保存");
          }).catch(error => setFailure(error.message)).finally(() => setBusy(false));
        }}>
          <DialogBody>
            <Label htmlFor="family-storage-limit">家庭空间额度（GiB）</Label>
            <Input id="family-storage-limit" type="number" min="0" max="8388607" step="1" required disabled={busy} value={amount}
              onChange={e => { setAmount(e.target.value); setFailure(""); }}
              aria-describedby="family-storage-hint" aria-invalid={amount !== "" && !valid} />
            <p id="family-storage-hint" className="muted">填写整数，0 表示不限额。1 GiB = 1024 MiB = 1,073,741,824 字节。已有文件不会因额度调低而删除。</p>
            {lowerThanUsage && <p role="status">新额度低于已用空间与上传预留之和，保存后将限制新增上传，直到释放空间或提高额度。</p>}
            {failure && <Alert variant="destructive" role="alert"><AlertDescription>{failure}</AlertDescription></Alert>}
          </DialogBody>
          <DialogFooter><Button type="button" variant="bordered" disabled={busy} onClick={() => setEditing(undefined)}>取消</Button><Button type="submit" disabled={busy || !valid}>{busy ? "正在保存…" : "保存额度"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </Card>;
}
