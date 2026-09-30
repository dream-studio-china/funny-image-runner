# Runbook：七牛直传与任务 API

本 runbook 配置七牛 Kodo 私有空间，并验证浏览器直传和 MySQL 队列任务。要执行真实 ComfyUI 生成，还需按[本机 Worker runbook](./comfyui-worker.md)配置并启动 Worker；Worker 离线时任务仍会留在 `queued`。

## 前置条件

- 已按 [本地 MySQL runbook](./local-mysql-and-auth.md) 应用 migrations，`GET /api/health` 返回数据库正常。
- 已有有效用户会话（邀请码兑换完成），正在本地运行应用或已部署目标站点。
- 七牛 Kodo 已创建**私有空间**，完成 HTTPS 下载域名绑定；凭证只配置在服务端，切勿放入 `NEXT_PUBLIC_*` 变量、浏览器代码或发给用户。

## 1. 配置七牛服务端变量

在 `.env.local` 或部署环境变量设置：

| 变量 | 说明 |
| --- | --- |
| `QINIU_ACCESS_KEY` | 七牛 AccessKey，服务端使用 |
| `QINIU_SECRET_KEY` | 七牛 SecretKey，服务端使用，严格保密 |
| `QINIU_BUCKET` | 私有空间名称 |
| `QINIU_UPLOAD_URL` | 与空间区域对应的 HTTPS 上传 endpoint |
| `QINIU_PRIVATE_DOMAIN` | 该私有空间的 HTTPS 下载域名，不带路径 |

常见区域上传 endpoint：

| 区域 | `QINIU_UPLOAD_URL` |
| --- | --- |
| 华东 z0 | `https://up.qiniup.com` |
| 华北 z1 | `https://up-z1.qiniup.com` |
| 华南 z2 | `https://up-z2.qiniup.com` |
| 北美 na0 | `https://up-na0.qiniup.com` |
| 新加坡 as0 | `https://up-as0.qiniup.com` |

按七牛控制台显示的实际 bucket region 选择 endpoint；不要猜测区域。`QINIU_PRIVATE_DOMAIN` 应是已绑定到该空间且使用 HTTPS 的下载域名，例如 `https://images.example.com`。本地开发通常访问 RDS 和七牛需要相应网络权限；配置变更后重启 Next.js。

## 2. 配置七牛 CORS

因为图片由浏览器直接上传到七牛，需在 bucket CORS 规则中允许实际网站 origin：

- Origins：本地测试 `http://localhost:3000`，生产填写正式站点 origin；不要无条件开放 `*`。
- Methods：`POST`、`OPTIONS`。
- Allowed headers：至少包含 `Content-Type`；若控制台要求，可添加 `Origin`。
- Expose headers：按调试需要暴露 `ETag`。

CORS 只允许浏览器按规则发请求，不代替上传 token 的权限限制。服务端签发的 token 限定单个随机 key、单次写入、允许的 MIME 和最多 20 MiB；AK/SK 不发给浏览器。上传后对象是否存在、大小与 MIME 是否匹配由服务端通过 Kodo stat 再次核验。

## 3. 检查配置与登录

重启应用后访问：

```bash
curl --fail --silent --show-error http://localhost:3000/api/health
```

确认用户已兑换邀请码；`GET /api/auth/me` 应返回用户标识。没有会话时 `/api/uploads` 和任务接口返回 `401 unauthorized`。

## 4. 浏览器端到端上传并创建任务

1. 以已登录用户打开创作页面，选择 JPEG、PNG 或 WebP；原始图片字节大小不设上限（实际受浏览器可解码能力限制）。
2. 浏览器端自动处理图片：超过 2,000,000 像素时等比例缩小到不超过 2,000,000 像素并转为 JPEG；像素未超限但文件大于 20 MiB 时保留尺寸、转为 JPEG 压缩。处理后的上传文件不得超过 20 MiB。
3. 选择预设，心情必选，补充文本最多 120 字。
4. 点击“上传并创建任务”。客户端按如下顺序执行：
   - `POST /api/uploads` 请求单 key 上传凭证；
   - 浏览器将 multipart 文件内容直传 `QINIU_UPLOAD_URL`；
   - `POST /api/jobs` 提交 upload ID、preset、白名单参数和幂等 UUID；
   - 页面查看 `GET /api/jobs/{id}` 状态。
5. 收到任务已排队表示图片处理、直传和任务持久化已完成，**不代表已生成**。Worker 在线且预设版本已配置可执行 workflow 后才会开始生成。

页面 API 调用示例（须使用有效的用户 Cookie；实际测试建议直接从登录浏览器操作，避免手动复制会话令牌）：

```http
POST /api/uploads
Content-Type: application/json
Cookie: <user-session-cookie>

{"contentType":"image/jpeg","size":123456}
```

创建任务的 JSON 形状：

```json
{
  "uploadId": "<POST /api/uploads 返回的 ID>",
  "presetId": "cloud-nine",
  "parameters": { "mood": "梦幻", "note": "一颗漂浮的小星球" },
  "idempotencyKey": "<本次提交生成的 UUID>"
}
```

上传对象 key、签名 URL 或七牛 token 不可由用户自行指定。`idempotencyKey` 对同一次提交重试必须保持不变；新一轮生成使用新的 UUID。当前限制每位用户最多一个 `queued`/`running` 任务，且每天最多创建 10 个任务。已消费的上传不能再次用于新任务。

## 5. 验证任务读取权限

```http
GET /api/jobs
Cookie: <user-session-cookie>
```

响应只包含当前用户任务，不包含对象 key、上传凭证或其他用户数据。用 `GET /api/jobs/{id}` 查询单项状态。伪造或其他用户的任务 ID 应返回 `404`。任务只有在 worker 成功回报输出后才会变成 `succeeded`；结果 API `GET /api/jobs/{id}/result` 仅对本人成功任务签发约 5 分钟有效的私有下载链接。当前尚无 worker，因此结果 API 还不能返回真实生成图。

## 常见问题

| 现象 / 错误 | 检查方向 |
| --- | --- |
| `/api/uploads` 返回 `503 storage_unavailable` | 检查 AccessKey、SecretKey、bucket、上传 endpoint 和私有下载域名是否都已服务端配置；查看服务端日志，勿打印密钥 |
| 浏览器上传报 CORS / Network Error | 核对七牛 bucket CORS 是否包含当前 origin、POST/OPTIONS、HTTPS endpoint；检查 region endpoint 是否匹配 |
| `/api/jobs` 返回 `422 upload_not_found_in_storage` | 确认浏览器上传请求确实成功且 key/token 没有被重复覆盖；等待服务端检查日志 |
| `/api/jobs` 返回 `422 upload_object_mismatch` | 声明大小、Kodo stat 大小或 MIME 不匹配；使用支持的真实图片文件重试 |
| 原图很大或像素很多 | 上传前在浏览器自动缩放/转 JPEG；不会把原始图片字节发给 Next.js。若浏览器无法解码（设备内存不足或格式损坏），换用普通 JPEG/PNG/WebP 图片 |
| `429 active_job_limit` | 该用户已有未完成任务；检查 Worker 是否在线并正在处理队列 |
| 任务长时间显示 `queued` | 确认本机 Worker 正在运行、`WORKER_TOKEN` 与云端一致、网络可达；确认该预设的当前版本 workflow 已启用且 ComfyUI 本机可用 |

## 当前不支持

对象生命周期清理、上传过期记录/孤儿文件定期清理及后台 Worker 在线健康监控仍待实现。测试时避免上传隐私或不必要的大文件，正式开放前需要落实定期清理和保留期限。
