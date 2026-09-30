# 运维操作手册

面向管理员/运维人员的可执行步骤。当前已实现 MySQL、邀请和管理员后台、七牛直传及任务队列 API；ComfyUI worker 和实际图像生成仍未接入。

| Runbook | 用途 |
| --- | --- |
| [本地 MySQL 与服务端配置](./local-mysql-and-auth.md) | 配置 `.env.local`、初始化 MySQL、应用 migration、确认健康状态 |
| [后台管理控制台](./admin-console.md) | 登录后台，签发/撤销邀请码、管理用户和预设，了解 ComfyUI 预留区 |
| [签发邀请码链接](./issue-invitation-links.md) | 为管理员指定的用户标识生成、导入并安全交付一次性邀请链接 |
| [七牛直传与任务 API](./qiniu-storage-and-jobs.md) | 配置七牛私有空间和 CORS，上传图片并验证队列任务 API |

架构与接口约定见 [`../design/`](../design/README.md)。
