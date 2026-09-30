# 设计文档索引

本目录描述“邀请制图片预设生成”首版的实现边界。先阅读 [总体设计](./high-level-design.md)，再按组件阅读详细设计。

| 文档 | 负责的设计边界 |
| --- | --- |
| [总体设计](./high-level-design.md) | 目标、架构、数据流、跨组件约束 |
| [身份与邀请码](./low-level-identity.md) | seed 发码、兑换、会话、管理员/worker 鉴权 |
| [预设与工作流](./low-level-presets.md) | 预设契约、表单验证、ComfyUI 节点映射 |
| [图片存储](./low-level-storage.md) | 七牛直传、私有对象、下载与保留策略 |
| [任务与 API](./low-level-jobs.md) | 数据表、HTTP 接口、租约与状态机 |
| [本地 worker](./low-level-worker.md) | 领取任务、ComfyUI 调用、恢复与结果上报 |
| [部署与运行](./low-level-operations.md) | 环境配置、连通性、发布与验证 |

## 已确认的约束

- 前端及云端接口：React + TypeScript + Tailwind CSS + Next.js App Router，部署在 Vercel；不单独使用 Vite。
- 输入先上传七牛；用户选择预设并可填写该预设允许的额外信息。
- ComfyUI 与常驻 worker 在同一台本地机器；Tailscale 用于对该机器的受限远程访问，不作为 Vercel 到 ComfyUI 的必经链路。
- 邀请用户使用；管理员根据私有 seed 生成一次性邀请码，提前指定用户标识。
- 目前只有 ComfyUI 界面工作流；真正接入前需要导出 API 格式 JSON 并确认节点映射。

## 尚待提供的接入材料

七牛存储区域及上传域名、私有下载域名；首批预设及字段规则；对应的 ComfyUI API 格式工作流 JSON、模型和自定义节点依赖。具体供应商、资费和资源配额由部署时选定；本文中的阈值标为“首版默认值”时可通过配置调整。
