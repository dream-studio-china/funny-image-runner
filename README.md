# 咔嚓造梦局

移动端优先的图像生成应用。当前包含响应式演示 UI、MySQL 数据层、可重复登录的邀请码与自动签发 API、七牛浏览器直传和队列任务 API。匿名访客体验预制样图；登录用户可将图片上传至七牛并创建真实队列任务。原图大小不设前端限制；超过 200 万像素时会在浏览器缩放并转为 JPEG，处理后的文件不超过 20 MiB。ComfyUI worker 尚未连接，因此排队任务目前不会生成结果。

```bash
npm install
npm run dev
```

访问 http://localhost:3000。构建与静态检查：`npm run build`、`npm run lint`、`npm run typecheck`。

## 阿里云 RDS MySQL

1. 创建 MySQL 数据库和仅供应用使用的账号，设置可访问来源并启用 TLS。不要将 RDS 密码提交到仓库。
2. 将 `.env.example` 复制到 `.env.local`，设置 MySQL、邀请码服务端变量及七牛 Kodo 的 `QINIU_ACCESS_KEY`、`QINIU_SECRET_KEY`、`QINIU_BUCKET`、`QINIU_UPLOAD_URL`、`QINIU_PRIVATE_DOMAIN`；AK/SK 仅配置在服务端。详细操作见 [七牛上传与任务 API runbook](docs/runbooks/qiniu-storage-and-jobs.md)。若 RDS 使用自定义 CA，设置 base64 编码的 `MYSQL_SSL_CA_BASE64`。TLS 在 production 强制校验服务端证书。`INVITATION_ENCRYPTION_KEY` 用 `openssl rand -base64 32` 生成并备份；同一环境不可随意更换，否则自动发货重试无法还原已签发链接。
3. 应用 SQL schema：`npm run db:migrate`。这个命令只应在配置了可访问的 `DATABASE_URL` 后运行。
4. 用管理员 seed 创建并导入邀请码（seed 只放在可信的管理员终端，不放入 `.env.local`、Vercel 或 Git）：

```bash
INVITE_SEED="<至少 32 字节随机值的 base64 或 hex>" \
APP_BASE_URL="http://localhost:3000" \
ADMIN_API_TOKEN="<与服务端配置相同的管理员 token>" \
npm run invitations:create -- spring-2026 user_001 1 1
```

该命令为给定用户生成 `count` 个可重复登录的邀请链接，将 code 与摘要通过 HTTPS 写入 `POST /api/admin/invitations/import`；服务端校验摘要后使用 `INVITATION_ENCRYPTION_KEY` 加密保存，只有导入成功才输出链接。通过 `openssl rand -base64 32` 生成 seed 和加密密钥，通过 `openssl rand -base64 48` 生成管理员 token。CLI 导入的链接默认不过期，可在 `/admin` 撤销；后台用户管理可查看/复制新版导入的链接。

淘宝自动发货服务端通过 `POST /api/admin/invitations/issue` 签发链接，使用稳定的 `orderRef` 防止自动发货重试时重复发码：

```http
POST /api/admin/invitations/issue
Authorization: Bearer <ADMIN_API_TOKEN>
Content-Type: application/json
```

```json
{"orderRef":"order-id:item-id:delivery-sequence","customerRef":"stable-customer-ref"}
```

接口成功返回的 `inviteUrl` 可直接发给买家；详细的 request/response、幂等规则和安全注意事项见 [签发邀请码 runbook](docs/runbooks/issue-invitation-links.md)。当前 API 还包括邀请码/管理员会话、`/api/admin/users`、`/api/admin/invitations`、`/api/admin/presets`，以及用户侧 `/api/presets`、`/api/uploads` 和 `/api/jobs`（含状态与结果接口）。本地没有数据库时页面仍可预览，服务端接口返回 unavailable；可使用 `npm run db:generate` 从 schema 生成后续 migration。

登录用户可在页面上传照片并创建 `queued` 任务；worker 接入前任务会保留在队列，不会伪造生成结果。图片由浏览器直传七牛，详见 [七牛上传与任务 API runbook](docs/runbooks/qiniu-storage-and-jobs.md)。

管理员控制台入口为 `/admin`，使用服务端 `ADMIN_API_TOKEN` 登录；可管理邀请码、查看用户持有的邀请 code/链接、重新签发或撤销邀请、管理用户状态和预设显示配置。ComfyUI 页面目前为预留说明。详细操作见 [后台管理 runbook](docs/runbooks/admin-console.md)。

总体方案与详细接口见 [`docs/design/`](docs/design/README.md)。
管理员数据库初始化与邀请码操作见 [`docs/runbooks/`](docs/runbooks/README.md)。
