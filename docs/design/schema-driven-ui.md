# Schema 驱动 UI 引擎（schema-driven UI engine）

> 状态：已实施（2026-10-22）；落地于 `app/src/core/schema/schemaForm.tsx`（引擎）+ `schemaRegistry.ts`（注册器）+ `schemaExamples.ts`（内置示例），详见文末「实施落地」。
> 决策：模块只注册数据契约（schema），框架按控件类型分支渲染控件并内置受控状态；label/helper/选项 用 i18n key；渲染器按类型 switch 分支（增量扩展）；值生命周期由宿主用 initialValues + key 重挂载管理
>
> 本设计把当前薄弱的 schemaForm 升级为基础设施，覆盖：完整类型系统、布局结构、注册器注入、校验、值生命周期、渲染器扩展、i18n 约定。

## 1. 目标

当前 `schemaForm.tsx` 只有 4 种控件（text/number/switch/select）、只能渲染平铺字段列表，且 schema 是模块内联定义的，没有"注册器注入"机制。作为基础设施要解决的：

- **数据契约与渲染分离**：模块只声明 `FieldSchema`，不写 UI 组件；引擎负责把 schema 渲染成控件
- **可扩展控件**：新控件类型 = 加一个类型定义 + 渲染分支（增量式，不碰宿主）
- **可注册注入**：模块在 `init(ctx)` 时向 schema 注册器注册自己的表单 schema，支持插件扩展
- **可表达复杂布局**：分组 / 嵌套 / 数组列表 / 单行多列（设置对话框的"大类→小类"树已是分组雏形，需下沉到引擎）
- **i18n 一致**：label/helper/选项文案用 i18n key（与设置对话框现约定一致），插件注册自己的命名空间文案

## 2. 类型系统

### 2.1 控件字段（FieldSchema 联合）

```ts
/** 字段值类型（基础标量；扩展如 color/vector 等复合类型在宿主层序列化为 string） */
export type FieldValue = string | number | boolean

/** 控件字段公共属性 */
export interface FieldBase {
  key: string                 // 字段唯一 key（表单内）
  labelKey: string            // label 的 i18n key（如 system.settings.field.language）
  helperKey?: string          // helper 的 i18n key
  required?: boolean          // 必填标记（渲染 labelInfo，校验用）
  disabled?: boolean
  defaultValue?: FieldValue   // schema 默认值（initialValues 未提供时用）
  /** 可见性/禁用条件：表达式或函数，值为当前表单 values 快照 */
  visibleWhen?: Condition
  disabledWhen?: Condition
  /** 自定义校验：返回错误文案（raw 或已翻译）；null 表示通过 */
  validate?: (value: FieldValue | undefined, allValues: FormValues) => string | null
}

export interface TextFieldSchema extends FieldBase { type: 'text'; placeholder?: string; multiline?: boolean; rows?: number }
export interface NumberFieldSchema extends FieldBase { type: 'number'; min?: number; max?: number; step?: number; unit?: string }
export interface SwitchFieldSchema extends FieldBase { type: 'switch' }
export interface SelectFieldSchema extends FieldBase { type: 'select'; options: SelectOption[]; allowEmpty?: boolean }
// 预留（随需求增量加，不一次做完）：
// color / vector2 / vector3 / file / enum-multi / slider …
```

- 字段值统一为 `string | number | boolean`，复合类型（颜色、向量）在宿主侧序列化为 string 存值，控件负责解析渲染——保持值协议最简
- `defaultValue` 下沉到 schema：宿主不再需要手写"switch 默认 false、text 默认空串"
- `validate` 支持自定义校验（返回错误文案），与 required/min/max 内置校验并列

### 2.2 条件表达式（Condition）

联动/显隐的轻量声明式表达。第一版支持：

```ts
export interface SingleCondition {
  when: string                 // 依赖字段 key
  eq?: FieldValue              // 值 === eq 时条件成立
  notEq?: FieldValue           // 值 !== notEq 时条件成立
  in?: FieldValue[]            // 值命中集合时条件成立
}
export type Condition = SingleCondition | { and: Condition[] } | { or: Condition[] } | { not: Condition }
```

