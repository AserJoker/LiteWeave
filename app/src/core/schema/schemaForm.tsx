/* oxlint-disable react/set-state-in-effect */
/**
 * SchemaForm —— Schema 驱动的表单引擎（基础设施）。
 *
 * 设计（见 docs/design/schema-driven-ui.md）：
 * - 模块只注册“数据契约”（SchemaNode 布局树），不注册 UI；框架按类型分支渲染控件。
 * - 文案（label/helper/选项）用 i18n key（labelKey），渲染时 t() 翻译，语言切换实时更新。
 * - 值模型：扁平 key → FieldValue | FieldValue[]（数组字段存数组）；嵌套对象语义用 group 表达布局。
 * - 值生命周期：引擎不缓存跨实例状态，读写/订阅统一走 FormStore 端口（见 formStore.ts）；
 *   引擎只依赖 get/set/subscribe，不关心数据存哪、怎么被消费（本地内存 / 命令 / 后端 store / SSE 推回）。
 * - 扩展：新控件类型 = 加类型定义 + renderControl 分支（增量式）；控件类型暴增时再升级渲染器注册表。
 *
 * 控件类型（第一版）：text / number / switch / select；布局：group（分组/单行）/ array（动态数组）。
 */
import { useEffect } from 'react';
import { Button, FormGroup, InputGroup, MenuItem, NumericInput, Switch, TextArea } from '@blueprintjs/core';
import { Select2 } from '@blueprintjs/select';
import type { FormStore } from './formStore.js';
import { useFormStoreSubscribe } from './formStore.js';
import type { Condition } from './schemaCondition.js';
import { evalCondition } from './schemaCondition.js';
import type { RenderContext, SchemaRendererRegistry } from './schemaRenderers.js';

/* ---------------- Schema 类型 ---------------- */

/** 字段值类型（基础标量；复合类型在宿主侧序列化为 string 存值） */
export type FieldValue = string | number | boolean

/** 下拉选项（value 为存储值，labelKey 为显示文案 i18n key） */
export interface SelectOption {
  value: string
  labelKey: string
}

/** 字段公共属性 */
export interface FieldBase {
  /** 字段唯一 key（表单内全局唯一；值模型扁平） */
  key: string
  /** label 的 i18n key（如 system.settings.field.language） */
  labelKey: string
  /** helper 的 i18n key */
  helperKey?: string
  required?: boolean
  disabled?: boolean
  /** schema 默认值（initialValues 未提供时用；不填则按类型默认） */
  defaultValue?: FieldValue
  /** 可见条件（值为 false 时整字段隐藏） */
  visibleWhen?: Condition
  /** 禁用条件 */
  disabledWhen?: Condition
  /** 自定义校验：返回错误文案（raw 或已翻译）；null 表示通过 */
  validate?: (value: FieldValue | undefined, allValues: FormValues) => string | null
}

export interface TextFieldSchema extends FieldBase {
  type: 'text'
  /** 占位文案（字面量；需要 i18n 时用 placeholderKey） */
  placeholder?: string
  /** 占位文案的 i18n key（渲染时 t() 翻译；优先于 placeholder） */
  placeholderKey?: string
  /** 多行文本（TextArea） */
  multiline?: boolean
  rows?: number
}

export interface NumberFieldSchema extends FieldBase {
  type: 'number'
  placeholder?: string
  min?: number
  max?: number
  step?: number
  /** 单位后缀（如 px、帧） */
  unit?: string
}

export interface SwitchFieldSchema extends FieldBase {
  type: 'switch'
}

export interface SelectFieldSchema extends FieldBase {
  type: 'select'
  options: SelectOption[]
  /** 允许清空（加空选项） */
  allowEmpty?: boolean
}

/** 控件字段联合：扩展新控件类型时在此加成员 + renderControl 加分支（或注册渲染器，见 schemaRenderers.ts） */
export type FieldSchema =
  | TextFieldSchema
  | NumberFieldSchema
  | SwitchFieldSchema
  | SelectFieldSchema
  | CustomFieldSchema

/**
 * 任意控件字段（含自定义类型）——渲染器注册表消费的类型。
 * 内置字段仍可用 type 字面量判别；自定义类型统一命名空间 id（见 CustomTypeId / CustomFieldSchema），
 * 专用元数据收在 meta 字段，避免 index signature 破坏联合窄化。
 */
export type AnyFieldSchema = FieldSchema

/**
 * 自定义控件类型 id：统一命名空间格式 `<namespace>.<name>`（可多级，如 'system.store-select'、'plugin.x.y'）。
 * 含点的格式与内置字面量（'text'/'number'/'switch'/'select'，均无点）判别不重叠，
 * 使 FieldSchema 联合可按 type 正常窄化（type: string 会破坏判别）。
 * 约定：系统内置控件用 `system` 命名空间；插件用自己注册的命名空间（同 i18n/事件/命令 命名空间规范）。
 */
