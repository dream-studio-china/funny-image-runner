# 详细设计：预设与 ComfyUI 工作流

关联：[总体设计](./high-level-design.md) · [任务 API](./low-level-jobs.md) · [本地 worker](./low-level-worker.md)

## 预设契约

预设是存储在 MySQL、由管理员后台维护的版本化定义；首次读取时从内置公开默认值初始化，浏览器只能看到启用预设的公开元数据。管理员可修改名称、简介、心情选项、补充提示、主题颜色和启用状态；已保存字段递增 `version`。一个预设包含 `id`、`version`、名称、简介、是否可用、允许的补充字段及校验约束（长度、枚举、必填、默认值）；worker 私有定义另外包含 API workflow JSON、输入图像节点和输出图像节点 ID、固定参数及公开字段到节点输入的映射。

公开预设字段由云端 MySQL API 提供；worker 以相同 `id@version` 注册私有 workflow 映射。发布前使用共享清单/类型约束检查两侧的 `id@version` 与字段定义一致；云端任务记录固定版本，worker 只执行已支持的版本，未知版本不得降级到另一个 workflow。禁用预设不影响已创建任务的历史版本；旧版本工作流需保留到未完成任务清空。

示意定义（节点 ID 仅为示例，接入时须根据实际 API 导出替换）：

```ts
type PublicPreset = {
  id: string; version: number; name: string; enabled: boolean;
  fields: Array<{ key: string; kind: 'text' | 'enum'; required: boolean;
    maxLength?: number; options?: string[] }>;
};
type WorkerPreset = {
  public: PublicPreset;
  workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  imageInput: { nodeId: string; inputName: 'image' };
  outputNodeIds: string[];
  fieldMappings: Record<string, { nodeId: string; inputName: string }>;
};
```

## 生成时验证

`GET /api/presets` 仅返回启用预设公开字段。管理员在 `/admin` 编辑现有预设时，服务端白名单校验并递增版本；`POST /api/jobs` 服务端按当前公开 schema 校验并规范化用户值，拒绝未知字段、超长文本、非法选项或被禁用预设；在任务中持久化 `preset_id`、`preset_version` 和规范化参数。用户不能提交 workflow JSON、节点 ID、模型路径或任意 ComfyUI 参数。worker 收到任务后再次校验版本与字段，在**每次任务**中深拷贝原始 workflow，先设置已经上传至 ComfyUI 的输入文件名，再将经过校验的字段写到映射节点；不复用已经改写过的对象。

## 工作流准备与检查

目前只有界面工作流。先从 ComfyUI 导出 **API 格式** JSON，记录对应的 ComfyUI 版本、自定义节点及模型；以真实输入图片手工调用 `/upload/image`、`/prompt`、`/history/{prompt_id}`、`/view`，确认输入图节点、所有用户可变字段与最终 SaveImage 输出节点。启动 worker 时检查每个指定节点和输入名存在、输出节点类型及依赖满足；缺失时将该预设标记为不可领取并报告部署错误，而不是将错误 workflow 发给 ComfyUI。

为避免脚本/模板注入，附加文本只能写入明确允许的字符串输入，不拼接文件路径或节点配置。即使用户填入任意文本，也由运行模型自身处理；预设层仅保证参数边界、长度和节点映射正确。

## 验收条件

未知/禁用版本不能产生任务；多任务不会互相污染 workflow；错误节点映射在启动或预设验证阶段可定位；一个预设的输出只读取声明的输出节点，不把预览图误当成最终结果。
