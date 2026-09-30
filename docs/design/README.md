# 设计文档索引

本目录描述“邀请制图片预设生成”首版的实现边界。先阅读 [总体设计](./high-level-design.md)，再按组件阅读详细设计。

本地数据库及管理员发码步骤见 [运维操作手册](../runbooks/README.md)。

| 文档 | 负责的设计边界 |
| --- | --- |
| [总体设计](./high-level-design.md) | 目标、架构、数据流、跨组件约束 |
| [身份与邀请码](./low-level-identity.md) | seed 发码、兑换、会话、管理员/worker 鉴权 |
| [分类、风格与工作流](./low-level-presets.md) | 分类与版本模型、后台弹窗、公开筛选、私有 JSON 与节点映射 |
| [图片存储](./low-level-storage.md) | 七牛直传、私有对象、下载与保留策略 |
| [任务与 API](./low-level-jobs.md) | 数据表、HTTP 接口、租约与状态机 |
| [本地 worker](./low-level-worker.md) | 领取任务、ComfyUI 调用、恢复与结果上报 |
| [部署与运行](./low-level-operations.md) | 环境配置、连通性、发布与验证 |

## 已确认的约束

- 前端及云端接口：React + TypeScript + Tailwind CSS + Next.js App Router，部署在 Vercel；不单独使用 Vite。
- 输入先上传七牛；用户选择预设并可填写该预设允许的额外信息。
- ComfyUI 与常驻 worker 在同一台本地机器；Tailscale 用于对该机器的受限远程访问，不作为 Vercel 到 ComfyUI 的必经链路。
- 持久化使用阿里云 RDS MySQL，应用层采用 Drizzle ORM + mysql2。
- 邀请制；淘宝自动发货通过管理员 API 幂等签发可重复登录的邀请链接（直到过期或撤销），用户标识可由服务端根据稳定 customerRef 派生。人工/批量补发也支持本地私有 seed CLI。
- `/admin` 管理后台已实现管理员会话、邀请码签发/撤销、用户启停、分类/风格目录和私有配置弹窗；展示图直传七牛，风格保存不可变 workflow 版本。
- 登录用户可直传七牛并创建真实队列任务；独立本地 ComfyUI Worker、Worker API 和输出回传已接入。真实生成还需部署 Worker、设置共享 `WORKER_TOKEN` 并配置可执行 workflow、模型和节点依赖。
- 分类将显示在首页供用户筛选风格；管理员为分类与风格上传展示图并维护风格的不可变工作流版本。用户端不接收或调整私有 workflow/固定 additional JSON。
- 目前只有 ComfyUI 界面工作流；真正接入前需要导出 API 格式 JSON，由管理员在风格弹窗手动配置，并确认节点映射。

## 尚待提供的接入材料

部署时须填入实际七牛区域上传 endpoint、bucket 和 HTTPS 私有下载域名；管理员环境还需设置登录后台和自动发码所需密钥。生成部署还须设置云端及本地一致的 `WORKER_TOKEN`，导入经本机验证的 ComfyUI API 格式 workflow，确认正负提示词/图像/输出节点映射、模型和自定义节点依赖，并运行 `npm run start:worker`。具体资费和资源配额由部署时选定；本文中的阈值标为“首版默认值”时可通过配置调整。