export type CustomTypeId = `${string}.${string}`

/**
 * 自定义控件类型：type 为命名空间 id `<namespace>.<name>`（未命中内置 switch 时去 schemaRenderers 注册表查询渲染函数）。
 * 渲染函数从 `meta` 读自定义元数据（如下拉数据源 key、外部 store 选择器）。
 */
export interface CustomFieldSchema<M extends object = Record<string, unknown>> extends FieldBase {
  /** 自定义类型 id（命名空间格式，如 'system.store-select'） */
  type: CustomTypeId
  /** 自定义类型专用元数据（渲染函数读取；插件可定义自己的 M 泛型） */
  meta?: M
}

/* ---------------- 条件表达式（见 schemaCondition.ts） ---------------- */

/* ---------------- 布局结构 ---------------- */

/**
 * 布局节点公共属性：每个节点硬编码稳定 id，作为 patch / 插件编辑的定位目标
 * （区别于字段 key：key 是值模型的键，id 是节点本身的稳定标识，编辑 schema 时按 id 定位）。
 * 约定：节点 id 在单个 schema 内全局唯一（命名空间风格，如 'system.launcher.createProject.type'）。
 */
export interface SchemaNodeBase {
  /** 节点稳定 id（schema 内唯一；patch/插件按它定位编辑节点） */
  id: string
}

export interface FieldNode extends SchemaNodeBase {
  kind: 'field'
  field: FieldSchema
}

export interface GroupNode extends SchemaNodeBase {
  kind: 'group'
  /** 分组标题 i18n key（可嵌套） */
  titleKey?: string
  /** 单行布局：horizontal（子元素并排）；默认 vertical */
  layout?: 'vertical' | 'horizontal'
  children: SchemaNode[]
}

export interface ArrayNode extends SchemaNodeBase {
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

export type SchemaNode = FieldNode | GroupNode | ArrayNode

/** 表单 schema：布局树（顶层节点数组） */
export type Schema = SchemaNode[]

/* ---------------- 值模型 ---------------- */

/** 表单值：扁平 key → 标量或数组 */
export type FormValues = Record<string, FieldValue | FieldValue[]>

export interface SchemaFormProps {
  /** 布局树 schema */
  schema: Schema
  /**
   * 数据源端口（宿主注入适配器，见 formStore.ts）。
   * 引擎只读/写/订阅此接口，不关心数据存哪、怎么消费：
   * - 设置表单：宿主包装 storeModule api + 命令（改→发命令→后端→SSE 回推→subscribe 重取）
   * - 创建/演示：createMemoryStore（内置内存适配器）
   */
  store: FormStore
  /** 校验错误上报：fieldKey → 错误文案 */
  onValidationChange?: (errors: Record<string, string>) => void
  /** i18n 翻译函数（宿主注入；schema 存 key，渲染时翻译） */
  t: (key: string) => string
  /** 渲染器注册表（可选）：内置 switch 未命中的自定义 type 在此查询渲染函数（见 schemaRenderers.ts） */
  renderers?: SchemaRendererRegistry
}

/* ---------------- 工具 ---------------- */

/** 收集布局树中全部字段 key（数组字段用 key） */
function collectFieldKeys(nodes: SchemaNode[], keys: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === 'field') keys.push(node.field.key)
    else if (node.kind === 'group') collectFieldKeys(node.children, keys)
    else keys.push(node.key)
  }
  return keys
}

/** 字段类型默认值 */
function typeDefault(field: FieldSchema): FieldValue {
  if (field.type === 'switch') return false
  if (field.type === 'number') return 0
  return ''
}

/** 字段当前值：优先外部值/初始值，其次 schema defaultValue，最后类型默认 */
function fieldValue(field: FieldSchema, values: FormValues): FieldValue {
  const v = values[field.key]
  if (v !== undefined && v !== null) {
    return (Array.isArray(v) ? v[0] : v) as FieldValue
  }
  return field.defaultValue ?? typeDefault(field)
}

/** 数组字段当前值（转数组） */
function arrayValue(key: string, values: FormValues): FieldValue[] {
  const v = values[key]
  return Array.isArray(v) ? v : []
}

function collectFields(nodes: SchemaNode[]): FieldSchema[] {
  const out: FieldSchema[] = []
  for (const node of nodes) {
    if (node.kind === 'field') out.push(node.field)
    else if (node.kind === 'group') out.push(...collectFields(node.children))
  }
  return out
}

/* ---------------- 组件 ---------------- */

