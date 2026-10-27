/**
 * schemaRegistry —— 表单 schema 注册器（基础架构）。
 *
 * 设计（见 docs/design/schema-driven-ui.md）：
 * - 模块只注册数据契约（SchemaDefinition），不注册 UI；引擎（SchemaForm）负责渲染。
 * - 模块在 init 时 `ctx.schemas.register(def)` 注册自己的表单 schema；插件同理，无需改引擎。
 * - 与事件/命令/i18n 注册器并列，挂到 ModuleContext.schemas，由 createCore 装配。
 * - id 全局唯一（命名空间风格，如 "system.settings.general.appearance" / "demo.material"）。
 * - map：宿主自定义业务数据 ↔ 表单值的读写映射（默认 key 直读）；可选。
 */
import type { FormValues, Schema, SchemaNode } from './schemaForm.js'

/** 表单 schema 定义：模块注册的完整契约 */
export interface SchemaDefinition {
  /** 全局唯一 id（命名空间风格，如 "system.settings.general.appearance"） */
  id: string
  /** schema 标题 i18n key（对话框标题 / 面板名）；可选 */
  titleKey?: string
  /** 布局树 */
  schema: Schema
  /** 业务数据 ↔ 表单值映射（可选；默认 key 直读） */
  map?: {
    /** 业务数据 → 表单值 */
    toForm?: (data: unknown) => FormValues
    /** 表单值 → 业务数据 */
    fromForm?: (values: FormValues) => unknown
  }
}

/**
 * patch 变更：对定位到的节点做深合并（plain object 递归合并，数组/标量直接替换）。
 * 例：给 select 字段加选项 → { field: { options: [...] } }；改分组标题 → { titleKey: '...' }。
 */
export type SchemaPatchChange = Record<string, unknown>

/** 是否为 plain object（深合并仅作用于 plain object，数组直接替换） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 深合并：base 与 patch 同为 plain object 时递归合并，否则 patch 直接替换 */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v
  }
  return out as T
}

/** 递归按节点 id 定位（group 下钻 children；未找到返回 undefined） */
function findNode(nodes: SchemaNode[], id: string): SchemaNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node
    if (node.kind === 'group') {
      const found = findNode(node.children, id)
      if (found) return found
    }
  }
  return undefined
}

/** 表单 schema 注册器接口（挂到 ModuleContext.schemas，供模块注册 / 组件取用） */
export interface SchemaRegistry {
  /** 注册一个 schema 定义；重复 id 报错（id 必须唯一） */
  register(def: SchemaDefinition): void
  /** 按 id 取 schema（未注册返回 undefined） */
  get(id: string): SchemaDefinition | undefined
  /** 全部已注册 schema */
  list(): SchemaDefinition[]
  /**
   * patch：按节点 id 编辑已注册 schema 的节点（就地变更，消费方 get 后即时生效）。
   * 用于插件/扩展在 init 时向既有 schema 注入变更（如给 select 加选项、改 helper 文案）。
   * @param schemaId 已注册的 SchemaDefinition id
   * @param nodeId 目标节点 id（须在 schema 内唯一）
   * @param change 深合并到节点的变更（字段编辑用 { field: {...} } 包裹）
   * @returns 变更后的节点（供调用方打日志/校验）；schema 或节点未找到时抛错
   */
  patch(schemaId: string, nodeId: string, change: SchemaPatchChange): SchemaNode
  /** 移除（供测试/卸载模块） */
  unregister(id: string): void
}

/** 创建 schema 注册器（core 内置；由 createCore 实例化并挂到 ctx） */

export function createSchemaRegistry(): SchemaRegistry {
  const defs = new Map<string, SchemaDefinition>()

  return {
    register(def: SchemaDefinition): void {
      if (!def || typeof def.id !== 'string' || !def.id) {
        throw new Error('[schema] schema 定义缺少有效 id')
      }
      if (defs.has(def.id)) {
        throw new Error(`[schema] schema "${def.id}" 已注册，不能重复注册`)
      }
      defs.set(def.id, def)
    },

    get(id: string): SchemaDefinition | undefined {
      return defs.get(id)
    },

    list(): SchemaDefinition[] {
      return Array.from(defs.values())
    },

    patch(schemaId: string, nodeId: string, change: SchemaPatchChange): SchemaNode {
      const def = defs.get(schemaId)
      if (!def) {
        throw new Error(`[schema] patch 目标 schema "${schemaId}" 未注册`)
      }
      const node = findNode(def.schema, nodeId)
      if (!node) {
        throw new Error(`[schema] schema "${schemaId}" 中未找到节点 "${nodeId}"`)
      }
      // 深合并后就地写回原节点（保引用：消费方 get 到的是同一个节点对象，变更即时生效）
      const merged = deepMerge(node, change) as SchemaNode
      Object.assign(node, merged)
      return node
    },

    unregister(id: string): void {
      defs.delete(id)
    },
  }
}
