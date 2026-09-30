# 详细设计：任务数据与 HTTP API

关联：[总体设计](./high-level-design.md) · [身份](./low-level-identity.md) · [存储](./low-level-storage.md) · [本地 worker](./low-level-worker.md)

## 数据模型

以下为逻辑字段，MySQL 列类型和约束由 Drizzle schema 与 SQL migration 定义；状态和时区由应用层约束：

| 表 | 关键字段 / 索引 |
| --- | --- |
| `uploads` | `id UUID PK`, `user_id FK`, `object_key UNIQUE`, `content_type`, `declared_size`, `expires_at`, `consumed_job_id UNIQUE NULL`, `created_at`；索引 `(user_id, created_at DESC)` |
| `jobs` | `id CHAR(36) PK`, `user_id FK`, `upload_id FK UNIQUE`, `idempotency_key CHAR(36)`, `request_hash`, `preset_id`, `preset_version`, `parameters JSON`, `status`, `phase`, `attempts`, `lease_token_hash`, `lease_until`, `prompt_id CHAR(36) UNIQUE NULL`, `error_code`, `created_at`, `updated_at`, `finished_at`；唯一索引 `(user_id, idempotency_key)`，另有 `(user_id, created_at)` 和待领任务 `(status, lease_until, created_at)` |
| `job_outputs` | `job_id FK`, `index INT`, `object_key UNIQUE`, `content_type`, `size`；主键 `(job_id, index)` |
| `preset_categories` / `presets` / `preset_versions` | 分类归属、当前公开展示字段、历史版本私有执行快照；详见[分类与风格设计](./low-level-presets.md) |

身份表定义见 [身份设计](./low-level-identity.md)。任务中的参数是快照，保留对应的 `preset_version`；版本表单独保存管理员配置的**不可变** workflow 快照，任务行不重复存储 workflow JSON。变更预设不能默默改写排队中的任务。限制用户参数 JSON 体积和字段数量。任务行只保存必要的对象引用，不保存签名 URL 或七牛凭证；版本表中的工作流/提示词属于私有配置，不返回用户 API。

## 状态机

```text
queued ── 领取 ──> running ── 完成并核验输出 ──> succeeded
  │                  │
  └── 入队失败等 ──> failed <── 明确的执行错误/超时 ─┘

running.phase = claimed | input_ready | prompt_submitting |
                prompt_submitted | output_uploading
```

`queued` 只在任务创建后等待；`running` 表示有 worker 租约。`attempts` 是租约领取次数，非 ComfyUI 提交次数。租约过期时允许重新领取以**恢复同一任务**：如果 `prompt_id` 已记录，只能先查询 ComfyUI `/history/{prompt_id}` 和队列状态，不直接再次调用 `/prompt`；如果状态无法判断，保留对账流程并最终报告 `execution_uncertain`，而不是盲目重跑。明确失败可以终止；首版不提供用户取消/自动重试失败任务。终态不可再更改。后台扫描长期过期任务并触发对账/失败，避免永远停留 `running`。

## 用户 API

| 路由 | 行为 |
| --- | --- |
| `GET /api/presets` | 返回启用的分类、分类封面，以及各分类下可用风格的公开字段、展示图链接与版本；不返回 worker 配置 |
| `POST /api/uploads` | 签发直传凭证并建立上传占位，细节见存储设计 |
| `POST /api/jobs` | `{uploadId, presetId, parameters, idempotencyKey}`；鉴权、校验预设/用户限额/七牛对象，原子消费上传并创建任务；返回 201 `{id,status}`，同一用户同一键的原请求重复提交返回原任务，参数冲突返回 409 |
| `GET /api/jobs?limit=20` | 仅列当前用户最近任务，`limit` 最大 50；不返回内部租约或七牛对象 key |
| `GET /api/jobs/{id}` | 仅当前用户；返回 `{id,presetId,status,createdAt,finishedAt,errorCode?}`，失败只暴露安全的错误码 |
| `GET /api/jobs/{id}/result` | 仅成功且属于本人时返回短期结果签名 URL（多图则为数组） |