export function SchemaForm({ schema, store, onValidationChange, t, renderers }: SchemaFormProps) {
  // 订阅 store 变化（本地 set / 外部推回）→ 触发重渲染，渲染期重新读值
  useFormStoreSubscribe(store)

  // 从 store 读当前快照（未设的字段用 schema 默认值兜底，条件求值/校验/数组都基于此快照）
  const values = collectStoreValues(schema, store)

  // 写值：引擎只调 store.set，不关心宿主怎么消费（本地 state / 发命令 / 防抖队列）
  const setValue = (key: string, v: FieldValue | FieldValue[], changedKey?: string): void => {
    store.set(key, v, changedKey ?? key)
  }

  // 校验：遍历所有字段，收集错误上报
  useEffect(() => {
    if (!onValidationChange) return
    const errors: Record<string, string> = {}
    const all = collectFields(schema)
    for (const field of all) {
      if (field.required) {
        const v = values[field.key]
        const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
        if (empty) {
          errors[field.key] = t(field.labelKey) + '（必填）'
          continue
        }
      }
      if (field.type === 'number' && typeof values[field.key] === 'number') {
        const n = values[field.key] as number
        if (field.min !== undefined && n < field.min) errors[field.key] = `${t(field.labelKey)} 不能小于 ${field.min}`
        else if (field.max !== undefined && n > field.max) errors[field.key] = `${t(field.labelKey)} 不能大于 ${field.max}`
      }
      if (field.validate) {
        const msg = field.validate(values[field.key] as FieldValue | undefined, values)
        if (msg && !errors[field.key]) errors[field.key] = msg
      }
    }
    onValidationChange(errors)
  }, [schema, values, t, onValidationChange])

  return (
    <div className="lw-schema-form">
      {schema.map((node, i) => (
        <SchemaNodeView
          key={node.id ?? (node.kind === 'field' ? node.field.key : node.kind === 'array' ? node.key : `g-${i}`)}
          node={node}
          values={values}
          setValue={setValue}
          t={t}
          renderers={renderers}
          store={store}
        />
      ))}
    </div>
  )
}

/**
 * 从 store 收集当前快照：全部字段 key → store.get 值；未设的用 schema 默认值兜底（不写入 store，纯读）。
 * 这样条件求值 / 校验 / 数组渲染基于统一快照，且外部 store 的已有值（如设置 cache）优先。
 */
function collectStoreValues(schema: Schema, store: FormStore): FormValues {
  const v: FormValues = {}
  for (const key of collectFieldKeys(schema)) {
    const val = store.get(key)
    if (val !== undefined && val !== null) {
      v[key] = val
    }
  }
  // 补 schema 默认值（未在 store 中的字段；数组默认 []，字段用 defaultValue/类型默认）
  for (const node of schema) {
    if (node.kind === 'field') {
      if (v[node.field.key] === undefined) v[node.field.key] = fieldValue(node.field, v)
    } else if (node.kind === 'group') {
      for (const f of collectFields(node.children)) {
        if (v[f.key] === undefined) v[f.key] = fieldValue(f, v)
      }
    } else {
      if (v[node.key] === undefined) v[node.key] = []
    }
  }
  return v
}

/* ---------------- 节点渲染 ---------------- */

interface NodeViewProps {
  node: SchemaNode
  values: FormValues
  setValue: (key: string, v: FieldValue | FieldValue[], changedKey?: string) => void
  t: (key: string) => string
  store: FormStore
  renderers?: SchemaRendererRegistry
}

