import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClientReleases } from "./client-releases";
import { Invitations } from "./invitations";
import { OperationsUsage } from "./usage";
import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { api } from "./api";

type StorageConfig = {
  revision: number;
  storage_backend: "local" | "oss";
  oss_endpoint: string;
  oss_bucket: string;
  oss_internal_endpoint: string;
  oss_upload_ttl: number;
  oss_signed_url_ttl: number;
  credentialsConfigured: boolean;
};
type Form = StorageConfig & {
  oss_access_key_id: string;
  oss_access_key_secret: string;
};
export function Operations({ notify }: { notify: (message: string) => void }) {
  const tab = useParams()["*"] || "";
  const navigate = useNavigate();
  const validTab = ["storage", "client-releases", "invitations", "usage"].includes(tab);
  const [form, setForm] = useState<Form>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = (value: StorageConfig) =>
    setForm({ ...value, oss_access_key_id: "", oss_access_key_secret: "" });
  useEffect(() => {
    if (tab !== "storage") return;
    let alive = true;
    setError("");
    api<StorageConfig>("/operations/storage")
      .then((value) => {
        if (alive) load(value);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [tab]);
  const submit = async (test: boolean) => {
    if (!form) return;
    setBusy(true);
    setError("");
    notify("");
    const { credentialsConfigured: _configured, ...body } = form;
    try {
      if (test) {
        const result = await api<{ message: string }>(
          "/operations/storage/test",
          "POST",
          body,
        );
        notify(result.message);
      } else {
        load(await api<StorageConfig>("/operations/storage", "PUT", body));
        notify(
          "存储配置已保存并生效。切换 Bucket 或地域后，请重新进入客户端版本页再上传。",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };
  if (!validTab) return <Navigate to="/operations/storage" replace />;
  return (
    <>
      <div className="page-title">
        <div>
          <h1>运营设置</h1>
          <p>管理家庭用量、用户邀请、平台存储和电视客户端版本，仅平台超管可访问。</p>
        </div>
      </div>
      <Tabs className="operations-tabs" value={tab} activationMode="manual" onValueChange={(value) => navigate(`/operations/${value}`)}>
        <TabsList variant="line" aria-label="运营设置分类">
          <TabsTrigger value="storage">文件存储</TabsTrigger>
          <TabsTrigger value="client-releases">客户端版本</TabsTrigger>
          <TabsTrigger value="invitations">用户邀请</TabsTrigger>
          <TabsTrigger value="usage">家庭用量</TabsTrigger>
        </TabsList>
        <TabsContent value="storage">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!form ? (
        <p className="empty">正在加载存储配置…</p>
      ) : (
        <Card className="settings-card operations-card">
          <h2>文件存储</h2>
          <p className="muted">
            已有文件继续使用原存储。已有云端资源时，切换 Bucket
            或地域需要先迁移资源。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit(false);
            }}
          >
            <fieldset disabled={busy}>
              <label>
                存储方式
                <NativeSelect
                  value={form.storage_backend}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      storage_backend: e.target.value as "local" | "oss",
                    })
                  }
                >
                  <option value="local">服务器本地磁盘</option>
                  <option value="oss">阿里云 OSS</option>
                </NativeSelect>
              </label>
              <div className="form-grid">
                <label>
                  OSS Endpoint
                  <Input
                    placeholder="https://oss-cn-hangzhou.aliyuncs.com"
                    value={form.oss_endpoint}
                    onChange={(e) =>
                      setForm({ ...form, oss_endpoint: e.target.value })
                    }
                    required={form.storage_backend === "oss"}
                  />
                </label>
                <label>
                  Bucket
                  <Input
                    placeholder="私有 Bucket 名称"
                    value={form.oss_bucket}
                    onChange={(e) =>
                      setForm({ ...form, oss_bucket: e.target.value })
                    }
                    required={form.storage_backend === "oss"}
                  />
                </label>
                <label>
                  AccessKey ID
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={form.oss_access_key_id}
                    placeholder={
                      form.credentialsConfigured
                        ? "已保存；留空保留原值"
                        : "输入 AccessKey ID"
                    }
                    onChange={(e) =>
                      setForm({ ...form, oss_access_key_id: e.target.value })
                    }
                    required={
                      form.storage_backend === "oss" &&
                      !form.credentialsConfigured
                    }
                  />
                </label>
                <label>
                  AccessKey Secret
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={form.oss_access_key_secret}
                    placeholder={
                      form.credentialsConfigured
                        ? "已保存；留空保留原值"
                        : "输入 AccessKey Secret"
                    }
                    onChange={(e) =>
                      setForm({
                        ...form,
                        oss_access_key_secret: e.target.value,
                      })
                    }
                    required={
                      form.storage_backend === "oss" &&
                      !form.credentialsConfigured
                    }
                  />
                </label>
              </div>
              <p className="muted">
                {form.credentialsConfigured
                  ? "访问密钥已配置。"
                  : "尚未配置访问密钥。"}{" "}
                密钥加密保存，不会回显。
              </p>
              <label>
                内网 Endpoint（可选）
                <Input
                  placeholder="仅同地域阿里云服务器使用，本机开发留空"
                  value={form.oss_internal_endpoint}
                  onChange={(e) =>
                    setForm({ ...form, oss_internal_endpoint: e.target.value })
                  }
                />
              </label>
              <div className="form-grid">
                <label>
                  上传签名有效期（秒）
                  <Input
                    type="number"
                    min={60}
                    max={3600}
                    value={form.oss_upload_ttl}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        oss_upload_ttl: Number(e.target.value),
                      })
                    }
                    required
                  />
                </label>
                <label>
                  播放签名有效期（秒）
                  <Input
                    type="number"
                    min={60}
                    max={14400}
                    value={form.oss_signed_url_ttl}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        oss_signed_url_ttl: Number(e.target.value),
                      })
                    }
                    required
                  />
                </label>
              </div>
              <p className="muted">
                Bucket 需设为私有，并允许管理网页和 TV 网页来源的 CORS
                请求。服务端测试会创建、读取并删除一个临时对象。
              </p>
              <div className="actions">
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => {
                    void submit(true);
                  }}
                >
                  {busy ? "正在处理…" : "测试 OSS 连接"}
                </Button>
                <Button variant="default" className="primary" type="submit">
                  保存存储配置
                </Button>
              </div>
            </fieldset>
          </form>
        </Card>
      )}
        </TabsContent>
        <TabsContent value="client-releases"><ClientReleases /></TabsContent>
        <TabsContent value="invitations"><Invitations /></TabsContent>
        <TabsContent value="usage"><OperationsUsage /></TabsContent>
      </Tabs>
    </>
  );
}
