# 详细设计：身份与邀请码

关联：[总体设计](./high-level-design.md) · [任务 API](./low-level-jobs.md)

## 身份模型

- `users(id VARCHAR(64) PRIMARY KEY, created_at, disabled_at)`：`id` 可由管理员指定，也可由发码 API 根据稳定 `customerRef` 派生；采用长度 3–64、字母数字及 `_-`，创建后不可由用户修改。
- `invitations(id CHAR(36), user_id FK, batch_id VARCHAR(80), ordinal INT, code_hash CHAR(64) UNIQUE, created_at, expires_at, redeemed_at, revoked_at, issue_source NULL, source_ref NULL, code_ciphertext NULL)`：一个用户可有多张邀请凭证；同一凭证可重复创建登录会话，直到过期、管理员撤销或用户停用。`redeemed_at` 仅记录首次使用时间；`(batch_id, ordinal)` 和 `(issue_source, source_ref)` 唯一。`source_ref` 是外部订单引用的 SHA-256，不存原始订单标识；API 签发码以 AES-256-GCM 加密保存，仅用于幂等重试返回相同链接。撤销状态独立于首次使用状态；禁用用户后历史任务保留，接口拒绝新登录/提交。
- `sessions(id CHAR(36), user_id FK, token_hash CHAR(64) UNIQUE, expires_at, revoked_at, created_at)`：Cookie 中只有随机会话令牌，数据库存其摘要。会话可撤销；默认绝对有效期 30 天，按需要提供显式退出。
- `admin_sessions(id CHAR(36), token_hash CHAR(64) UNIQUE, expires_at, revoked_at, created_at)`：管理员通过 `ADMIN_API_TOKEN` 建立 8 小时数据库会话；浏览器只保存独立 HttpOnly/SameSite=Strict Cookie。

表由 Drizzle MySQL schema 定义并通过提交的 SQL migration 建立。所有日期列使用 UTC `DATETIME(3)`，连接池使用 UTC 时区；UUID 以 CHAR(36) 存储，摘要以固定长度十六进制字符串存储。邀请码登录在 MySQL 事务中通过 `SELECT ... FOR UPDATE` 锁定邀请行，拒绝已撤销/过期邀请或已停用用户；`redeemed_at` 仅首次登录时设置，后续登录保留该时间。

管理员发码 CLI 在可信设备运行；使用至少 256 位随机生成的秘密 `INVITE_SEED`，按 `HMAC-SHA256(seed, "invite:v1:" + batch_id + ":" + ordinal)` 截取不少于 128 位并编码为可抄写的码。不同批次和序号有独立码；不要用时间戳或短数字做 seed。CLI 将 `code_hash` 和明文 code 通过 HTTPS 传给管理员导入接口；服务端校验 hash 后只存摘要和 AES-256-GCM 加密的 code，管理员后台才可在用户详情中恢复/复制链接。seed 不上传 Vercel、不保存数据库、不写入仓库。重复导入同一 `(batch_id, ordinal)` 幂等；摘要/用户绑定不一致时返回冲突，不静默改绑。

## HTTP 契约

| 路由 | 身份 | 入参 | 输出/副作用 |
| --- | --- | --- | --- |
| `POST /api/admin/session` | 未登录 | `{token}` | 校验管理员 API token，创建 8 小时管理员会话 Cookie |
| `GET /api/admin/session` / `DELETE /api/admin/session` | 管理员 Cookie | 无 | 查询会话状态 / 撤销当前管理员会话 |
| `POST /api/admin/invitations/import` | 管理员 Bearer / 管理员 Cookie | `items: [{userId,batchId,ordinal,codeHash,code?,expiresAt}]` | 事务创建用户（如不存在）及邀请；收到原始 code 时校验摘要并加密保存，绝不返回明文 |
| `POST /api/admin/invitations/issue` | 管理员 Bearer（自动发货）/ 管理员 Cookie | `{orderRef,userId?,customerRef?}` | 按订单引用幂等地创建用户/邀请凭证，返回可重复登录的 `inviteUrl`；同单重试返回原链接 |
| `GET /api/admin/users` / `PATCH /api/admin/users/{id}` | 管理员会话/Bearer | 查询参数 / `{disabled:boolean}` | 查看用户及任务计数，停用用户时撤销其登录会话 |
| `GET /api/admin/users/{id}/invitations` | 管理员会话/Bearer | 无 | 查看该用户邀请记录；仅在密文可恢复且链接有效时返回 code/URL |
| `GET /api/admin/invitations` / `POST /api/admin/invitations/{id}/revoke` | 管理员会话/Bearer | `limit` / 无 | 列出发码记录 / 撤销尚未撤销的邀请凭证 |
| `GET /api/admin/presets` / `PATCH /api/admin/presets/{id}` | 管理员会话/Bearer | 风格公开字段 | 编辑现有风格字段并递增版本；workflow 映射不从浏览器配置 |
| `POST /api/auth/redeem` | 未登录 | `{code}` | 原子兑换、创建会话、设置 HttpOnly Cookie，返回 `{userId}` |
| `GET /api/auth/me` | 用户 Cookie | 无 | `{userId}`，无效会话返回 401 |
| `POST /api/auth/logout` | 用户 Cookie | 无 | 撤销当前会话并清除 Cookie |

登录事务：规范化码并计算摘要 → 以 IP 摘要为 key 使用 MySQL `auth_rate_limits` 做跨实例限速（每 IP 每 15 分钟最多 10 次）→ 查询邀请码并锁行 → 检查未撤销、未过期且用户未禁用 → 首次使用时写入 `redeemed_at`（后续登录保留原时间）→ 每次创建新的随机用户会话 → 提交事务后设置 `HttpOnly; Secure; SameSite=Lax; Path=/` Cookie。无效/已撤销/过期使用统一错误提示；日志不可记录邀请码、Cookie 或 seed。会话读取校验过期、撤销与用户禁用；用户上下文由服务端注入后续 API。

用户退出只撤销当前会话，不会消耗或撤销邀请链接；用户可从最初收到的链接再次登录。链接丢失时，管理员可在 `/admin` 用原订单引用重取自动签发链接（同一订单幂等），或为同一 `user_id` 新签发一个链接。后台可撤销尚未过期/撤销的邀请链接，也可停用用户并撤销其全部会话。

## 服务凭证

- 管理员 Bearer 凭证供 `/admin` 登录、可信发码 CLI/自动发货服务端使用；登录后浏览器得到 8 小时管理员会话 Cookie。worker Bearer 凭证仅供同机 worker 使用；分别配置、单独轮换，均只存服务端环境变量（或以摘要比对），至少 256 位随机值。
- 自动发码 API 使用 `ADMIN_API_TOKEN` 与独立的 `INVITATION_ENCRYPTION_KEY`（32 随机字节 Base64）；加密密钥仅存服务端，必须备份并保持稳定以支持订单重试解密。API URL 使用 `APP_BASE_URL`，生产必须为 HTTPS。
- `/api/admin/*` 只接受管理员身份；`/api/worker/*` 只接受 worker 身份；用户 Cookie 在这些接口上不生效。所有写接口检查 `Origin`/同站要求（Cookie 路由）与请求体大小；Bearer 路由不依赖 Cookie。
- 管理员接口是互联网可达的 HTTPS API，必须有请求速率限制、审计记录及凭证轮换能力。管理员 seed 与管理员 Bearer 凭证是两个不同的秘密。

## 验收条件

同一有效邀请凭证可重复建立会话；撤销、过期或用户停用后不能登录；重导入不改变绑定；会话失效后不能取私有任务；普通用户及 worker 均无法调用管理员接口。