引擎在渲染时对每个字段求值 `visibleWhen/disabledWhen`（依赖其他字段的值），值变化触发重算。`evalCondition(cond, values)` 递归求值，**不引入表达式字符串解析**（避免复杂度与注入风险），用结构化条件对象。

**语义约定（调用点区分）**：
- `visibleWhen`：条件成立才显示；`undefined`（无条件）恒显示
- `disabledWhen`：条件成立则禁用；`undefined`（无条件）不禁用——**不能用 `evalCondition(undefined)` 直接作为默认**（`evalCondition(undefined)` 返回 true，会误禁用所有无条件字段），调用点必须按 `field.disabledWhen ? evalCondition(...) : false` 区分"无条件"与"条件不成立"

### 2.3 布局结构（LayoutNode）

当前 schemaForm 只渲染平铺 `FieldSchema[]`。升级为**递归布局树**，一个 schema 就是一棵树：

```ts
export interface SchemaNodeBase {
  /** 节点稳定 id（schema 内唯一；patch/插件按它定位编辑节点，见 3.1） */
  id: string
}

export type SchemaNode = FieldNode | GroupNode | ArrayNode

export interface FieldNode extends SchemaNodeBase { kind: 'field'; field: FieldSchema }
export interface GroupNode extends SchemaNodeBase {
  kind: 'group'
  titleKey?: string          // 分组标题（可嵌套）
  /** 单行布局：'horizontal'（默认竖排） */
  layout?: 'vertical' | 'horizontal'
  children: SchemaNode[]
}
export interface ArrayNode {
  kind: 'array'
  /** 数组字段 key（值 = FieldValue[]） */
  key: string
  /** 数组标题 i18n key（无则只显示行列表） */
  titleKey?: string
  /** 行模板字段（决定控件类型与默认值；第一版为标量数组，对象数组留待嵌套值模型扩展） */
  item: FieldSchema
  minItems?: number
  maxItems?: number
  placeholder?: string
}

export type Schema = SchemaNode[]
```

- 设置对话框现有"大类→小类→字段"是 `GroupNode` 嵌套的自然表达（树形导航 + 每小类一页表单）
- `ArrayNode` 支持动态增删行（属性列表、tag 列表等）。**第一版为标量数组**（`item` 单字段、值 = `FieldValue[]`），与扁平值模型自洽；对象数组（多列/嵌套）依赖嵌套路径值模型，留待后续扩展

### 2.4 表单值模型

```ts
/** 表单值：扁平 key → 标量或数组（数组字段 key 存 FieldValue[]） */
export type FormValues = Record<string, FieldValue | FieldValue[]>
```

第一版值模型保持扁平（key 全局唯一），数组字段 key 直接存数组。**不做嵌套对象路径**（`a.b.c`）——嵌套对象语义用 `GroupNode` 表达布局、key 仍扁平，避免值路径解析复杂度。若未来出现真正的嵌套数据（如项目 settings 分域），再引入 path key。

## 3. 注册器（SchemaRegistry）

模块通过注册器注入 schema，支持插件扩展。挂在 `ModuleContext` 上（`module.ts` 的 ctx 增加 `schemas` 注册器）。

```ts
export interface SchemaRegistry {
  /** 注册一个表单 schema 定义 */
  register(def: SchemaDefinition): void
  /** 按 id 取 schema（未注册返回 undefined） */
  get(id: string): SchemaDefinition | undefined
  /** 全部已注册 schema（含插件） */
  list(): SchemaDefinition[]
  unregister(id: string): void
}

export interface SchemaDefinition {
  id: string            // 全局唯一（命名空间风格，如 "system.settings.general.appearance" / "demo.material"）
  titleKey?: string     // schema 标题（对话框标题 / 面板名）
  schema: Schema        // 布局树（SchemaNode[]）
  /** 提交/读取映射（可选）：宿主自定义值与 schema 字段的转换，默认 key 直读 */
  map?: { toForm?: (data: unknown) => FormValues; fromForm?: (values: FormValues) => unknown }
}
```

