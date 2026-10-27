/**
 * schemaRenderers —— 自定义控件渲染器注册表（SchemaForm 的控件扩展点）。
 *
 * 引擎内置控件（text/number/switch/select）走 switch 快速路径；遇到不认识的 type，
 * SchemaForm 到本注册表查询渲染函数（见 schemaForm.tsx renderControl 的 default 分支）。
 *
 * 扩展模型：
 * - 插件在 init(ctx) 时 `ctx.schemaRenderers.register(type, renderer)` 注册自己的控件类型；
 *   无需改引擎，SchemaForm 遇到该 type 自动用渲染函数渲染。
 * - 渲染函数格式：输入 schema 字段节点，输出 React 节点；内部事件 / 数据获取由渲染函数自己负责。
 * - 元数据联动场景（如下拉 options 来自 store / 后端）：渲染函数返回的组件可通过 ctx.store
 *   （FormStore 端口）读取 / 订阅外部数据，也可直接调后端 API。
 *
 * 语义约定：渲染函数是纯函数式声明（不持久化跨实例状态），受控值读写走 ctx（values/setValue）；
 * 需要订阅外部数据时返回一个内部组件（在组件里 useFormStoreSubscribe / useEffect）。
 */
import type { ReactNode } from 'react'
import type { FieldValue, FormValues, AnyFieldSchema } from './schemaForm.js'
import type { FormStore } from './formStore.js'

/** 渲染上下文：渲染函数可用的引擎能力（值读写 / 翻译 / 禁用态 / 数据源端口 / 渲染器注册表） */
export interface RenderContext {
  /** 当前表单值快照（含其他字段，供联动） */
  values: FormValues
  /**
   * 写当前字段值（引擎已处理上下文：普通字段写 field.key；数组行内写该行元素）。
   * 自定义渲染器需要写其他字段时，直接用 store.set(key, v)（引擎不关心宿主怎么消费）。
   */
  setValue: (v: FieldValue | FieldValue[]) => void
  /** i18n 翻译（schema 存 key，渲染时翻译） */
  t: (key: string) => string
  /** 禁用态（字段级 disabled + disabledWhen 条件计算后的最终值） */
  disabled: boolean
  /** 数据源端口（FormStore）：自定义控件读 / 订阅外部数据（元数据联动） */
  store: FormStore
  /** 渲染器注册表（引擎 default 分支查询；自定义渲染器也可查其他类型） */
  renderers?: SchemaRendererRegistry
}

/**
 * 渲染函数：输入 schema 字段节点（field.type === 注册的 type），输出 React 节点。
 * 返回组件时内部事件 / 数据获取自己负责（受控写值走 ctx.setValue）。
 */
export type FieldRenderer = (field: AnyFieldSchema, value: FieldValue | undefined, ctx: RenderContext) => ReactNode

/** 渲染器注册表接口（挂 ModuleContext.schemaRenderers，插件 init 时注册） */
export interface SchemaRendererRegistry {
  /** 注册一个控件类型的渲染函数；type 为空 / 重复报错 */
  register(type: string, renderer: FieldRenderer): void
  /** 按 type 取渲染函数（未注册返回 undefined） */
  get(type: string): FieldRenderer | undefined
  /** 全部已注册 type（含插件） */
  list(): string[]
}

/** 创建渲染器注册表（core 内置；由 createCore 实例化并挂到 ctx） */
export function createSchemaRendererRegistry(): SchemaRendererRegistry {
  const map = new Map<string, FieldRenderer>()

  return {
    register(type: string, renderer: FieldRenderer): void {
      if (!type || typeof renderer !== 'function') {
        throw new Error('[schema] 渲染器缺少有效 type 或渲染函数')
      }
      if (map.has(type)) {
        throw new Error(`[schema] 渲染器 "${type}" 已注册，不能重复注册`)
      }
      map.set(type, renderer)
    },

    get(type: string): FieldRenderer | undefined {
      return map.get(type)
    },

    list(): string[] {
      return Array.from(map.keys())
    },
  }
}
