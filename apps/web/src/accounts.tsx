import { Loading } from "@/components/ui/loading";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, dateTime, type Session } from "./api";

type Preview = { email: string | null; familyName: string | null; expiresAt: string; };
type Activated = { email: string; accountId: string; familyName: string; };

export function InviteActivation({ token, login }: { token: string; login: (email: string) => void; }) {
  const [preview, setPreview] = useState<Preview>();
  const [code, setCode] = useState(token.length < 32 ? token : "");
  const [verifiedCode, setVerifiedCode] = useState("");
  const [email, setEmail] = useState(""), [familyName, setFamilyName] = useState("");
  const [password, setPassword] = useState(""), [confirmation, setConfirmation] = useState("");
  const [result, setResult] = useState<Activated>();
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(token.length >= 32), [error, setError] = useState("");
  useEffect(() => {
    if (token.length < 32) return;
    let alive = true;
    api<Preview>("/auth/invitation/preview", "POST", { token })
      .then((value) => { if (alive) { setPreview(value); setEmail(value.email || ""); setFamilyName(value.familyName || ""); } })
      .catch((failure) => { if (alive) setError(failure.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token]);
  return <main className="pairing-page"><Card className="pairing-card account-card">
    <div className="wordmark">MollyTime</div>
    <h1>{result ? "注册成功" : preview ? "创建账号" : "使用邀请码"}</h1>
    {result ? <>
      <p>你的家庭「{result.familyName}」已创建。邮箱和数字 ID 都可以登录。</p>
      <div className="account-summary"><span>邮箱</span><strong>{result.email}</strong><span>账号 ID</span><strong className="account-number">{result.accountId}</strong></div>
      <p className="muted">请保存账号 ID。登录时仍需输入密码。</p>
      <Button className="primary" onClick={() => login(result.email)}>前往登录</Button>
    </> : loading ? <Loading variant="form" label="正在确认邀请…" /> : preview ? <>
      <p>邀请已确认。填写邮箱并设置密码，创建自己的家庭放映室。</p>
      <form onSubmit={(event) => {
        event.preventDefault(); setError("");
        if (password !== confirmation) { setError("两次输入的密码不一致"); return; }
        setBusy(true);
        const credential = token.length >= 32 ? { token } : { code: verifiedCode };
        void api<Activated>("/auth/invitation/activate", "POST", { ...credential, email, familyName, password })
          .then((value) => { setResult(value); setPassword(""); setConfirmation(""); })
          .catch((failure) => setError(failure.message)).finally(() => setBusy(false));
      }}>
        <fieldset disabled={busy}>
          <Label>邮箱<Input type="email" autoComplete="email" maxLength={254} value={email} readOnly={preview.email !== null} onChange={(e) => setEmail(e.target.value)} required /></Label>
          <Label>家庭名称<Input maxLength={128} value={familyName} readOnly={preview.familyName !== null} onChange={(e) => setFamilyName(e.target.value)} required /></Label>
          <Label>设置密码<Input type="password" autoComplete="new-password" minLength={8} maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} required /></Label>
          <Label>确认密码<Input type="password" autoComplete="new-password" minLength={8} maxLength={72} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} required /></Label>
          <p className="muted">邀请码有效至 {dateTime(preview.expiresAt)}，注册成功后即失效。</p>
          <Button className="primary" type="submit">{busy ? "正在注册…" : "注册账号"}</Button>
          {token.length < 32 && <Button className="account-secondary-action" variant="ghost" type="button" onClick={() => { setPreview(undefined); setPassword(""); setConfirmation(""); setError(""); }}>更换邀请码</Button>}
        </fieldset>
      </form>
    </> : token.length >= 32 ? <p>请联系邀请人获取新的邀请码。</p> : <>
      <p>当前仅通过邀请加入。请输入超管提供的邀请码，通过验证后填写注册资料。</p>
      <form onSubmit={(event) => {
        event.preventDefault(); setBusy(true); setError("");
        void api<Preview>("/auth/invitation/preview", "POST", { code })
          .then((value) => { setPreview(value); setVerifiedCode(code); setEmail(value.email || ""); setFamilyName(value.familyName || ""); })
          .catch((failure) => setError(failure.message)).finally(() => setBusy(false));
      }}><fieldset disabled={busy}>
          <Label>邀请码<Input autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} placeholder="XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required /></Label>
          <Button className="primary" type="submit">{busy ? "正在验证…" : "验证邀请码"}</Button>
        </fieldset></form>
    </>}
    {error && <Alert variant="destructive" className="error" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
    {!result && <Button variant="ghost" className="account-secondary-action" disabled={busy} onClick={() => login("")}>返回登录</Button>}
  </Card></main>;
}

export function BindEmail({ session, bound, logout }: { session: Session; bound: (user: Session["user"]) => void; logout: () => void; }) {
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
        <Label>邮箱<Input type="email" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} required /></Label>
        <Label>当前密码<Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Label>
        <p className="muted">请填写你实际使用的邮箱。绑定后，本版本暂不支持修改邮箱。</p>
        <Button className="primary" type="submit">{busy ? "正在绑定…" : "绑定邮箱并进入后台"}</Button>
      </fieldset></form>
    {error && <Alert variant="destructive" className="error" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
    <Button variant="ghost" className="account-secondary-action" disabled={busy} onClick={logout}>退出账号</Button>
  </Card></main>;
}