- 与现有 `ModuleContext` 的注册器（events/commands/i18n）并列，`createCore` 创建并注入
- 系统内置 schema 由对应模块 init 注册；插件（未来）在 init 中 `ctx.schemas.register(...)` 即完成扩展，无需改引擎
- `map` 支持"业务数据 ≠ 表单字段"的场景（如项目 settings 分域对象 ↔ 表单），宿主可注入读写映射

### 3.1 节点稳定 id 与 patch（插件编辑既有 schema）

每个 SchemaNode 硬编码一个稳定 id（`SchemaNodeBase.id`，field/group/array 统一），作为 patch / 插件编辑的定位目标。**区别于字段 key**：key 是值模型的键（表单内唯一），id 是节点本身的稳定标识（schema 内唯一），编辑 schema 时按 id 定位，与字段 key 是否重命名无关。约定：节点 id 用命名空间风格（如 `system.launcher.createProject.type`），在单个 schema 内唯一。

插件通过 `ctx.schemas.patch(schemaId, nodeId, change)` 向已注册 schema 注入变更（就地深合并，消费方 `get` 后即时生效）：

```ts
export type SchemaPatchChange = Record<string, unknown>

patch(schemaId: string, nodeId: string, change: SchemaPatchChange): SchemaNode
```

- **定位**：按 schemaId 查注册定义，递归遍历布局树按 nodeId 匹配节点（group 下钻 children）
- **变更**：深合并到节点（plain object 递归合并，数组/标量直接替换）；编辑字段用 `{ field: {...} }` 包裹，如给 select 加选项 → `{ field: { options: [...] } }`、改分组标题 → `{ titleKey: '...' }`
- **就地生效**：深合并结果写回原节点（`Object.assign` 保引用），SchemaDefinition 被消费方 `get` 引用，变更即时生效，无需通知
- **不引 lodash**：节点 id 定位 + 手写深合并（仅 plain object，数组替换），避免为链式路径引入依赖
- **示例**：给创建项目窗口的 type 选择从 2D/3D 增加 2.5D 选项（见第 9 节落地记录）

## 4. 值生命周期（FormStore 端口）

引擎**不持久化跨实例状态**，读写/订阅统一走 **FormStore 端口**（见 `app/src/core/schema/formStore.ts`）。引擎只依赖 get/set/subscribe，不关心数据存哪、怎么被消费：

```ts
export interface FormStore {
  /** 读当前值（未设返回 undefined；引擎用 schema 默认值兜底） */
  get(key: string): FieldValue | FieldValue[] | undefined
  /** 写值（宿主决定怎么消费：本地 state / 发命令 / 防抖队列）；changedKey 供宿主精准定位 */
  set(key: string, value: FieldValue | FieldValue[], changedKey?: string): void
  /** 订阅值变化（本地 set / 外部推回均触发）；宿主保证不自我成环 */
  subscribe(listener: () => void): () => void
}
```

- **内存适配器**：`createMemoryStore(initialValues?)` —— 非受控/演示用，值存 React 外部对象，set 通知订阅者重渲染
- **设置适配器**（SettingsDialog 内联）：`get` = 本地编辑优先 ?? 后端 cache；`set` = 记本地编辑 + 发 `system.settings:set` 命令；`subscribe` = 订阅 `SETTINGS_CHANGED/LOADED` → 重渲染
- **创建项目适配器**（规划）：本地 state + 确定时提交，值不落 store
- **外部同步 → UI 跟随**：store 变化（subscribe 触发）→ 引擎重渲染 → 重新 `get`。成环防护：设置 adapter 本地 set 发命令 → 后端 SSE 回推 → subscribe 触发 → 重新 get 值相同，React 不重渲染，天然断环
- **跨面板/跨小类值保留**：宿主切换面板时重建 store（设置 adapter 的 `get` 实时读 cache + 本地编辑 ref），无需 `key` 重挂载

