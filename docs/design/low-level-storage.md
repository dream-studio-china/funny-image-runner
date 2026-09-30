# 详细设计：七牛图片存储

关联：[总体设计](./high-level-design.md) · [任务 API](./low-level-jobs.md) · [本地 worker](./low-level-worker.md)

## 对象命名与权限

使用七牛**私有空间**；输入 `inputs/{userId}/{uploadId}`，输出 `outputs/{jobId}/{index}`。服务端生成不可预测的 `uploadId`/`jobId`，不使用客户端原文件名作为对象路径。对象元数据在数据库记录 `owner_user_id`、`key`、声明的大小/类型、上传到期时间和消费状态；只通过已登录用户的记录判定所有权，不依赖对象 key 字符串的前缀校验。

默认只接收 JPEG/PNG/WebP（最终以实际 ComfyUI 输入能力为准），首版建议上限每张 20 MiB；在浏览器提示、签发上传策略和服务端确认时分别校验大小/MIME。仅靠扩展名或客户端上报 MIME 不足以验证图片：worker 在解码/提交 ComfyUI 前再次验证内容和尺寸，拒绝不受支持或过大的图。下载七牛对象时仅使用服务端根据已有对象 key 生成的签名链接，拒绝任意用户 URL。

## 上传协议

1. `POST /api/uploads`：用户会话，提交 `{contentType, size}`；服务端检查类型、大小与配额，生成 `uploadId`、唯一 `key`，创建未确认上传记录；返回 `{uploadId, key, uploadUrl, uploadToken, expiresAt}`。上传凭证绑定单个 key、文件大小/类型限制和短 TTL（建议 10 分钟）；七牛 AK/SK 不发给浏览器。
2. 浏览器按七牛当前区域的上传域名和协议直传字节。上传完成只得到客户端可见的返回信息，不能视为服务端已确认。
3. `POST /api/jobs` 接收 `uploadId`（不直接接收任意 key）；服务端查询归属、向七牛核验对象确实存在、大小/类型符合约束，将上传记录原子标记为已消费并创建任务。一个输入对象只创建一个任务；HTTP 重试通过任务幂等键返回原任务，参见 [任务 API](./low-level-jobs.md)。

服务端使用 Node.js crypto 按七牛 Kodo 协议签发上传凭证、授权对象 stat 请求并生成私有下载签名链接；`QINIU_ACCESS_KEY`、`QINIU_SECRET_KEY`、`QINIU_BUCKET`、`QINIU_UPLOAD_URL`、`QINIU_PRIVATE_DOMAIN` 仅存服务端环境。大图不经过 Vercel 函数请求体。上传凭证绑定单 key、十分钟 TTL、`insertOnly`、20 MiB 限制及 JPEG/PNG/WebP MIME 限制，不能让后续上传更改已经验证过的对象。用户创建任务时服务端重新查询 Kodo stat 核对大小和 MIME。若七牛的某项策略不能强制真实内容约束，以未来 worker 的图片解码检查为最终保障。

用户浏览器使用 multipart/form-data 直接 POST 到所配置上传 endpoint，字段为 `token`、`key`、`file`。七牛 bucket CORS 必须允许本地和生产站点的准确 origin、POST/OPTIONS；不要将 AK/SK 交给浏览器。

## worker 输入与结果

worker 用 `POST /api/worker/jobs/{id}/input-url` 获取单个输入对象的短期签名下载 URL（建议 5 分钟）；处理超时则重新请求，不缓存长期可用的 URL。结果由 worker 请求 `POST /api/worker/jobs/{id}/output-upload`，取得限定 `outputs/{jobId}/{index}` 的上传凭证，直传七牛；`POST /api/worker/jobs/{id}/complete` 服务端向七牛核验输出对象后才将任务标记成功。

用户用 `GET /api/jobs/{id}/result` 获取自己任务的短期签名下载链接；未成功或非本人均不能获取。页面不保存长效下载链接。回报的输出 key 必须属于所签发的该任务前缀，禁止任意 key 伪造结果。

## 生命周期

未使用的上传占位记录和对应孤儿对象定期清理（建议 24 小时）；失败任务输入及成功任务输入/输出的保留期限由产品配置，删除时先确认任务状态再清理对象及索引。清理执行器应是可重复运行的外部定时任务/受保护端点，不依赖单次页面请求。首版上线前明确输入图、输出图各自保留多久，并在 UI 告知用户；未选定期限时不自动删除已确认任务对象。

## 验收条件

不能以他人的 `uploadId` 提交任务；假上传和对象被覆盖不能入队；超过上传限制的文件失败；过期私有链接不可再次直接访问；worker/用户无法通过接口签发任意对象的读写权限。
