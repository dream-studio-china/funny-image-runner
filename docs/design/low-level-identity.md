# 详细设计：身份与邀请码

关联：[总体设计](./high-level-design.md) · [任务 API](./low-level-jobs.md)

## 身份模型

- `users(id VARCHAR(64) PRIMARY KEY, created_at, disabled_at)`：`id` 是管理员预先指定且唯一的自定义用户标识。采用固定规范（例如长度 3–64、字母数字及 `_-`），创建后不可由用户修改。
- `invitations(id CHAR(36), user_id FK, batch_id VARCHAR(80), ordinal INT, code_hash CHAR(64) UNIQUE, created_at, expires_at, redeemed_at, issue_source NULL, source_ref NULL, code_ciphertext NULL)`：一个用户可有多张邀请码，但每张仅兑换一次；`(batch_id, ordinal)` 和 `(issue_source, source_ref)` 唯一。`source_ref` 是外部订单引用的 SHA-256，不存原始订单标识；API 签发码以 AES-256-GCM 加密保存，仅用于幂等重试返回相同链接。禁用用户后历史任务保留，接口拒绝新登录/提交。
- `sessions(id CHAR(36), user_id FK, token_hash CHAR(64) UNIQUE, expires_at, revoked_at, created_at)`：Cookie 中只有随机会话令牌，数据库存其摘要。会话可撤销；默认绝对有效期 30 天，按需要提供显式退出。

表由 Drizzle MySQL schema 定义并通过提交的 SQL migration 建立。所有日期列使用 UTC `DATETIME(3)`，连接池使用 UTC 时区；UUID 以 CHAR(36) 存储，摘要以固定长度十六进制字符串存储。邀请码兑换在 MySQL 事务中通过 `SELECT ... FOR UPDATE` 锁定邀请行，并在更新时附加 `redeemed_at IS NULL` 条件；唯一约束作为并发竞争的最终防线。

管理员发码 CLI 在可信设备运行；使用至少 256 位随机生成的秘密 `INVITE_SEED`，按 `HMAC-SHA256(seed, "invite:v1:" + batch_id + ":" + ordinal)` 截取不少于 128 位并编码为可抄写的码。不同批次和序号有独立码；不要用时间戳或短数字做 seed。数据库只存 `SHA-256(normalize(code))`；HMAC 的强随机性保证即使摘要泄露也不易离线枚举。seed 不上传 Vercel、不保存数据库、不写入仓库。发码 CLI 只传 `user_id, batch_id, ordinal, code_hash, expires_at` 到管理员导入接口，并仅在本地输出明文码。重复导入同一 `(batch_id, ordinal)` 幂等；摘要/用户绑定不一致时返回冲突，不静默改绑。

## HTTP 契约

| 路由 | 身份 | 入参 | 输出/副作用 |
| --- | --- | --- | --- |
| `POST /api/admin/invitations/import` | 管理员 Bearer | `items: [{userId,batchId,ordinal,codeHash,expiresAt}]` | 事务创建用户（如不存在）及邀请码；不返回明文 |
| `POST /api/admin/invitations/issue` | 管理员 Bearer（可信自动发货服务端） | `{orderRef,userId?,customerRef?}` | 按订单引用幂等地创建用户/邀请码，返回一次性 `inviteUrl`；同单重试返回原链接 |
| `POST /api/auth/redeem` | 未登录 | `{code}` | 原子兑换、创建会话、设置 HttpOnly Cookie，返回 `{userId}` |
| `GET /api/auth/me` | 用户 Cookie | 无 | `{userId}`，无效会话返回 401 |
| `POST /api/auth/logout` | 用户 Cookie | 无 | 撤销当前会话并清除 Cookie |

兑换事务：规范化码并计算摘要 → 以 IP 摘要为 key 使用 MySQL `auth_rate_limits` 做跨实例限速（每 IP 每 15 分钟最多 10 次）→ 查询邀请码并锁行 → 检查未兑换、未过期且用户未禁用 → 更新 `redeemed_at`（条件更新确保仅一人成功）→ 创建随机会话 → 提交事务后设置 `HttpOnly; Secure; SameSite=Lax; Path=/` Cookie。无效/已用/过期使用统一错误提示；日志不可记录邀请码、Cookie 或 seed。会话读取校验过期、撤销与用户禁用；用户上下文由服务端注入后续 API。

失去浏览器会话或会话到期时，不重复使用原邀请码：管理员为已有 `user_id` 签发新的一次性码。补发不会创建第二个用户；旧有效会话可由管理员撤销。用户不可通过填写其他人的标识冒领任务。

## 服务凭证

- 管理员 Bearer 凭证仅供可信发码 CLI/自动发货服务端使用；worker Bearer 凭证仅供同机 worker 使用；分别配置、单独轮换，均只存服务端环境变量（或以摘要比对），至少 256 位随机值。
- 自动发码 API 使用 `ADMIN_API_TOKEN` 与独立的 `INVITATION_ENCRYPTION_KEY`（32 随机字节 Base64）；加密密钥仅存服务端，必须备份并保持稳定以支持订单重试解密。API URL 使用 `APP_BASE_URL`，生产必须为 HTTPS。
- `/api/admin/*` 只接受管理员身份；`/api/worker/*` 只接受 worker 身份；用户 Cookie 在这些接口上不生效。所有写接口检查 `Origin`/同站要求（Cookie 路由）与请求体大小；Bearer 路由不依赖 Cookie。
- 管理员接口是互联网可达的 HTTPS API，必须有请求速率限制、审计记录及凭证轮换能力。管理员 seed 与管理员 Bearer 凭证是两个不同的秘密。

## 验收条件

相同邀请码仅能成功兑换一次；重导入不改变绑定；会话失效后不能取私有任务；为原用户补发邀请码可重新登录并看到原任务；普通用户及 worker 均无法调用管理员接口。
