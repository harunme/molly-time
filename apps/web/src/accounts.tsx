import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, dateTime, type Session } from "./api";

type Preview = { email: string; familyName: string; expiresAt: string };
type Activated = { email: string; accountId: string; familyName: string };

export function InviteActivation({ token, login }: { token: string; login: (email: string) => void }) {
  const [preview, setPreview] = useState<Preview>();
  const [password, setPassword] = useState(""), [confirmation, setConfirmation] = useState("");
  const [result, setResult] = useState<Activated>();
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api<Preview>("/auth/invitation/preview", "POST", { token })
      .then((value) => { if (alive) setPreview(value); })
      .catch((failure) => { if (alive) setError(failure.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token]);
  return <main className="pairing-page"><Card className="pairing-card account-card">
    <div className="wordmark">MollyTime</div>
    <h1>{result ? "账号已激活" : "加入家庭放映室"}</h1>
    {result ? <>
      <p>你的家庭「{result.familyName}」已创建。邮箱和数字 ID 都可以登录。</p>
      <div className="account-summary"><span>邮箱</span><strong>{result.email}</strong><span>账号 ID</span><strong className="account-number">{result.accountId}</strong></div>
      <p className="muted">请保存账号 ID。登录时仍需输入密码。</p>
      <Button className="primary" onClick={() => login(result.email)}>前往登录</Button>
    </> : loading ? <p role="status">正在确认邀请…</p> : preview ? <>
      <p>你收到了一份专属邀请。设置密码后，即可开始管理自己的家庭。</p>
      <form onSubmit={(event) => {
        event.preventDefault(); setError("");
        if (password !== confirmation) { setError("两次输入的密码不一致"); return; }
        setBusy(true);
        void api<Activated>("/auth/invitation/activate", "POST", { token, password })
          .then((value) => { setResult(value); setPassword(""); setConfirmation(""); })
          .catch((failure) => setError(failure.message)).finally(() => setBusy(false));
      }}>
        <fieldset disabled={busy}>
          <label>受邀邮箱<Input type="email" value={preview.email} readOnly /></label>
          <label>家庭名称<Input value={preview.familyName} readOnly /></label>
          <label>设置密码<Input type="password" autoComplete="new-password" minLength={8} maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <label>确认密码<Input type="password" autoComplete="new-password" minLength={8} maxLength={72} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} required /></label>
          <p className="muted">邀请有效至 {dateTime(preview.expiresAt)}。仅限上述邮箱使用。</p>
          <Button className="primary" type="submit">{busy ? "正在激活…" : "激活账号"}</Button>
        </fieldset>
      </form>
    </> : <p>请联系邀请人重新生成邀请链接。</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {!result && <Button variant="ghost" disabled={busy} onClick={() => login("")}>返回登录</Button>}
  </Card></main>;
}

export function BindEmail({ session, bound, logout }: { session: Session; bound: (user: Session["user"]) => void; logout: () => void }) {
  const [email, setEmail] = useState(""), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <main className="pairing-page"><Card className="pairing-card account-card">
    <div className="wordmark">MollyTime</div><h1>为账号绑定邮箱</h1>
    <p>账号已升级为邮箱登录。绑定后可使用邮箱或数字 ID 登录，原有密码和家庭数据保留。</p>
    <div className="account-summary"><span>账号 ID</span><strong className="account-number">{session.user.accountId}</strong></div>
    <form onSubmit={(event) => {
      event.preventDefault(); setBusy(true); setError("");
      void api<Session["user"]>("/account/email", "PATCH", { email, currentPassword: password })
        .then(bound).catch((failure) => setError(failure.message)).finally(() => setBusy(false));
    }}><fieldset disabled={busy}>
      <label>邮箱<Input type="email" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      <label>当前密码<Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      <p className="muted">请填写你实际使用的邮箱。绑定后，本版本暂不支持修改邮箱。</p>
      <Button className="primary" type="submit">{busy ? "正在绑定…" : "绑定邮箱并进入后台"}</Button>
    </fieldset></form>
    {error && <p className="error" role="alert">{error}</p>}
    <Button variant="ghost" className="account-secondary-action" disabled={busy} onClick={logout}>退出账号</Button>
  </Card></main>;
}