```ts
export interface SchemaFormProps {
  schema: Schema
  /** 数据源端口（宿主注入适配器；引擎不关心数据存哪、怎么消费） */
  store: FormStore
  /** 校验错误上报：fieldKey → 错误文案 */
  onValidationChange?: (errors: Record<string, string>) => void
  /** i18n 翻译函数（宿主注入；schema 存 key，渲染时翻译） */
  t: (key: string) => string
}
```

> 注：旧的双模式（value/initialValues/onValuesChange）已由 FormStore 统一替代（2026-10-22 实施）。

> 说明：`onCommit` 未落地（第一版数组增删行直接 `onValuesChange` 提交）；`t` 为必传 prop（schema 存 i18n key，渲染必须翻译）。

## 5. 校验

第一版内置轻量校验（不做完整 JSON Schema）：

- `required`：值为空/undefined 报"必填"（`labelKey` 翻译 + "（必填）"后缀）
- number：`min/max` 越界
- 自定义校验：`validate?: (value, allValues) => string | null`（返回错误文案，已翻译或 raw key）
- 校验结果：`SchemaForm` 通过 `onValidationChange(errors)` 上报（`errors: Record<fieldKey, string>`），宿主可选展示（如设置对话框用 helperText 展示错误）；控件级 `FormGroup` 错误红态展示留待宿主

校验与值分离：`errors: Record<fieldKey, string>`。宿主可选展示（设置对话框用 helperText 展示错误）。

## 6. 渲染器扩展

**双轨扩展**：内置控件走 switch 快速路径 + 增量类型定义；自定义控件类型（type 为统一命名空间 id `<namespace>.<name>`，内置用 `system` 前缀）走**渲染器注册表**（schemaRenderers.ts）——引擎遇到不认识的 type 到注册表查询渲染函数。

```ts
function renderControl(field: FieldSchema, value, ctx: RenderContext) {
  switch (field.type) {
    case 'text': …      // InputGroup / TextArea（multiline）
    case 'number': …    // NumericInput + 单位后缀
    case 'switch': …
    case 'select': …    // HTMLSelect（@blueprintjs/select 未安装，沿用现有约定）
    default:            // 自定义类型：查渲染器注册表（插件 / 框架注册，见 schemaRenderers.ts）
      return ctx.renderers?.get(field.type)?.(field, value, ctx) ?? null
  }
}
```

**控件映射（Blueprint 现状核对）**：
- text → `InputGroup`（multiline → `TextArea`，rows 可配）
- number → `NumericInput`（unit 后缀：控件旁 `<span>`，CSS `lw-schema-number` 布局）
- switch → `Switch`
- select → `Select2`（`@blueprintjs/select`，与其它控件一致的 Popover/Menu 样式、动画、主题；allowEmpty 加空选项；trigger 用 `Button` + `MenuItem` 选项）
- 布局容器 → `FormGroup`（label/helper/labelInfo）；分组标题用 `div.lw-schema-group-title` + CSS（Blueprint v6.21 无 Fieldset 组件，实测核对）

### 6.1 渲染器注册表（自定义控件类型）

**扩展模型**：插件在 `init(ctx)` 时 `ctx.schemaRenderers.register(type, renderer)` 注册自己的控件类型；框架/插件均可注册，无需改引擎。

