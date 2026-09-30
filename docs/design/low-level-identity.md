# 详细设计：身份与邀请码

关联：[总体设计](./high-level-design.md) · [任务 API](./low-level-jobs.md)

## 身份模型

- `users(id TEXT PRIMARY KEY, created_at, disabled_at)`：`id` 是管理员预先指定且唯一的自定义用户标识。采用固定规范（例如长度 3–64、字母数字及 `_-`），创建后不可由用户修改。
- `invitations(id UUID, user_id FK, batch_id TEXT, ordinal INT, code_hash CHAR(64) UNIQUE, created_at, expires_at, redeemed_at)`：一个用户可有多张邀请码，但每张仅兑换一次；`(batch_id, ordinal)` 唯一。禁用用户后历史任务保留，接口拒绝新登录/提交。
- `sessions(id UUID, user_id FK, token_hash CHAR(64) UNIQUE, expires_at, revoked_at, created_at)`：Cookie 中只有随机会话令牌，数据库存其摘要。会话可撤销；默认绝对有效期 30 天，按需要提供显式退出。

管理员发码 CLI 在可信设备运行；使用至少 256 位随机生成的秘密 `INVITE_SEED`，按 `HMAC-SHA256(seed, "invite:v1:" + batch_id + ":" + ordinal)` 截取不少于 128 位并编码为可抄写的码。不同批次和序号有独立码；不要用时间戳或短数字做 seed。数据库只存 `SHA-256(normalize(code))`；HMAC 的强随机性保证即使摘要泄露也不易离线枚举。seed 不上传 Vercel、不保存数据库、不写入仓库。发码 CLI 只传 `user_id, batch_id, ordinal, code_hash, expires_at` 到管理员导入接口，并仅在本地输出明文码。重复导入同一 `(batch_id, ordinal)` 幂等；摘要/用户绑定不一致时返回冲突，不静默改绑。

## HTTP 契约

| 路由 | 身份 | 入参 | 输出/副作用 |
| --- | --- | --- | --- |
| `POST /api/admin/invitations/import` | 管理员 Bearer | `items: [{userId,batchId,ordinal,codeHash,expiresAt}]` | 事务创建用户（如不存在）及邀请码；不返回明文 |
| `POST /api/auth/redeem` | 未登录 | `{code}` | 原子兑换、创建会话、设置 HttpOnly Cookie，返回 `{userId}` |
| `GET /api/auth/me` | 用户 Cookie | 无 | `{userId}`，无效会话返回 401 |
| `POST /api/auth/logout` | 用户 Cookie | 无 | 撤销当前会话并清除 Cookie |

兑换事务：规范化码并计算摘要 → 查询邀请码并锁行 → 检查未兑换、未过期且用户未禁用 → 更新 `redeemed_at`（条件更新确保仅一人成功）→ 创建随机会话 → 提交事务后设置 `HttpOnly; Secure; SameSite=Lax; Path=/` Cookie。无效/已用/过期使用统一错误提示，按 IP 和码摘要限速；日志不可记录邀请码、Cookie 或 seed。会话读取校验过期、撤销与用户禁用；用户上下文由服务端注入后续 API。

失去浏览器会话或会话到期时，不重复使用原邀请码：管理员为已有 `user_id` 签发新的一次性码。补发不会创建第二个用户；旧有效会话可由管理员撤销。用户不可通过填写其他人的标识冒领任务。

## 服务凭证

- 管理员 Bearer 凭证仅供 CLI 使用；worker Bearer 凭证仅供同机 worker 使用；分别配置、单独轮换，均只存服务端环境变量（或以摘要比对），至少 256 位随机值。
- `/api/admin/*` 只接受管理员身份；`/api/worker/*` 只接受 worker 身份；用户 Cookie 在这些接口上不生效。所有写接口检查 `Origin`/同站要求（Cookie 路由）与请求体大小；Bearer 路由不依赖 Cookie。
- 管理员接口是互联网可达的 HTTPS API，必须有请求速率限制、审计记录及凭证轮换能力。管理员 seed 与管理员 Bearer 凭证是两个不同的秘密。

## 验收条件

相同邀请码仅能成功兑换一次；重导入不改变绑定；会话失效后不能取私有任务；为原用户补发邀请码可重新登录并看到原任务；普通用户及 worker 均无法调用管理员接口。
