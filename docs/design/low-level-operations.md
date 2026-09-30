# 详细设计：部署、运维与验收

关联：[总体设计](./high-level-design.md) · [任务 API](./low-level-jobs.md) · [本地 worker](./low-level-worker.md)

## 部署边界

| 位置 | 组件 | 必须配置的秘密/连接 |
| --- | --- | --- |
| Vercel | Next.js 页面和 Route Handlers | MySQL `DATABASE_URL`、七牛 AK/SK 与空间/区域/域名、管理员 API 凭证、worker API 凭证、会话 Cookie 配置 |
| 阿里云 RDS | MySQL | 仅允许 Vercel/受信任运维来源访问；启用 TLS、自动备份与最小数据库权限；预览/生产隔离 |
| 本地机器 | worker + ComfyUI + Tailscale | `WEB_API_BASE_URL`、worker API 凭证、ComfyUI 本地地址、工作流 JSON 与模型文件 |
| 管理员可信设备 | 邀请码 CLI | 私有 `INVITE_SEED`、管理员 API 凭证；明文邀请码仅在交付时输出 |

以上凭证不写入文档、Git 或 `NEXT_PUBLIC_*` 环境变量。首版用 HTTPS 公网入口仅供浏览器和主动外连的 worker 调用云端 API。worker 不开放入站 HTTP 端口；Tailscale 只对授权运维设备开放必要管理端口，使用 grants 做最小授权；ComfyUI 留在回环地址。Vercel 预览环境使用独立数据库、七牛对象前缀和 worker 凭证，避免预览任务流入生产 GPU。

## 启动与发布顺序

1. 创建私有七牛空间、上传域名、下载域名及对象存储凭证；确认实际区域上传接口、签名链接和跨域规则允许部署域名直传。
2. 创建阿里云 RDS MySQL 数据库、应用专用账号和 TLS 访问；运行版本化 migration；部署 Next.js 至 Vercel，配置环境变量和公开域名；配置可用性检查。
3. 在同机安装并启动 ComfyUI，导出 API workflow，记录模型/自定义节点版本；配置 worker 的系统服务（系统启动自启、异常重启、受限账户和日志轮转）。
4. 将首批预设公开定义随 Web 部署、私有工作流随 worker 部署，核对双方版本；启动 worker 并检查其到云端 HTTPS、七牛上传/下载以及 `127.0.0.1:8188` 的连通性；用测试邀请码完成端到端验证。

## 运维信号

按 `job_id` 关联 Web API 和 worker 日志；记录任务排队时长、执行时长、失败码、过期租约数、worker 最后心跳时间、七牛失败率及数据库连接错误。日志不包含 Cookie、Bearer、七牛签名 URL、原图内容或用户文本。管理员可检索 `execution_uncertain` 任务并人工对账，不能直接修改终态为成功而不核验输出对象。

数据库定期备份并演练恢复；密钥泄露时可分别轮换管理员/worker 凭证并撤销会话。对象清理任务按 [存储生命周期](./low-level-storage.md) 执行；任务清理或修复均需有审计记录。容量不足时先通过用户限额和队列控制背压，后续扩容 worker 前必须重新审视 ComfyUI 并发及租约处理。

## 发布验收清单

- 页面可在手机和桌面完成邀请码兑换、上传、预设选择、状态查询、查看/下载结果。
- 七牛输入直传不占用 Vercel 请求体；私有对象和云端 API 均不能跨用户读取。
- 真实 ComfyUI API 格式工作流产出与预设映射一致；worker 离线时任务仍可查询，恢复后继续。
- 邀请码二次兑换失败；重新发码给同一用户保留历史任务；短期链接到期及凭证撤销生效。
- 并发提交、两 worker 抢占测试、租约过期、ComfyUI 停机、七牛失败、网络断开等路径有可解释的任务终态或待对账信号。