- 渲染函数格式：`(field, value, ctx) => ReactNode`——输入 schema 字段节点，输出 React 节点；内部事件 / 数据获取由渲染函数自己负责
- 自定义 type 统一命名空间 id `<namespace>.<name>`（可多级，如 `system.store-select`、`plugin.x.y`），内置用 `system` 命名空间；含点的格式与内置字面量（`text`/`number`/`switch`/`select`，均无点）判别不重叠，`FieldSchema` 联合按 type 正常窄化；专用元数据收在 `meta` 字段（`meta?: M` 泛型，插件可定义自己的接口）
- `RenderContext`：values（全表单快照）/ setValue（写当前字段）/ t / disabled / store（FormStore 端口）/ renderers（可查其它类型）
- **元数据联动**：渲染函数可返回内部组件（在组件里 useEffect 拉取 / 订阅外部数据），实现"下拉 options 来自某个 store / 后端"等场景；框架内置示例 `system.store-select`（`schemaBuiltinRenderers.tsx`，meta.loadOptions 数据源函数，同步/异步均可）
- `RenderContext.setValue` 语义：引擎已处理上下文（普通字段写 field.key；数组行内写该行元素），自定义渲染器写其它字段直接用 `store.set(key, v)`

**类型系统**：`CustomFieldSchema<M extends object>`（type 为 `CustomTypeId`，即 `` `${string}.${string}` `` 命名空间模板字面量 + `meta?: M`）；`AnyFieldSchema = FieldSchema`（渲染函数消费的宽松类型）。

> 语义约定：渲染函数是纯函数式声明（不持久化跨实例状态）；需要订阅外部数据时返回一个内部组件（组件内 useEffect / useFormStoreSubscribe）。

## 7. i18n 约定

与设置对话框一致：label/helper/选项都用 **i18n key**，渲染时 `t(key)` 翻译。schema 定义存 key，文案随语言切换实时更新（`useI18n` 的 t 变化触发重渲染）。

- 系统内置：`system.*` 命名空间（systemStrings.ts 聚合）
- 插件：`register(localeId, 插件命名空间, kv)` 注册自己的文案
- `SchemaDefinition.titleKey` 同样为 key

## 8. 与现有代码的关系

| 现有 | 迁移 |
|------|------|
| `schemaForm.tsx` 的 `FieldSchema`/`FormValues`/`SchemaForm` | 升级：labelKey 化、defaultValue 下沉、加布局树/条件/数组/校验；`FieldSchema` 保留兼容别名 |
| `SettingsDialog.tsx` 的 mock `SettingSection[]` | 迁移为 `SchemaDefinition` 树形 schema，经注册器注入；对话框只消费 `ctx.schemas.get(...)` |
| `InspectorPanel.tsx` 占位 | 后续用 schema 引擎渲染对象属性表单（本设计预留，不在此次实施） |
| `ModuleContext` | 增加 `schemas: SchemaRegistry` + `schemaRenderers: SchemaRendererRegistry`（createCore 装配） |

## 9. 实施落地（2026-10-22）

基础引擎完备化已完成，**未动 SettingsDialog 消费方**（保持 mock 数据，避免大爆炸）：

1. `app/src/core/schema/schemaForm.tsx` 升级为完整引擎：labelKey 化（渲染层 `t()` 翻译）、defaultValue 下沉、布局树（group 嵌套 + horizontal/vertical + array 标量数组动态增删行）、条件显隐/禁用（visibleWhen/disabledWhen + `evalCondition`）、number 单位、multiline、required/min/max/validate 校验、受控/非受控双模式、外部 initialValues 内容签名同步
2. 新增 `app/src/core/schema/schemaRegistry.ts`：`SchemaRegistry`（register/get/list/unregister，重复 id 报错）+ `SchemaDefinition`（id/titleKey/schema/map），挂 `ModuleContext.schemas`（module.ts + index.ts createCore 装配）
3. 内置示例 `app/src/core/schema/schemaExamples.ts`（`DEMO_SCHEMA_ID='system.demo.schema'`）注册到注册器（appCore.ts），示例文案入 `app/src/core/i18n/schemaStrings.ts`（system.schema.* 引擎文案 + system.demo.* 示例文案，systemStrings.ts 聚合）；`InspectorPanel.tsx` 改为验证载体（从 `core.schemas.get` 取用渲染）
4. 浏览器实测验证全部通过：
   - 渲染：分组（基本信息/高级参数/标签列表）、select/textarea（多行）/number 单位（px）/switch/text、数组行列表 + 添加行按钮
   - 条件联动：type 切到 material → shader 字段出现（切回 sprite/scene 消失）
   - 条件禁用：enabled 关 → target 字段 disabled（on 时恢复可编辑）
   - 数组增删行：添加 tag 保留数据、删行后行数正确
   - 语言切换：zh ↔ en 实时刷新（Name/Resource Type/…/Add row 全变英文）
   - 验证过程发现并修复关键 bug：`evalCondition(undefined)` 返回 true 导致所有无条件字段被误禁用，修复为调用点区分 `disabledWhen ? evalCondition(...) : false`（见 2.2 语义约定）
