# AI 会话接续上下文

> 给后续 AI/开发会话快速恢复项目现状。不要在此写入实际密钥、数据库连接串、邀请码或签名链接。发生架构/实现变化时，同步更新本文和相关 runbook。

## 项目当前状态

- 仓库：`funny-image-runner`，Git 分支 `main`；最近已推送提交包含 `415810b`（用户配额与账户期限）和 `f9d7da9`（后台 Lightbox 尺寸修复）。分类/预设删除及可空分类迁移 `0010` 正在工作区开发中，尚未提交；接续时运行 `git status`/`git log` 确认。
- Web：Next.js App Router + React + TypeScript + Tailwind CSS，Vercel 部署；不是 Vite 工程。
- 数据：阿里云 RDS MySQL，Drizzle ORM + mysql2；本地开发使用 `.env.local`，已应用到仓库最新 schema 的 migration 应在继续改 DB 前确认。
- 存储：七牛 Kodo 私有空间，浏览器直传；AK/SK 只允许在服务端环境变量。
- 生成：本地 ComfyUI + Worker 脚本已有任务闭环；真实生成依赖管理员配置可执行的 API 格式 workflow、模型/节点，并在 ComfyUI 同机启动 Worker。
- 功能：邀请认证、管理员后台、用户与分类/预设/workflow 管理、七牛直传、任务状态/结果 API、Node Worker 和独立 Linux shell Worker 已实现。
- 页面：未登录用户仍可查看演示风格；登录用户可上传并提交真实任务。原图在浏览器端处理：输入格式 JPEG/PNG/WebP；源文件字节数不作前置限制，但需由浏览器可解码；超过 2,000,000 像素会缩放至不超过 2M 像素并转 JPEG，处理后的文件受 20 MiB 上传 token 上限约束。

## 当前架构和边界

```text
用户浏览器 ──HTTPS──> Vercel / Next.js 页面与 API
      └──图片直传、限时取图──> 七牛 Kodo 私有空间
Vercel / Next.js ──SQL──> 阿里云 RDS MySQL
ComfyUI 同机 Worker ──主动 HTTPS 轮询/回报──> Next.js Worker API
ComfyUI 同机 Worker ──127.0.0.1:8188──> 本地 ComfyUI
```

- Web 不转发图片字节，也不等待 GPU 推理。Worker 从云端领取任务，不能让浏览器访问 ComfyUI。
- ComfyUI 不应暴露到公网；同机调用默认使用 `http://127.0.0.1:8188`。Tailscale 用于受限运维/需要时的私网连通，不代替应用会话认证。
- 七牛上传输入 key 为 `inputs/{userId}/{uploadId}`；结果 key 为 `outputs/{jobId}/{index}`。服务端签发单对象、短时、insert-only 上传凭证，创建任务时通过 Kodo stat 检查对象大小与 MIME。
- 真实任务依赖 MySQL 中的 `preset_categories`、`presets`、`workflow_configs`、不可变 `preset_versions` 快照；Worker 必须执行任务记录所指向的确切 `presetId@version`，不得静默改用最新版本。

## 邀请与认证语义（重要）

- 邀请链接是**可重复使用的登录凭证**，直到过期、管理员撤销或用户停用。退出仅撤销当前用户 session；不要再把 `redeemed_at` 当作消费/禁用标志，它只记录首次登录时间。
- 同一邀请可创建多个独立用户会话（默认最长 30 天，并受账户失效时间截断）；兑换入口每 IP 有尝试限流。管理员登录 `/admin` 使用 `ADMIN_API_TOKEN` 换取 8 小时 HttpOnly、SameSite=Strict 管理员 session。
- 邀请签发可设置账户有效期：1h/4h/24h（默认）/72h/7d/30d/365d/无限；从首次兑换时起算。未兑换前邀请码按自身兑换截止时间有效；首次兑换后邀请码有效期延长至账户失效时间（无限账户邀请码不限期），用于用户在 session 到期后重新登录。已有账户 migration 后默认无限期；新账户首次兑换后开始计时。账户到期后所有用户会话/API 立即失效。
- 邀请链接优先使用 `#invite=...` fragment，页面读取后预填并从地址栏移除，但不会自动登录。用户退出后应重新打开最初收到的邀请链接。
- 淘宝自动发货调用 `POST /api/admin/invitations/issue`。`orderRef` 必须稳定并对每份交付唯一，同单重试返回同一链接。API 生成的代码以 `INVITATION_ENCRYPTION_KEY` 的 AES-GCM 密文保存，以便管理员/发货重试恢复原链接；同一订单更换 userId 返回冲突。
- `/admin` 用户详情可查看与复制有效邀请 code/link；新版 CLI 导入也将 code 通过 HTTPS 交给服务端，服务端验证 hash 后加密存储。**旧版只保存 hash 的历史 CLI 邀请无法还原明文**，必要时重建/重新签发。
- 管理员撤销写入 `revoked_at` 并留审计事件；撤销不踢掉已登录 session。停用用户会撤销其所有用户 session。

