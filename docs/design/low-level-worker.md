# 详细设计：同机 worker 与 ComfyUI 接入

关联：[总体设计](./high-level-design.md) · [预设](./low-level-presets.md) · [任务 API](./low-level-jobs.md) · [存储](./low-level-storage.md)

**实现状态：**本文件目前是 worker 的目标设计，不代表仓库已有 worker 程序。云端可创建和查询队列任务；worker、ComfyUI 调用与输出回传需在 API 格式 workflow 确认后实现。

## 进程与依赖

独立于 Vercel 的 TypeScript/Node.js 常驻进程，运行在 ComfyUI 所在机器。配置 `WEB_API_BASE_URL`、`WORKER_TOKEN`、`COMFY_BASE_URL=http://127.0.0.1:8188` 及并发上限；workflow JSON 由管理员在云端后台配置为风格的不可变版本，worker 以 Bearer 凭证读取，不能将凭证或工作流下发给普通浏览器。worker 启动时检查云端 API、ComfyUI `/system_stats`（或其他只读健康接口）；每次领取任务时取该任务精确的 `presetId@version` 工作流及节点映射，检查 ComfyUI 节点/模型依赖。可按版本缓存不可变配置，但不能在新版本发布后覆盖旧缓存；无法访问时退避重试。

`ComfyUI` 默认只监听本机回环接口；如有其他本地调用需求再调整绑定地址。Tailscale 可用于远程运维；当前生成调用不走 tailnet。若 ComfyUI 只接受特殊监听配置，以仅同机可见的代理转发，不开放公网入口。

## 执行步骤

1. 以 worker Bearer 请求 `POST /api/worker/jobs/claim`；空队列建议 3–5 秒加抖动后再轮询。首版串行处理一个任务；领取后启动独立心跳循环。
2. 读任务 `presetId@version`，经受保护接口读取**同一版本**的工作流、正向/负向 prompt、固定 additional JSON 与节点映射；缺失配置立即返回可诊断错误，不得使用最新版本代替。取一次性输入下载链接，下载到受限临时目录，限制下载大小、解码后的像素尺寸及格式。
3. 将图像以 multipart `POST /upload/image` 上传到 ComfyUI `input` 区，取得 ComfyUI 返回的文件名；更新 phase 为 `input_ready`。不要让 workflow 直接读七牛 URL。
4. 深拷贝该版本 API workflow，将返回的图片文件名写入 `LoadImage` 等指定输入节点，将固定正向/负向 prompt、管理员 additional JSON 与经过校验的用户参数分别应用于声明的节点/输入映射；不复用已改写对象。生成稳定 `prompt_id`（UUID）；通过 heartbeat **先持久化** `prompt_id` 与 `prompt_submitting`，再向 `POST /prompt` 提交 `{prompt,client_id,prompt_id}`。
5. 接收提交响应并核对 `prompt_id`；持续用 `/history/{prompt_id}` 检查终态，可选用 `/ws?clientId=...` 加速进度感知，但不能仅依赖 WebSocket 事件判断最终结果。将 phase 更新为 `prompt_submitted`，并持续续租。
6. 从 history 中声明的输出节点读取图片元信息，向 `/view?filename=...&subfolder=...&type=output` 取图；验证内容和尺寸。向云端申请每张输出的限定上传凭证，将结果直传七牛，最后调用 `complete`。清理临时文件。

ComfyUI 使用原生本地服务 API，路径为 `/upload/image`、`/prompt`、`/history/{prompt_id}`、`/view`，不要把 Cloud API 的 `/api/*` 前缀用于本地服务。HTTP 请求设超时，预设任务设最长执行时间；只在 worker 日志里记录 `job_id`、阶段和错误码，不记录原始图像、用户补充文本或签名链接。

后台保存 workflow 只证明 JSON 结构和映射引用能通过静态校验，不能证明本地模型、自定义节点或真实输出可用。生成前必须验证输入/文本/输出节点的期望类型和输入名；不允许 additional JSON 任意覆盖文件路径、模型路径或内部执行配置。历史版本必须保留到引用它的未完成任务清空，且历史任务排查仍可追溯对应版本。

## 重启与不确定提交

- `prompt_id` 未写入时，worker 尚未进入提交步骤；过期租约可重新领取并从输入开始。
- `prompt_id` 已写入时，即使未收到 `/prompt` 响应，先查 `/history/{prompt_id}` 和 ComfyUI 当前队列。找到运行中/已完成任务则继续等待或取结果。查询不到且 ComfyUI/网络不稳定时继续有限期对账；一直无法证明未执行则报告 `execution_uncertain` 并人工复核，**不自动重新提交**。
- 输出已上传、但 `complete` 响应丢失时，按相同结果 key 重试完成接口；服务端以 `(job_id,index)` 和终态幂等处理。过期租约下不得再上传或上报。
- worker 停机期间云端任务保留，重启后按租约恢复；若 ComfyUI 重启丢失内存队列但保留 history，也可以按 `prompt_id` 对账。历史被清空导致无法判断时按不确定执行处理。

租约保护数据库状态，不保证第三方 ComfyUI 提交的严格 exactly-once；上述流程优先避免重复生成，遇不确定状态由人工重建新任务。worker 对七牛和云端失败采用有界指数退避，收到 401/403 立即停止并报警，收到租约 409 停止当前任务且不得继续提交。

## 验收条件

同机真实工作流生成并回传图片；断开云端网络后 worker 不重复提交已记账 prompt；worker 在下载、生成和上传各阶段重启能恢复或进入可诊断失败；错误输出节点和 ComfyUI 参数校验错误均可定位到任务及预设版本。
