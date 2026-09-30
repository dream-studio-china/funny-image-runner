# Runbook：ComfyUI 本地 Worker

本仓库包含独立的常驻 Node.js Worker（`npm run start:worker`）及云端 `/api/worker/*` 路由。Worker 在 ComfyUI 同一台机器主动轮询云端队列、向本机 ComfyUI 提交 API workflow，并使用云端签发的短时链接读写七牛私有空间。ComfyUI 不应开放公网端口。

## 前置条件

- 已应用最新数据库 migrations、部署包含 `/api/worker/*` 的应用版本，`GET /api/health` 正常。
- 已配置七牛 Kodo 私有空间和应用端 Qiniu AK/SK；Worker 本身不需要知道七牛 AK/SK。
- 已在本机安装并启动 ComfyUI，实际 API 地址例如 `http://127.0.0.1:8188`。
- 管理员已在 `/admin` 的「预设目录」为要执行的风格填写 ComfyUI **API 格式** workflow、提示词、节点映射及附加 JSON，并保存为新版本。旧任务仍引用创建任务时的历史版本。

## 配置密钥与环境

生成一个高熵 Worker bearer secret（例如 `openssl rand -hex 32`），将**同一个值**设置为：

1. 云端/Vercel 服务端环境变量 `WORKER_TOKEN`；
2. ComfyUI 主机运行 Worker 时的环境变量 `WORKER_TOKEN`。

另外在 Worker 进程环境配置：

| 变量 | 必需 | 示例 / 说明 |
| --- | --- | --- |
| `WEB_API_BASE_URL` | 是 | 已部署应用的 HTTPS 根地址，不带 `/api` 后缀 |
| `WORKER_TOKEN` | 是 | 与云端环境变量完全相同的 bearer secret |
| `COMFY_BASE_URL` | 否 | 默认 `http://127.0.0.1:8188`；不要使用公网地址 |
| `WORKER_POLL_INTERVAL_MS` | 否 | 空队列轮询间隔，默认 4000ms |

Worker 脚本从操作系统环境读取变量；以 systemd、容器 secret 或受限权限环境文件提供它们。不要把真实 secret 放入 Git、网页 `NEXT_PUBLIC_*` 变量或日志。轮换 `WORKER_TOKEN` 时同时更新云端和本机，并重启 Worker。

## 配置和验证风格 workflow

ComfyUI 导出节点式 **API 格式 JSON** 后，在后台 Workflow 配置弹窗中粘贴 `workflow`。`nodeMapping` 必须引用该 JSON 中真实存在的节点与输入名。对 Qwen Image 2.1 示例 workflow，可按下面的 ID 配置（如重新导出后节点 ID 改变，需要同步更新）：

```json
{
  "inputImage": { "nodeId": "470", "inputName": "image" },
  "prompt": { "nodeId": "459:474", "inputName": "prompt" },
  "negativePrompt": { "nodeId": "459:474", "inputName": "negative_prompt" },
  "additional": {
    "steps": { "nodeId": "459:458", "inputName": "steps" }
  },
  "outputNodeIds": ["461"]
}
```

其中 `470` 是输入 LoadImage，`459:474` 是 Qwen 文本编码节点，`459:458` 是 KSampler，`461` 是最终 SaveImageAdvanced 输出；不要将 PreviewImage（`480`）当作最终结果。`inputImage` 与 `outputNodeIds` 是必需的；`additional` 的每个映射键对应风格 additional JSON 中的一个固定参数。预设 prompt 和 negative prompt 非空时会覆盖 workflow 中相应字段；留空则保留 workflow 默认文本。提示词字符串支持 `{{mood}}` 和 `{{note}}` 替换；未提供参数时替换为空字符串。静态校验通过不保证本机模型、自定义节点与真实图像尺寸都兼容，须在 ComfyUI 本机验证后再启用生产使用。

## 启动 Worker

在仓库 Worker 主机安装生产依赖并设置好上述环境变量，然后运行：

```bash
npm run start:worker
```

使用 systemd 等进程管理器配置开机启动、异常重启、资源限制与日志轮转。日志仅记录 job ID、执行阶段和错误码；不要记录签名下载 URL、token、workflow 内容、prompt、用户备注或图像字节。Worker 收到 `SIGINT`/`SIGTERM` 后停止领取，并中止当前 HTTP 操作。

## 端到端验证与故障恢复

1. 在 ComfyUI 主机确认 `curl --fail http://127.0.0.1:8188/system_stats` 正常；从公网不能访问 ComfyUI 端口。
2. 启动 Worker，观察无任务时以配置间隔轮询；确认错误日志中没有 bearer 或签名链接。
3. 用户选取已经设置可执行 workflow 的预设并创建任务；后台状态应先变为 `running`，随后成功时成为 `succeeded`，并通过用户/后台任务详情查看七牛结果。
4. 若 Worker 在提交 ComfyUI 请求前崩溃，过期租约可被再次领取；若云端已记录实际 `prompt_id`，新 Worker 先检查 `/history/{prompt_id}` 和 `/queue` 后恢复处理，不重复提交。
5. 若请求可能已到达 ComfyUI、但实际 ID 尚未持久化，队列任务会以 `execution_uncertain` 失败，而不是自动重放。先在 ComfyUI 队列/history 人工核实是否已执行，再由用户创建新任务；不要直接重置失败任务为 queued。
6. 明确 ComfyUI 错误由 Worker 上报为失败；检查预设历史版本、节点映射、模型/节点插件、Worker 至 ComfyUI 连通性及七牛对象写入。

当前后台尚未上报 Worker 在线心跳/健康状态；请以 Worker 进程状态、ComfyUI 本机健康接口及任务状态为准。Worker 不能连接期间任务保留在队列中；停止 Worker 不会向公网开放或自动停止 ComfyUI。
