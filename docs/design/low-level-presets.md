# 详细设计：分类、风格与 ComfyUI 工作流

关联：[总体设计](./high-level-design.md) · [图片存储](./low-level-storage.md) · [任务 API](./low-level-jobs.md) · [本地 worker](./low-level-worker.md)

> **实现状态：**分类/风格管理、展示图直传、版本化私有 workflow/prompt/additional 配置和后台弹窗已实现；本地 Worker 程序及云端 Worker API 已接入。真实生成依赖部署并启动 Worker、可达的 ComfyUI、兼容模型/节点和可执行的每个风格 workflow。

## 数据模型与迁移

- `preset_categories`：不可复用的稳定 `id`（slug/UUID）、名称、简介、封面图片资产 ID、排序值、`enabled`、创建/更新时间。分类仅由管理员维护；同一分类下可有多个风格。
- `workflow_configs`：独立的可复用 workflow 配置目录，包含稳定 `id`、名称、当前 `version`、API 格式 workflow JSON、输入/提示词/additional/输出节点映射、启停状态及更新时间。仅管理员可创建/修改；编辑 workflow 或映射递增配置版本。
- `presets`：保留现有 `id`、`version` 与公开展示字段，新增必填 `category_id` 外键、封面图片资产 ID；保留现有 `/art/*.svg` 路径作为迁移后仍可显示的旧封面。新建风格须选择有效分类，不能引用不存在的分类或伪造图片地址。
- `preset_versions`：以 `(preset_id, version)` 唯一存储**不可变**的预设版本快照，包括所选 `workflow_config_id@workflow_config_version`、从该 workflow 配置复制的 API 格式 workflow JSON/节点映射，以及该预设的心情选项/参数校验规则、正向 prompt、negative prompt 和 additional JSON。预设选择 Workflow 时采用该配置的当前版本；每次保存预设时将实际配置快照复制到版本记录。以后编辑 workflow 配置不会改写已保存的预设版本或排队任务。
- `display_images`：管理员上传的图片元数据（`id`、私有七牛 `object_key`、MIME、大小、创建时间及状态）。分类与风格只保存已核验的资产 ID，不保存签名 URL；一个资产可被引用时不能作为过期孤儿清理。

迁移顺序：创建分类、展示图、workflow 配置表及版本引用列；建立一个默认分类并将现有四个风格归入其中；保留已有 `preset_versions.workflow` 历史快照，旧版无配置的风格保持**未配置**，不能伪造可执行 workflow；再将 `category_id` 设为非空。不得修改已有风格 ID、历史任务的 `preset_id@version` 或用户选择记录。未配置 workflow 的旧版本任务须报告可诊断错误，不得自动使用新版本运行。

不提供删除已有分类/风格的首版操作：可停用；若分类已有关联风格，不可删除或改写历史引用。分类停用时旗下风格不再对用户开放，但历史任务仍可查看；后台保留两者的完整记录。可编辑排序和分类归属，风格归属变更只影响公开展示，不改变历史任务参数与 workflow 快照。

## 管理后台交互及 API

`/admin` 内的「分类目录」「预设目录」「Workflow 配置」是不同管理视图，不改变 URL。Workflow 配置视图通过弹窗维护可复用 API 格式 JSON 与节点映射；预设弹窗只选择一个已建 workflow 配置，并单独维护正向/负向 prompt 和 additional JSON。保存预设时固定所选 workflow 版本。分类、风格均通过弹窗创建/修改；列表显示封面、所属关系、启用状态和操作入口。风格弹窗还包含公开字段（名称、副标题、简介、心情选项、提示文案、颜色等）、分类与封面。

