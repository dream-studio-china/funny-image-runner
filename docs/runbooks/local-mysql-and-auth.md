# Runbook：本地 MySQL 与服务端配置

用于本地开发/测试环境的阿里云 RDS MySQL 或本机 MySQL。生产环境还必须配置可信 TLS，并使用独立账号和强随机凭证。

## 1. 准备数据库

创建一个应用专用数据库和账号，授予该数据库所需的建表、索引和数据读写权限。RDS 需允许当前开发机或 Vercel 部署环境访问；尽量使用访问白名单和 TLS，不要开放到所有来源。

连接 URL 格式：

```text
mysql://<url-encoded-user>:<url-encoded-password>@<host>:3306/<database>
```

用户名或密码含 `@`、`/`、`:`、`#` 等字符时必须进行 URL 编码。数据库和账号由管理员在 MySQL/RDS 控制台创建；迁移命令不会自动创建数据库。

## 2. 配置应用

```bash
cp .env.example .env.local
```

编辑 `.env.local`，填入 `DATABASE_URL`、长随机 `ADMIN_API_TOKEN`、`APP_BASE_URL` 和 `INVITATION_ENCRYPTION_KEY`。管理员 token 可使用下面命令生成，然后把值放入本机 `.env.local` 和部署环境变量中：

```bash
openssl rand -base64 48
```

发码 API 的密文密钥单独生成并安全备份；同一个部署环境稳定使用该 key：

```bash
openssl rand -base64 32
```

生产 `APP_BASE_URL` 必须是最终对外的 HTTPS origin。`INVITATION_TTL_DAYS` 可选，默认 30 天；若配置，可设为 1–365 天。

本地以 `NODE_ENV=development` 运行时数据库 TLS 不强制；production 会校验服务器证书。若 RDS 提供的 CA 不在系统信任链中，将 CA PEM 的 Base64 值放入 `MYSQL_SSL_CA_BASE64`。不要把 `.env.local`、数据库密码、管理员 token 或 CA 私钥提交到 Git。

## 3. 应用 schema migrations

在项目根目录执行：

```bash
npm run db:migrate
```

Drizzle CLI 会读取 `.env.local`。命令成功后会建立用户、邀请码、会话、限流、上传占位、生成任务、输出和审计表。重复运行是安全的；若 schema 后续有变化，先审核新 migration，再执行。

## 4. 检查服务

启动应用：

```bash
npm run dev
```

另一个终端检查数据库连接：

```bash
curl --fail --silent --show-error http://localhost:3000/api/health
```

成功响应：

```json
{"status":"ok","database":"ok"}
```

`503` 的 `database: unavailable` 表示 API 当前不能连库；查看应用服务端日志，并依次确认 URL/凭证、数据库名、账号授权、MySQL/RDS 白名单与 TLS 配置。不要将 `.env.local` 内容或连接串贴到工单/聊天中。

## 5. 当前能力边界

- 已实现邀请码导入、兑换、当前会话查询和退出。
- 已实现 `POST /api/admin/invitations/issue` 自动签发 API；调用前必须在服务端配置 `ADMIN_API_TOKEN`、`INVITATION_ENCRYPTION_KEY` 和 `APP_BASE_URL`；`INVITATION_TTL_DAYS` 可选，详见 [签发邀请码 runbook](./issue-invitation-links.md)。
- 页面允许在没有数据库时浏览演示；这不代表认证或真实生成已经可用。
- 图片上传、七牛访问、任务 API、用户权限下的真实生成，以及 ComfyUI worker 尚未实现。
- 当前没有管理员网页、邀请撤销界面或用户管理界面。遇到已泄露的邀请码，按 [邀请码 runbook](./issue-invitation-links.md#紧急处理邀请码泄露) 处理。