## 管理后台 `/admin`

- 登录：服务端 `ADMIN_API_TOKEN`；不要将 token 放进客户端代码、公开日志或发给买家。管理员 API 同时支持 bearer（CLI/可信发货服务）和受保护的管理员 cookie 会话。
- 已实现：邀请码签发、列表、撤销及查看 code；用户搜索、启停、查看邀请与任务；分类、展示图、预设、工作流配置维护（包含确认删除）；ComfyUI/Worker 预留说明和 Worker 状态显示。
- 新增「账户配额」管理页：全局总任务默认上限（NULL=无限）和每日任务默认上限；用户个人总/每日上限可覆盖全局默认，留空继承默认，0 表示不可新建任务。总任务按所有既有任务计数（含失败），每日按 UTC 自然日计数。后台可直接设置用户精确失效时间或清空为无限。
- 图片管理已实现于 `/admin`「图片管理」页和 `GET/DELETE /api/admin/images`：支持原图/生成结果/封面图库、按类型/用户/上传时间/文件大小筛选、排序分页、Lightbox 原图预览及用户/任务/风格/分类/Key/大小/MIME/时间等元数据查看；支持选择删除和按日期清理（单次最多 100 张）。
- 图片删除会先删除七牛对象，再将 `uploads`、`job_outputs` 或 `preset_assets` 对应行标记 `deleted_at`，保留数据库记录用于任务历史与审计。正在运行任务使用的原图、仍被分类或预设引用的封面会拒绝/跳过删除；管理员 API 需认证并校验同源。删除后普通任务/Worker 结果和输入取图路径不再提供对象 URL。
- 分类删除通过事务将关联预设的 `category_id` 置为 NULL 后删除分类；预设删除前锁定预设并拒绝仍有 queued/running job 的情况。删除预设会移除当前目录行但保留 `preset_versions` 不可变历史与已有任务；相同 ID 重建时版本号从历史最大值递增。系统默认分类 `general` 被保护，不允许删除。migration `0010_uncategorize_presets.sql` 将 `presets.category_id` 改为可空；公开预设列表仍会展示未分类预设。
- 风格封面使用七牛展示图资产；工作流配置保存版本，预设版本会锁定 workflow 快照。不能将 workflow JSON、节点映射、additional JSON 下发给普通用户。
- 管理员 CLI：`npm run invitations:create -- <batch-id> <user-id> [count] [ordinal-start]`。`INVITE_SEED` 仅放可信终端；`ADMIN_API_TOKEN`、`INVITATION_ENCRYPTION_KEY` 和 `APP_BASE_URL` 在发码客户端/服务端按 runbook 提供。

## Worker 与 ComfyUI

- 启动：完整项目 `npm run start:worker`，底层启动器 `scripts/start-comfyui-worker.mjs`，实际 Worker `scripts/comfyui-worker.mjs`；无仓库的 Linux ComfyUI 主机可用 `scripts/comfyui-worker-linux.sh`。
- Node Worker 要求 Node 22.21+（启动时使用 Node 环境代理支持）；Shell Worker 基础依赖 Bash、curl、jq、file。配置 `WEB_API_BASE_URL`、与网站一致的 `WORKER_TOKEN`、`COMFY_BASE_URL`；ComfyUI host 自动加入 `NO_PROXY`，不要清空系统 HTTP(S) 代理。
- Node Worker 在上传前尝试将不透明 PNG 用 sharp 以 JPEG quality 88 转码，只有转码后更小时才采用；包含透明像素的 PNG 保留原格式。Linux Shell Worker 同样尝试转码，但需 Python 3 + Pillow（可用 `WORKER_PYTHON` 指向解释器），不可用时原样上传。
- 云端 Worker API：claim、heartbeat/status、job heartbeat、input-url、preset version config、output-upload、complete、fail。用户新建任务后若 Worker 未在线，任务保持 `queued`。
- 提交 ComfyUI `/prompt` 前先持久化 `prompt_submitting`；ComfyUI 自己生成 `prompt_id`，Worker 取得后立即记账。提交结果不确定时进入 `execution_uncertain`，不能自动重放。租约用于并发保护；ComfyUI 与 MySQL/七牛无分布式事务。
- 当前开发者仍须确认实际 workflow JSON、节点映射、模型和 custom nodes；Worker 状态在线并不代表任一预设 workflow 已成功产图，按 runbook 做真实端到端验证。