function SchemaNodeView({ node, values, setValue, t, store, renderers }: NodeViewProps) {
  if (node.kind === 'field') {
    const { field } = node
    // 条件求值：visibleWhen 成立才显示；disabledWhen 成立则禁用（叠加字段自身 disabled）。
    // 无条件时默认显示且不禁用（undefined 的语义在调用点区分，见 evalCondition 注释）。
    const visible = field.visibleWhen ? evalCondition(field.visibleWhen, values) : true
    const disabled = Boolean(field.disabled) || (field.disabledWhen ? evalCondition(field.disabledWhen, values) : false)
    if (!visible) return null
    return (
      <FormGroup
        key={field.key}
        label={t(field.labelKey)}
        helperText={field.helperKey ? t(field.helperKey) : undefined}
        labelInfo={field.required ? '(必填)' : undefined}
        className="lw-schema-field"
      >
        {renderControl(field, values[field.key] as FieldValue | undefined, {
          values,
          setValue: (v) => setValue(field.key, v),
          t,
          disabled,
          store,
          renderers,
        })}
      </FormGroup>
    )
  }
  if (node.kind === 'group') {
    return (
      <div className={`lw-schema-group lw-schema-group-${node.layout ?? 'vertical'}`}>
        {node.titleKey && <div className="lw-schema-group-title">{t(node.titleKey)}</div>}
        {node.children.map((c, i) => (
          <SchemaNodeView key={c.id ?? (c.kind === 'field' ? c.field.key : c.kind === 'array' ? c.key : `g-${i}`)} node={c} values={values} setValue={setValue} t={t} store={store} renderers={renderers} />
        ))}
      </div>
    )
  }
  // array：标量数组动态行列表（值 = FieldValue[]，每行一个控件）
  const rows = arrayValue(node.key, values)
  const canAdd = node.maxItems === undefined || rows.length < node.maxItems
  const canRemove = node.minItems === undefined || rows.length > node.minItems
  return (
    <div className="lw-schema-array">
      {node.titleKey && <div className="lw-schema-group-title">{t(node.titleKey)}</div>}
      {rows.length === 0 && <div className="lw-schema-array-empty">{t('system.schema.empty')}</div>}
      {rows.map((row, idx) => (
        <div className="lw-schema-array-row" key={idx}>
          <span className="lw-schema-array-idx">{idx + 1}</span>
          <div className="lw-schema-array-control">
            {renderControl(node.item, row as FieldValue, {
              values,
              // 数组行内：setValue 更新第 idx 个元素（行元素为标量，自定义控件在数组行内也应写标量）
              setValue: (v) => {
                const next = rows.map((r, i) => (i === idx ? (v as FieldValue) : r))
                setValue(node.key, next, node.key)
              },
              t,
              disabled: Boolean(node.item.disabled),
              store,
              renderers,
            })}
          </div>
          {canRemove && (
            <Button icon="cross" minimal small title={t('system.schema.removeRow')} onClick={() => {
              const next = rows.filter((_, i) => i !== idx)
              setValue(node.key, next, node.key)
            }} />
          )}
        </div>
      ))}
      {canAdd && (
        <Button icon="plus" small text={t('system.schema.addRow')} onClick={() => {
          const def = node.item.defaultValue ?? typeDefault(node.item)
          setValue(node.key, [...rows, def], node.key)
        }} />
      )}
    </div>
  )
}

/* ---------------- 控件渲染 ---------------- */

function renderControl(field: FieldSchema, value: FieldValue | undefined, ctx: RenderContext) {
  const { t, disabled } = ctx
  switch (field.type) {
    case 'text': {
      // 占位文案：placeholderKey（i18n）优先，其次 placeholder（字面量）
      const placeholder = field.placeholderKey ? t(field.placeholderKey) : field.placeholder
      return field.multiline ? (
        <TextArea
          value={String(value ?? '')}
          placeholder={placeholder}
          disabled={disabled}
          rows={field.rows ?? 3}
          fill
          onChange={(e) => ctx.setValue(e.target.value)}
        />
      ) : (
        <InputGroup
          value={String(value ?? '')}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => ctx.setValue(e.target.value)}
        />
      )
    }
    case 'number':
      return (
        <div className="lw-schema-number">
          <NumericInput
            value={typeof value === 'number' ? value : undefined}
            placeholder={field.placeholder}
            disabled={disabled}
            min={field.min}
            max={field.max}
            step={field.step}
            onValueChange={(v) => ctx.setValue(v)}
          />
          {field.unit && <span className="lw-schema-unit">{field.unit}</span>}
        </div>
      )
    case 'switch':
      return (
        <Switch
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(e) => ctx.setValue((e.target as HTMLInputElement).checked)}
        />
      )
    case 'select': {
      // Blueprint Select2（@blueprintjs/select）：与其它控件一致的样式/动画/主题（Popover + Menu）
      const options: SelectOption[] = [
        ...(field.allowEmpty ? [{ value: '', labelKey: t('system.schema.emptyOption') }] : []),
        ...field.options,
      ]
      const active = value === undefined || value === null ? '' : String(value)
      return (
        <Select2<SelectOption>
          items={options}
          filterable={false}
          disabled={disabled}
          activeItem={options.find((o) => o.value === active)}
          onItemSelect={(opt) => ctx.setValue(opt.value)}
          itemRenderer={(opt, { handleClick, modifiers }) => (
            <MenuItem
              key={opt.value}
              role="option"
              text={t(opt.labelKey)}
              active={modifiers.active}
              onClick={handleClick}
            />
          )}
          noResults={<MenuItem disabled text={t('system.schema.noResults')} role="none" />}
          fill
          popoverProps={{ matchTargetWidth: true, minimal: true }}
        >
          <Button
            text={active === '' ? t('system.schema.emptyOption') : t(options.find((o) => o.value === active)?.labelKey ?? '')}
            rightIcon="caret-down"
            disabled={disabled}
            fill
            alignText="left"
          />
        </Select2>
      )
    }
    default:
      // 自定义控件类型：引擎内置 switch 未命中 → 到渲染器注册表查询（插件 / 框架注册，见 schemaRenderers.ts）
      return ctx.renderers?.get(field.type)?.(field, value, ctx) ?? null
  }
}