5. 静态检查：tsc 仅剩 2 个既有错误（ProjectLauncher handleRemove、AppShell null 传参，非本次引入），oxlint 0 errors

### 追加：FormStore 端口解耦（2026-10-22，同日）

6. 新增 `app/src/core/schema/formStore.ts`：`FormStore` 端口（get/set/subscribe）+ `createMemoryStore` 内存适配器
7. `schemaForm.tsx` 改为 `store` prop（去掉 value/initialValues/onValuesChange 双模式），渲染期从 store 收集快照、写值走 store.set、订阅 store 触发重渲染
8. 三个消费方适配：
   - `DemoDialog.tsx` / `InspectorPanel.tsx`：`createMemoryStore`（纯演示，不持久化）
   - `SettingsDialog.tsx`：内联设置适配器（get=本地编辑??cache、set=记本地编辑+发命令、subscribe=订阅 SETTINGS_CHANGED/LOADED）；删除了旧的全字段 diff 与 key 重挂载逻辑
9. 浏览器实测：检视器（memory store）条件联动/数组增行正常；设置对话框（settings adapter）读 cache 真实值、修改即生效、外部命令变更实时同步 UI、语言切换联动全部通过；成环防护验证（外部改回 dark，UI 跟随且不卡死）

### 追加：渲染器注册表（2026-10-22，同日）

10. 新增 `app/src/core/schema/schemaRenderers.ts`：`SchemaRendererRegistry`（register/get/list，重复 type 报错）+ `FieldRenderer`（`(field, value, ctx) => ReactNode`）+ `RenderContext`（values/setValue/t/disabled/store/renderers）；挂 `ModuleContext.schemaRenderers`（module.ts + index.ts createCore 装配）
11. `schemaForm.tsx` 双轨扩展：内置控件仍走 switch；`CustomFieldSchema`（type 为 `CustomTypeId` 命名空间模板字面量 `` `${string}.${string}` `` + `meta?: M`）加入 `FieldSchema` 联合，`renderControl` default 分支查注册表渲染（未注册返回 null）；`SchemaFormProps` 增 `renderers?` prop
12. 新增 `app/src/core/schema/schemaBuiltinRenderers.tsx`：框架内置元数据联动示例 `system.store-select`（meta.loadOptions 数据源函数，同步/异步均可；渲染函数返回内部组件 StoreSelectControl，useEffect 拉取 + 管理加载态），appCore.ts 注册
13. 三个消费方（DemoDialog / InspectorPanel / SettingsDialog）传 `renderers={core?.schemaRenderers}`；DemoDialog 加 `preset` 字段（system.store-select）演示
14. 静态检查：tsc 0 errors、oxlint 0 warnings

### 追加：select 控件改用 Blueprint Select2（2026-10-22，同日）

