# 详细设计：部署、运维与验收

关联：[总体设计](./high-level-design.md) · [任务 API](./low-level-jobs.md) · [本地 worker](./low-level-worker.md)

## 部署边界

| 位置 | 组件 | 必须配置的秘密/连接 |
| --- | --- | --- |
| Vercel | Next.js 页面和 Route Handlers | MySQL `DATABASE_URL`、`ADMIN_API_TOKEN`、邀请码密文密钥、`APP_BASE_URL`、七牛 Kodo AK/SK/bucket/upload URL/private domain |
| 阿里云 RDS | MySQL | 仅允许 Vercel/受信任运维来源访问；启用 TLS、自动备份与最小数据库权限；预览/生产隔离 |
| ComfyUI 本地机器 | Worker + ComfyUI + Tailscale | `WEB_API_BASE_URL`、与云端一致的 `WORKER_TOKEN`、ComfyUI 本地地址与模型文件；API 格式 workflow JSON 由云端后台按版本配置并由 Worker 鉴权读取 |
| 管理员可信设备 | 邀请码 CLI | 私有 `INVITE_SEED`、管理员 API 凭证；明文邀请码仅在交付时输出 |

以上凭证不写入文档、Git 或 `NEXT_PUBLIC_*` 环境变量。自动发货系统以服务器端 Bearer 凭证调用邀请码签发 API；生产 `APP_BASE_URL` 必须使用 HTTPS。首版用 HTTPS 公网入口供浏览器和可信自动发货服务调用云端 API。未来 worker 不开放入站 HTTP 端口；Tailscale 只对授权运维设备开放必要管理端口，使用 grants 做最小授权；ComfyUI 留在回环地址。Vercel 预览环境使用独立数据库和管理员凭证，避免预览环境发出的邀请码进入生产流程。

## 启动与发布顺序

1. 创建私有七牛空间、上传域名、下载域名及对象存储凭证；确认实际区域上传接口、签名链接和 CORS 规则允许部署域名直传。上传/任务配置步骤见 [七牛 runbook](../runbooks/qiniu-storage-and-jobs.md)。
2. 创建阿里云 RDS MySQL 数据库、应用专用账号和 TLS 访问；运行版本化 migration；部署 Next.js 至 Vercel，配置环境变量和公开域名；配置可用性检查。
3. 登录 `/admin` 验证邀请码、用户、分类与风格管理；完成七牛 CORS 和浏览器直传测试。旧任务与历史预设版本应保持可读。
4. 在 ComfyUI 同机配置 `WEB_API_BASE_URL`、`WORKER_TOKEN`、`COMFY_BASE_URL`，用 systemd 等进程管理器启动 `npm run start:worker`；管理员录入 API 格式 workflow 与映射后，按 [ComfyUI Worker runbook](../runbooks/comfyui-worker.md) 验证真实生成。Worker 在线状态监控与过期对象清理仍需另行实现。

## 运维信号

按 `job_id` 关联 Web API 和 worker 日志；记录任务排队时长、执行时长、失败码、过期租约数、worker 最后心跳时间、七牛失败率及数据库连接错误。日志不包含 Cookie、Bearer、七牛签名 URL、原图内容或用户文本。管理员可检索 `execution_uncertain` 任务并人工对账，不能直接修改终态为成功而不核验输出对象。

数据库定期备份并演练恢复；密钥泄露时可分别轮换管理员/worker 凭证并撤销会话。对象清理任务按 [存储生命周期](./low-level-storage.md) 执行；任务清理或修复均需有审计记录。容量不足时先通过用户限额和队列控制背压，后续扩容 worker 前必须重新审视 ComfyUI 并发及租约处理。

## 当前阶段验收清单

- 页面可在手机和桌面完成邀请码兑换、七牛直传、分类/预设选择和任务状态查询；目标部署配置 Worker/ComfyUI 后应验收真实生成结果。
- 七牛输入直传不占用 Vercel 请求体；私有对象和云端 API 均不能跨用户读取。
- `/admin` 可管理邀请码、用户、分类、展示图及版本化私有 workflow 配置；ComfyUI 页提供 Worker 启动说明，但不显示 Worker 在线心跳。
- 升级后检查旧风格/任务仍可读、管理员上传展示图不经过应用服务器、分类/风格启停及筛选生效，非管理员无法读取私有 workflow 或签发展示图上传凭证。
- 邀请码二次兑换失败；重新发码给同一用户保留历史任务；短期链接到期及凭证撤销生效。
- 本机 Worker 能按指定 `presetId@version` 运行 ComfyUI workflow、上传七牛输出并完成任务；prompt 提交状态不确定时不得自动重复生成。
- worker 并发抢占、租约过期、ComfyUI 停机和恢复等项目移至 worker 实现后的验收阶段。
