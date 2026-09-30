# 总体设计（High-Level Design）

## 1. 目标与范围

邀请用户兑换一次性邀请码后，上传一张图片、选择受控预设、填写允许的补充信息，异步获得 ComfyUI 生成的图片。提供用户任务列表、状态、结果查看与下载，以及 `/admin` 邀请码、用户和风格管理。目标部署按单台 ComfyUI、单个常驻 worker 设计；不提供用户自由编辑 workflow 或直接访问 ComfyUI。当前已实现邀请/管理后台、七牛直传和任务入队；worker 和实际图像生成尚未实现。

## 2. 部署单元

```text
用户浏览器 ── HTTPS ──> Vercel / Next.js (页面、Route Handlers)
      │                          │
      └── 直传/限时取图 ──> 七牛私有空间
                                 │
                         阿里云 RDS MySQL (持久化)
                                 ▲
                  HTTPS 主动轮询/回报 (worker 凭证)
                                 │
                   本地常驻 worker ── localhost:8188 ──> ComfyUI
                           │
                           └── HTTPS 下载输入/上传输出 ──> 七牛

管理员 ── 私有发码 CLI / 管理员 API ──> Vercel
管理员浏览器 ── `/admin` 管理后台 ──> Vercel
管理员 ── Tailscale (受限远程运维) ──> 本地机器
```

Next.js 同时承载页面与轻量 API。云端接口仅执行认证、校验、签名、数据库事务及状态查询，不承担图片字节转发或等待 GPU 完成。阿里云 RDS MySQL 是用户、邀请码、预设及任务的事实来源；七牛是图片字节的事实来源。worker 只向外发起连接；ComfyUI 不对公网开放，浏览器无法调用 worker 内部接口。

若将来 worker 改部署到另一台机器，才需要通过 Tailscale grants 限制其到 ComfyUI 的主机/端口访问；当前同机配置使用回环地址。Tailscale 不代替用户登录或 worker API 凭证。

## 3. 主要流程

1. 管理员通过 `/admin` 或淘宝自动发货服务端签发一次性邀请码；CLI 可用私有 seed 在可信设备批量生成并导入。明文链接仅交付给对应用户。
2. 用户兑换邀请码；服务端原子标记已使用并创建浏览器会话。丢失会话时管理员可为**同一** `user_id` 补发新码。
3. 用户请求某个图片 key 的限范围、短有效期上传凭证；浏览器直接上传七牛。
4. 用户提交 `preset_id`、`uploadId` 及白名单参数；云端核验上传对象和归属，创建 `queued` 任务，立即返回 `job_id`。
5. worker 轮询领取任务，生成租约，下载输入并上传到同机 ComfyUI；按预设修改服务端控制的 API 工作流，提交 `/prompt`。（worker 当前未实现）
6. worker 等待并查询输出，将结果上传七牛，通过完成接口上报；用户轮询自己的任务，收到短期私有下载链接。

流程契约分别见 [身份](./low-level-identity.md)、[预设](./low-level-presets.md)、[存储](./low-level-storage.md)、[任务 API](./low-level-jobs.md)、[worker](./low-level-worker.md)。

## 4. 一致性与安全边界

- 所有浏览器 API 校验会话；`user_id` 从服务端会话读取，绝不信任请求中的自报标识。管理员、worker 各有独立凭证及路由权限。
- 邀请码由保密 seed 推导，数据库仅存摘要；邀请码兑换一次，不能充当长效 API 密钥。私有密钥只在服务端或发码 CLI 使用，不进入浏览器包。
- 预设在服务端做白名单校验；用户只能传公开参数，不能传节点 ID、模型路径、workflow JSON、七牛任意 URL。
- 七牛对象按用户/任务区分 key；使用私有空间、限时签名链接和服务器端对象存在性检查；不允许通过用户提供的 URL 触发 worker 对任意内网地址下载。
- `POST /jobs` 返回任务 ID 而非等待推理；持久任务采用租约、心跳及尝试次数管理。ComfyUI 提交结果不明确时先对账，不能直接重放提交。
- `input`/`output` 只留存对象 key；结果归属由数据库任务记录决定。数据库索引、过期清理、重试与限额均须有独立实现。

## 5. 技术与容量基线

| 项目 | 首版决定 |
| --- | --- |
| Web | Next.js App Router、React、TypeScript、Tailwind CSS |
| 持久化 | 阿里云 RDS MySQL；短事务领取任务，不依赖 Vercel 进程内队列 |
| 图像存储 | 七牛私有空间；浏览器直传，worker 直下/直上 |
| 本地执行 | 独立 TypeScript/Node.js 常驻进程，同机调用 ComfyUI 原生 HTTP API |
| 实时性 | 浏览器短间隔轮询状态；worker 长轮询不作为首版前提 |
| 并发 | 单 worker、推理并发 1；Web 层按用户限额，后续再扩容 |

### 当前实现状态

- 已实现：`/admin` 管理会话、邀请码签发/撤销、用户启停、现有预设字段编辑；预设、用户、上传占位和任务存储于 MySQL。
- 已实现：登录用户经浏览器直传七牛并创建 `queued` 任务；用户任务列表/状态/结果访问 API 已有。
- 未实现：本地 worker 领取任务、ComfyUI workflow 执行、生成结果上传、过期对象清理。没有 worker 时任务保持 `queued`，界面不会伪造生成图。

数据库驱动采用 Drizzle ORM + mysql2，RDS 连接由 `DATABASE_URL` 配置；七牛 Kodo 通过服务端签名协议接入。限额、TTL 和文件大小均作为可配置值，首版建议值列在各详细设计中。

## 6. 验收链路

在 Vercel 预览/生产环境分别验证：发码与一次性兑换；跨用户无法查看任务；直传大于 Vercel 函数请求体限制的图片；worker 离线时任务保持可见、重连可继续；真实工作流成功产图；ComfyUI 报错及重启后的状态恢复；结果短期链接到期后无法匿名读取。