15. 安装 `@blueprintjs/select`（6.4.0），main.tsx 引入 `blueprint-select.css`
16. 内置 `select` 分支从 `HTMLSelect`（`@blueprintjs/core`，原生 select 包装）换为 `Select2`：`items`+`itemRenderer`（`MenuItem`）+`onItemSelect`+`activeItem`+`fill`+`popoverProps({matchTargetWidth, minimal})`，trigger 用 `Button`（text=当前选中项翻译 label + caret-down）；`filterable={false}` 关闭过滤框（当前选项静态小集合）；`allowEmpty` 仍加空选项；新增 `system.schema.noResults` i18n key
17. 内置渲染器 `schemaBuiltinRenderers.tsx` 的 `store-select`（`system.store-select`）同步换 `Select2`（loading 态 trigger 显示 loadingLabel）
18. 浏览器实测：Demo 弹窗 3 个 select（模式/材质/预设）全为 Blueprint Popover+Menu（0 原生 select），点击弹出带动画的 Blueprint Menu、选中值写入并更新 trigger、暗色浮层正确（bp6-dark）；设置对话框语言/主题 select 正常、改语言即生效持久化；语言切换 zh↔en trigger 文本与选项实时刷新
19. 静态检查：tsc 0 errors、oxlint 0 warnings

### 追加：创建项目弹窗落地 schema 渲染（2026-10-22，同日）

20. 新增 `app/src/core/schema/schemaLauncher.ts`：`CREATE_PROJECT_SCHEMA_ID='system.launcher.createProject'`（name 必填 text / type select 2d·3d / defaultNamespace text），文案复用 `system.launcher.*`；appCore.ts 注册
21. `schemaForm.tsx` 的 `TextFieldSchema` 加 `placeholderKey`（占位文案 i18n key，渲染时 t() 翻译，优先于字面量 `placeholder`）；`renderControl` text 分支按 `placeholderKey ?? placeholder` 取占位文案
22. `ProjectLauncher.tsx` 创建对话框改为 SchemaForm 渲染：从 `core.schemas.get(CREATE_PROJECT_SCHEMA_ID)` 取 schema，用闭包包装 `createMemoryStore` 做创建项目适配器（值不落 store，确定时提交；name→defaultNamespace 联动封装在 adapter set 里，`namespaceTouched` 闭包标记）；`handleCreate` 从 store 读 name/type/defaultNamespace → `project.create`
23. 浏览器实测：创建对话框渲染（名称必填/类型 Select2/命名空间）+ 输入 MyGame 命名空间自动联动 mygame + 选 3D 提交后 project.json 持久化 `type:3d`/`defaultNamespace:mygame` + 语言切换 zh↔en label/helper/placeholder 实时刷新
24. 静态检查：tsc 0 errors、oxlint 0 warnings

### 追加：节点稳定 id + schema patch（2026-10-22，同日）

25. `schemaForm.tsx` 布局结构升级：`FieldNode/GroupNode/ArrayNode` 统一继承 `SchemaNodeBase`（新增必填 `id` 稳定节点 id）；SchemaForm/SchemaNodeView 渲染 key 优先用节点 id（回退字段 key/索引）
26. `schemaRegistry.ts` 新增 `patch(schemaId, nodeId, change)`：递归按节点 id 定位（group 下钻 children）→ 深合并变更（plain object 递归合并、数组/标量直接替换，手写不引 lodash）→ **就地写回原节点保引用**（消费方 `get` 即时生效）；`SchemaPatchChange = Record<string, unknown>`，编辑字段用 `{ field: {...} }` 包裹
27. 全部内联 schema 补节点 id：schemaLauncher（`system.launcher.createProject.{name,type,defaultNamespace}`）、schemaExamples（`system.demo.schema.{...}`）、DemoDialog（`demo.dialog.{...}`）、SettingsDialog 运行时构建节点（`system.<section>.<item>.<fieldKey>`）
28. appCore.ts 演示 patch：注册 createProjectSchema 后给 type 节点 `{ field: { options: [...] } }` 增加 `2.5d` 选项（i18n `system.launcher.type25d`），并打变更日志
29. 浏览器实测：创建项目 type 下拉出现 2.5D（3 选项）→ 选中 2.5D trigger 更新/值写入 → 语言切换 zh↔en 选项与选中值联动保持；控制台打印 patch 变更日志
30. 验证发现并修复关键 bug：`deepMerge` 返回新对象但未写回原节点，导致消费方 `get` 到旧 schema（patch 日志显示 3 选项而 UI 只有 2D/3D）；修复为 `Object.assign(node, merged)` 就地写回
31. 静态检查：tsc 0 errors、oxlint 0 warnings