`idempotencyKey` 是浏览器对一次“点击生成”生成的 UUID，并与 `user_id` 共同唯一；在任务表保存该值及规范化请求摘要。服务端先查询已存在的幂等键：摘要相同直接返回原任务，即使上传已被消费；摘要不同返回 409。上传对象的唯一消费约束是第二层保护。对象核验属于外部 IO，先完成核验再进入短数据库事务；事务中重新检查上传未消费、身份/分类/风格有效、所选版本已具备可执行配置，并以该版本字段规则校验输入；如状态发生变化则拒绝创建，不能以客户端提交的版本号绕过。首版默认单用户同时最多一个非终态任务、每日最多十次提交，实际阈值可配置；并对提交/轮询接口限速。

## worker API

以下是目标 worker API 契约，当前 worker 进程及这些路由尚未实现；因此目前创建的任务会留在 `queued`，不会自动生成结果。

全部使用独立 Bearer 凭证、HTTPS。领取任务返回规范化参数和预设版本，但**不**直接返回七牛下载链接；所有写请求含租约令牌。令牌由领取时生成，仅其摘要入库，过期/错误令牌一律 409。

| 路由 | 输入 / 作用 |
| --- | --- |
| `POST /api/worker/jobs/claim` | MySQL 8.0+ 事务中以 `FOR UPDATE SKIP LOCKED` 选最旧 `queued` 或过期 `running` 任务，设置 `running`、新租约、`attempts + 1`；空队列返回 204。若 RDS 小版本/事务隔离级别不支持该锁语义，使用条件 UPDATE 原子抢占 |
| `GET /api/worker/presets/{id}/versions/{version}` | 独立 worker Bearer 鉴权；只返回指定不可变版本的 workflow、提示词、附加参数及节点映射，不对用户/管理员浏览器开放；缺失或未配置返回明确错误 |
| `POST /api/worker/jobs/{id}/heartbeat` | `{leaseToken, phase?, promptId?}`；仅当前持有者可续租和推进 phase；第一次提交 `promptId` 时必须在调用 ComfyUI `/prompt` **之前**写入 `prompt_submitting`，以后不得修改 ID |
| `POST /api/worker/jobs/{id}/input-url` | `{leaseToken}`；签发仅本任务输入的短期读链接 |
| `POST /api/worker/jobs/{id}/output-upload` | `{leaseToken,index,contentType,size}`；签发限定任务结果 key 的上传凭证 |
| `POST /api/worker/jobs/{id}/complete` | `{leaseToken,outputs:[{index,key,contentType,size}]}`；校验租约、对象 key 和七牛已存在对象，事务写入输出并置为 `succeeded` |
| `POST /api/worker/jobs/{id}/fail` | `{leaseToken,errorCode}`；仅允许枚举的错误码，事务置为 `failed` |

提交 `promptId` 的写入采用“只允许 NULL → 固定值”的条件更新。每次状态变更检查 `status=running`、租约摘要相同且尚未过期；领取和续租使用 UTC 数据库时间。JSON 参数使用 MySQL JSON 列；时间排序必须使用 `(created_at, id)` 稳定游标。默认租约 90 秒、每 20 秒心跳、单次最长执行 20 分钟；心跳持续失败则 worker 停止后续提交/上报并进入恢复路径。`attempts` 建议上限 3，达到上限时由对账过程置为失败并记录管理员可见诊断。

## 故障语义与验收

网络请求可重复，但完成接口必须幂等（同一结果再次提交成功返回已有终态）；不同结果或已失效租约返回 409。数据库与 ComfyUI、七牛之间没有分布式事务，因此采用“先持久化意图 → 外部调用 → 对账 → 持久化结果”。明确的 ComfyUI 报错映射为失败；丢失 `/prompt` 响应时不得断言没有执行。验证两个 worker 并发领取不重复、旧租约不可覆盖新结果、同一上传不会创建两个任务、不同用户无法读写彼此任务。