## 数据模型概览

MySQL schema 在 `src/lib/db/schema.ts`，Drizzle migrations 在 `drizzle/`：

- 身份：`users`、`invitations`、`sessions`、`admin_sessions`、`auth_rate_limits`、`audit_events`、`system_settings`。`users` 存个人总/每日任务覆盖值、账户失效时间和首次有效期初始化标记；`invitations.account_ttl_minutes` 存首次登录后生效的账户期限（NULL=无限）。
- 图片/生成：`uploads`、`jobs`、`job_outputs`；三类图片资产表（`uploads`、`job_outputs`、`preset_assets`）均含可空 `deleted_at` 软删除时间。migration `0008_image_deleted_at.sql` 已应用到当前本地 TiDB 测试库。账户配额/期限 migration `0009_user_limits_account_expiry.sql` 和可空分类 migration `0010_uncategorize_presets.sql` 也已应用到本地 TiDB 测试库；部署环境需单独确认 migration 状态。
- 风格/工作流：`preset_categories`、`preset_assets`、`presets`、`workflow_configs`、`preset_versions`。
- Worker 在线状态：`workers`。

重要安全字段：邀请/用户/管理员 session、worker 租约使用摘要或不可预测 ID；邀请码 raw code 仅加密存于 `code_ciphertext`（当有加密密钥时），普通用户接口不返回。不要把签名 URL/token 存数据库或日志。

## 配置提示

参考 `.env.example`；不要复制真实 `.env.local` 内容到任何文档。

- MySQL：`DATABASE_URL`；production 校验证书，可用 `MYSQL_SSL_CA_BASE64`。
- 管理员：`ADMIN_API_TOKEN`、`INVITATION_ENCRYPTION_KEY`（32 随机字节 Base64）、`APP_BASE_URL`、可选 `INVITATION_TTL_DAYS`。
- 七牛：`QINIU_ACCESS_KEY`、`QINIU_SECRET_KEY`、`QINIU_BUCKET`、匹配 bucket 区域的 `QINIU_UPLOAD_URL`、HTTPS `QINIU_PRIVATE_DOMAIN`；bucket CORS 允许网站准确 origin 的 POST/OPTIONS。
- Worker：云端和本地相同的 `WORKER_TOKEN`，另设 `WEB_API_BASE_URL`、`COMFY_BASE_URL`、可选 `WORKER_ID/WORKER_NAME`。
- `.env.local` 已被 `.gitignore` 忽略；改动环境配置后需要重启/确认 dev server 已重新载入环境。

## 重要密钥处理

之前一次 `.env.local` 编辑预览曾意外输出过 `QINIU_SECRET_KEY`。请确认该 SecretKey 已在七牛侧轮换，并同步更新本地/部署环境。永远不要在上下文文件里保存 AK/SK、管理员 token、数据库 URL、`WORKER_TOKEN`、`INVITATION_ENCRYPTION_KEY`、邀请链接或 session cookie；只描述变量名和状态。

## 常用验证与下一步

```bash
npm run lint
npm run typecheck
npm run build
npm run db:migrate
curl --fail --silent --show-error http://localhost:3000/api/health
```

分类/预设删除已经实现并通过 lint/typecheck/build；migration `0010` 已应用到当前本地 TiDB 测试库。继续验收删除确认、category deletion 对关联预设的未分类处理、运行中任务保护、删除后预设版本历史保留及同 ID 重新创建。默认分类 `general` 由 seed 逻辑维护，后台禁止删除。随后可继续完成账户期限/配额和图片管理的端到端验收，再用 QUICKSTART 验证真实任务闭环。对象定期清理仍有后续完善空间。详细操作参见 [QUICKSTART](../../QUICKSTART.md)、[设计索引](../design/README.md) 和 [runbook 索引](../runbooks/README.md)。