### 追加：第一个资源 + 编辑器 —— project.json 可视化配置（2026-10-22，同日）

32. 新增 `app/src/core/resources/resourceTypes.ts`：资源类型注册表（"文件→类型→编辑器"映射）。`ResourceType { type, titleKey, icon, matches(node) }`，`matchResourceType(node)` 第一个命中优先，`tabForResource(type, node)` 构造编辑器标签；首个成员 `system.project-config`（匹配 `project.json`）
33. `EditorTab` 增 `type?: string`（资源类型 id）；`WorkspaceTabs.renderPanel` 从 `switch(tab.id)` 升级为 `switch(tab.type)` → 分派 `ProjectConfigEditor`；`AppShell` 监听 `system.resource:open`（资源树文件点击已发）→ 匹配资源类型 → 打开/激活编辑器标签（已开则激活不重复开）
34. 主进程 `projectManager.updateMeta(id, patch)`：嵌套 patch 深合并到磁盘 meta（数组/标量替换，与前端 SchemaRegistry.patch 语义一致）+ 刷新 updatedAt + 返回最新 meta；`readMetaConfig(id)` 读最新配置；IPC `project:config:read/write`（id 必填=当前项目，防越权）
35. 前端 `projectModule` 扩展 config 能力：cache `getConfig()` / `loadConfig()` / `saveConfig(patch)`（invoke write 后更新 cache + 广播）；事件 `system.project:config:changed`（携带最新 project）；命令 `system.project:config:set`（携带 `{ patch }`，人工/AI 同链路）；打开/关闭项目时重置 config cache
36. 新增 `app/src/core/schema/schemaProjectConfig.ts`：`PROJECT_CONFIG_SCHEMA_ID='system.project.config'`，布局 3 大组（基本 name/type/entry + 命名空间 defaultNamespace/namespaces 数组 + 分域参数 rendering/input/physics/build 各分组），扁平 key 用点路径（`settings.rendering.targetFps`），`projectMetaToForm`/`projectFormToPatch` 在嵌套 meta 与扁平值间转换
37. 新增 `app/src/components/editors/ProjectConfigEditor.tsx`：挂载 `loadConfig()` 拉全量；FormStore adapter（get=本地编辑??cache 转扁平、set=记本地编辑+组装 patch→`system.project:config:set` 命令、subscribe=`PROJECT_CONFIG_CHANGED`）；只读元信息（formatVersion/createdAt/updatedAt）单独展示；i18n 文案 `system.projectConfig.*`（projectConfigStrings.ts，zh/en）
38. 自动化接入：MCP_COMMANDS 增 `system.project:config:set`（`patch: z.record(z.unknown())`），AI/Agent 经 MCP 与人工完全同链路写 project.json
39. 浏览器实测全链路：资源树点 project.json → 打开编辑器标签；UI 改 targetFps=75 写盘；MCP 写 moveSpeed/gravity 写盘+UI 同步；深合并互不覆盖；namespaces 数组增/删行写盘；项目类型 select UI→磁盘 / MCP→UI；语言切换 zh↔en 联动；只读元信息展示
40. 静态检查：tsc 0 errors、oxlint 0 warnings

> 设计取舍：自定义 type 统一命名空间 id `<namespace>.<name>`（内置用 `system` 前缀）保证联合窄化（含点的模板字面量与内置无点字面量判别不重叠；`type: string` 会破坏判别）；渲染函数是纯声明、返回内部组件持有数据拉取/订阅（"渲染函数自己负责内部事件/数据获取"）。

## 10. 后续扩展（不在本次）

- 内置控件扩展：color / vector2/3 / file-picker / slider / enum-multi
- 渲染器注册表更多内置示例：enum-multi（多选）、object 属性编辑器等
- 嵌套路径值模型（真正的分域数据）
- 校验升级为完整 schema 协议（JSON Schema / zod 统一）
