# 运维操作手册

面向管理员/运维人员的可执行步骤。已实现 MySQL、邀请和管理员后台、七牛直传、任务队列 API、ComfyUI Worker API 与本机 Worker 程序。实际生成需在 ComfyUI 主机配置密钥、workflow、模型并运行 Worker。

| Runbook | 用途 |
| --- | --- |
| [本地 MySQL 与服务端配置](./local-mysql-and-auth.md) | 配置 `.env.local`、初始化 MySQL、应用 migration、确认健康状态 |
| [后台管理控制台](./admin-console.md) | 登录后台，签发/撤销邀请码、管理用户、分类和预设 |
| [签发登录链接](./issue-invitation-links.md) | 签发、交付、重复登录和撤销邀请链接 |
| [七牛直传与任务 API](./qiniu-storage-and-jobs.md) | 配置七牛私有空间和 CORS，上传图片并验证队列任务 API |
| [ComfyUI 本地 Worker](./comfyui-worker.md) | 配置 Worker 密钥、ComfyUI API workflow、启动 Worker 和排查任务 |

架构与接口约定见 [`../design/`](../design/README.md)。
