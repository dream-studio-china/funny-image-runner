# 咔嚓造梦局

移动端优先的图像生成应用。当前包含可交互演示 UI、MySQL 数据层、一次性邀请码兑换与会话 API。图片上传/任务创建仍为展示模式；**演示效果是预制样图，不会根据上传照片生成图片**。ComfyUI worker 目前仅有设计预留，等待 API 格式工作流 JSON 和节点映射。

```bash
npm install
npm run dev
```

访问 http://localhost:3000。构建与静态检查：`npm run build`、`npm run lint`、`npm run typecheck`。

## 阿里云 RDS MySQL

1. 创建 MySQL 数据库和仅供应用使用的账号，设置可访问来源并启用 TLS。不要将 RDS 密码提交到仓库。
2. 将 `.env.example` 复制到 `.env.local`，设置 `DATABASE_URL`、`ADMIN_API_TOKEN`、`INVITATION_ENCRYPTION_KEY` 和 `APP_BASE_URL`；若 RDS 使用自定义 CA，设置 base64 编码的 `MYSQL_SSL_CA_BASE64`。TLS 在 production 强制校验服务端证书。`INVITATION_ENCRYPTION_KEY` 用 `openssl rand -base64 32` 生成并备份；同一环境不可随意更换，否则自动发货重试无法还原已签发链接。
3. 应用 SQL schema：`npm run db:migrate`。这个命令只应在配置了可访问的 `DATABASE_URL` 后运行。
4. 用管理员 seed 创建并导入邀请码（seed 只放在可信的管理员终端，不放入 `.env.local`、Vercel 或 Git）：

```bash
INVITE_SEED="<至少 32 字节随机值的 base64 或 hex>" \
APP_BASE_URL="http://localhost:3000" \
ADMIN_API_TOKEN="<与服务端配置相同的管理员 token>" \
npm run invitations:create -- spring-2026 user_001 1 1
```

该命令为给定用户生成 `count` 个一次性邀请码，先将邀请码摘要写入 `POST /api/admin/invitations/import`，仅成功后才打印邀请链接。链接把邀请码放在 URL fragment（`#invite=...`），浏览器打开后会自动填入兑换框；不会在 GET 时自动兑换，避免预览机器人消耗邀请码。通过 `openssl rand -base64 32` 生成 seed，通过 `openssl rand -base64 48` 生成管理员 token，并安全交付邀请链接。

淘宝自动发货服务端通过 `POST /api/admin/invitations/issue` 签发链接，使用稳定的 `orderRef` 防止自动发货重试时重复发码：

```http
POST /api/admin/invitations/issue
Authorization: Bearer <ADMIN_API_TOKEN>
Content-Type: application/json
```

```json
{"orderRef":"order-id:item-id:delivery-sequence","customerRef":"stable-customer-ref"}
```

接口成功返回的 `inviteUrl` 可直接发给买家；详细的 request/response、幂等规则和安全注意事项见 [签发邀请码 runbook](docs/runbooks/issue-invitation-links.md)。当前还提供 `POST /api/auth/redeem`、`GET /api/auth/me`、`POST /api/auth/logout`、`POST /api/admin/invitations/import` 及 `GET /api/health`。本地没有数据库时页面仍可预览，服务端接口返回 unavailable；可使用 `npm run db:generate` 从 schema 生成后续 migration。

总体方案与详细接口见 [`docs/design/`](docs/design/README.md)。
管理员数据库初始化与邀请码操作见 [`docs/runbooks/`](docs/runbooks/README.md)。