- **Workflow 配置**：管理员在单独的 Workflow 配置视图粘贴 ComfyUI **API 格式** JSON（节点 ID → `{class_type, inputs}`），不是带节点坐标的 UI 导出。为该 config 配置输入图/输出节点映射以及可选的 prompt/additional 节点目标；保存时检查节点和输入存在。workflow 编辑会递增当前配置版本。
- **正向/负向 prompt**：属于预设，可填写固定文本或含 `{{mood}}`、`{{note}}` 的模板；预设选择的 Workflow 映射提供对应节点目标。留空则保留 API workflow JSON 中原有 prompt。
- **Additional JSON**：管理员填写 JSON 对象，服务端限制深度、大小和允许的 JSON 值；其键值作为该版本的固定配置由 worker 使用，不由浏览器提交或修改。若需要修改 workflow 节点输入，显式记录允许的目标节点/输入映射，禁止用任意路径覆盖输入文件名、模型文件路径或内部执行配置。

写接口：分类与预设接口如上；workflow 配置用 `GET/POST /api/admin/workflows`、`PATCH /api/admin/workflows/{id}`。所有写请求要求有效管理员会话并校验同源，服务端逐字段校验，不能以整个 JSON 请求直接覆盖数据库行。workflow config 编辑若改变 workflow/节点映射则递增配置版本；预设创建/更新时锁定选择的 workflow config 当前版本并在同一事务内写入预设的 `preset_versions` 快照。失败时不得产生半写入的版本或失效封面引用。

如果管理员暂未填 workflow，可以保存草稿风格，但**不可作为可创建真实任务的启用风格**。现有内置风格及其演示流程在升级时仍可展示；进入真实生成前必须补齐可执行的 workflow/映射并发布新版本。分类和风格的启停分别控制首页可见性，不影响先前排队任务对历史版本的读取。

## 用户侧公开契约

`GET /api/presets` 返回启用分类、其启用风格及**公开**字段，分类和风格含可展示封面链接；`categoryId` 随风格返回。前台展示分类封面及名称，选中分类后仅显示所属风格；切换分类时，若此前选择的风格不在该分类，应自动选中当前分类中的第一个可用风格并重置心情。没有可用风格的分类不展示可选入口。首次迁移的内置 SVG 可继续作为展示回退，不再限制管理员新封面为 `/art/*.svg`。

公开响应及页面代码绝不包含 workflow JSON、prompt、negative prompt、additional JSON、节点映射、七牛对象 key 或管理员凭证。私有封面链接有有效期；在用户长时间停留页面后应重新向公开 API 获取新链接，避免失效缩略图。预设启停及分类归属只影响后续选择，不剥夺已有任务的归属与历史结果。对于未配置 workflow 的可见演示风格，真实任务创建必须拒绝不可执行版本，并在界面说明。

## 生成与版本约束

`POST /api/jobs` 只接受 `uploadId`、启用的风格 ID、已公布的白名单参数（目前为 `mood`、最多 120 字的 `note`）及幂等键；不接受客户端传入的 workflow、prompt、additional 参数、分类 ID 或七牛 URL。服务端使用事务内的当前版本与字段约束校验后，将 `preset_id@version` 和规范化用户参数固定到任务；后续管理员编辑不能改变排队任务的执行配置。

未来 worker 通过受保护的 worker API 按任务的 `preset_id@version` 读取**确切的历史配置**；不能改用风格最新版本。每次任务深拷贝 workflow，写入已上传到 ComfyUI 的输入文件名和经过验证的用户字段，并应用该版本受控的 prompt/negative prompt/additional 映射；不允许客户端文本直接插入模型路径、文件名或 JSON 结构。worker 对节点类型、输入名、模型及自定义节点依赖做运行前校验；缺失版本或无效映射报明确错误，不降级或静默换 workflow。管理员保存 JSON 不等于已接入或已验证真实 ComfyUI 执行。

## 验收条件

迁移后四个旧风格和既有任务仍可查看；管理员能创建/编辑分类与风格、上传并更换封面、收到有用的 JSON 校验错误；普通用户只看到启用分类与风格且筛选正确；无权用户无法读私有配置/原始对象 key。一个任务入队后修改风格，worker 仍能按旧版本读取原配置；未知/未配置的版本不得借用新 workflow 生成。
