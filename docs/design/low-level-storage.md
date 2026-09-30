# 详细设计：七牛图片存储

关联：[总体设计](./high-level-design.md) · [分类与风格](./low-level-presets.md) · [任务 API](./low-level-jobs.md) · [本地 worker](./low-level-worker.md)

## 对象命名与权限

使用七牛**私有空间**；输入 `inputs/{userId}/{uploadId}`，输出 `outputs/{jobId}/{index}`。服务端生成不可预测的 `uploadId`/`jobId`，不使用客户端原文件名作为对象路径。对象元数据在数据库记录 `owner_user_id`、`key`、声明的大小/类型、上传到期时间和消费状态；只通过已登录用户的记录判定所有权，不依赖对象 key 字符串的前缀校验。

只接收 JPEG/PNG/WebP 原图，不限制用户选择的原始文件字节大小。浏览器读取图像尺寸；超过 2,000,000 像素时等比例缩小到不超过 2,000,000 像素并转为 JPEG，通过逐步降低质量确保处理后的文件不超过七牛上传凭证的 20 MiB 上限。像素数未超限但原文件大于 20 MiB 时，也会转为 JPEG 压缩但保留原尺寸。2M 像素以内且小于 20 MiB 的图片保留原格式。处理后的 MIME、大小由 API 和 Kodo stat 再校验；未来 worker 仍应解码并检查图片内容和尺寸，不能只信任扩展名或浏览器声明。

## 上传协议

1. `POST /api/uploads`：用户会话，提交 `{contentType, size}`；服务端检查类型、大小与配额，生成 `uploadId`、唯一 `key`，创建未确认上传记录；返回 `{uploadId, key, uploadUrl, uploadToken, expiresAt}`。上传凭证绑定单个 key、文件大小/类型限制和短 TTL（建议 10 分钟）；七牛 AK/SK 不发给浏览器。
2. 浏览器按七牛当前区域的上传域名和协议直传字节。上传完成只得到客户端可见的返回信息，不能视为服务端已确认。
3. `POST /api/jobs` 接收 `uploadId`（不直接接收任意 key）；服务端查询归属、向七牛核验对象确实存在、大小/类型符合约束，将上传记录原子标记为已消费并创建任务。一个输入对象只创建一个任务；HTTP 重试通过任务幂等键返回原任务，参见 [任务 API](./low-level-jobs.md)。

服务端使用 Node.js crypto 按七牛 Kodo 协议签发上传凭证、授权对象 stat 请求并生成私有下载签名链接；`QINIU_ACCESS_KEY`、`QINIU_SECRET_KEY`、`QINIU_BUCKET`、`QINIU_UPLOAD_URL`、`QINIU_PRIVATE_DOMAIN` 仅存服务端环境。原图不经过 Vercel 函数请求体。上传凭证绑定单 key、十分钟 TTL、`insertOnly`、处理后文件 20 MiB 限制及 JPEG/PNG/WebP MIME 限制，不能让后续上传更改已经验证过的对象。用户创建任务时服务端重新查询 Kodo stat 核对大小和 MIME。若七牛的某项策略不能强制真实内容约束，以未来 worker 的图片解码检查为最终保障。

用户浏览器使用 multipart/form-data 直接 POST 到所配置上传 endpoint，字段为 `token`、`key`、`file`。七牛 bucket CORS 必须允许本地和生产站点的准确 origin、POST/OPTIONS；不要将 AK/SK 交给浏览器。

## 分类与风格展示图（目标设计，尚未实现）

管理员在分类/风格编辑弹窗选择 JPEG/PNG/WebP 封面（建议压缩后的单文件不超过 5 MiB）。单独的管理员图片接口要求管理员会话和同源校验，签发绑定唯一 `display/{assetId}` key、限定 MIME/大小、`insertOnly` 和短 TTL 的七牛直传凭证；管理员浏览器把文件**直传七牛**，不经 Vercel 图片请求体。上传成功后调用确认接口，服务端对该 key 做 Kodo stat 校验并将资产记为可引用；分类/风格写接口只接受存在且已确认的资产 ID，不能传任意 URL/key 或复用用户输入图。上传失败或未确认的对象定期清理。

封面及分类图片需要在用户端展示，但空间仍是私有的：数据库只存 `display_images.object_key`/资产 ID，管理员和公开读取接口按数据库引用签发限时 HTTPS 下载 URL，不暴露七牛 AK/SK 或原始 key；分类/风格封面属于公开展示内容，持有签名链接者在有效期内可查看。公开 API 的链接 TTL 应覆盖页面常规停留时间（例如一小时），长时间停留或超时图片加载失败时重新拉取元数据/签名链接；不能把短时 URL 当作永久 `image` 字段写入数据库。页面使用直连七牛的非代理图片加载，避免 Vercel 转发图片字节。旧的 `/art/*.svg` 作为迁移后的静态回退可继续使用。

更换封面仅更新引用，新旧资产可短期并存以兼容在途链接；清理时检查没有任何分类或风格引用再删除旧对象。管理员图片不与用户输入/输出图共用过期和保留规则。

## worker 输入与结果

worker 用 `POST /api/worker/jobs/{id}/input-url` 获取单个输入对象的短期签名下载 URL（建议 5 分钟）；处理超时则重新请求，不缓存长期可用的 URL。结果由 worker 请求 `POST /api/worker/jobs/{id}/output-upload`，取得限定 `outputs/{jobId}/{index}` 的上传凭证，直传七牛；`POST /api/worker/jobs/{id}/complete` 服务端向七牛核验输出对象后才将任务标记成功。

用户用 `GET /api/jobs/{id}/result` 获取自己任务的短期签名下载链接；未成功或非本人均不能获取。页面不保存长效下载链接。回报的输出 key 必须属于所签发的该任务前缀，禁止任意 key 伪造结果。

## 生命周期

未使用的上传占位记录和对应孤儿对象定期清理（建议 24 小时）；失败任务输入及成功任务输入/输出的保留期限由产品配置，删除时先确认任务状态再清理对象及索引。展示图的孤儿资产须另行扫描且不能清理在用封面。清理执行器应是可重复运行的外部定时任务/受保护端点，不依赖单次页面请求。首版上线前明确输入图、输出图各自保留多久，并在 UI 告知用户；未选定期限时不自动删除已确认任务对象。

## 验收条件

不能以他人的 `uploadId` 提交任务；假上传和对象被覆盖不能入队；超过上传限制的文件失败；过期私有链接不可再次直接访问；worker/用户无法通过接口签发任意对象的读写权限。非管理员不能取得展示图上传凭证；管理员也不能将未确认或不属于展示图目录的 key 用作分类/风格封面。
