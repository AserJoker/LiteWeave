/**
 * 资源类型注册器 —— “文件 → 类型 → 编辑器”三者结合的映射注册表。
 *
 * 设计（见 docs/design/plugin-system.md §4.1）：
 * - ExplorerPanel 点击文件发 system.resource:open { path, name }（命令）
 * - 注册器按 node（name/path）匹配出资源类型（第一个命中优先）
 * - 资源类型 id 决定：编辑器标签的 type（WorkspaceTabs 按注册器分派到 EditorPanel）与图标
 * - 新增资源类型（场景/材质/脚本…）：插件 init 时 ctx.resourceTypes.register 即可，无需改组件
 *
 * 资源类型 id 命名空间风格：`<命名空间>.<名称>`，系统内置用 system 前缀（全局隔离，插件可注册自己的）。
 */
import type { ProjectNode } from '../project/projectModule.js'
import type { Schema } from '../schema/schemaForm.js'

/** 资源类型 id：命名空间风格（如 system.project-config） */
export type ResourceTypeId = `${string}.${string}`

/** 新建资源向导声明：右键“新建资源…”弹窗按类型展示参数表单，创建时组装命令参数 */
export interface ResourceCreateSpec {
  /** 向导参数表单（SchemaForm 布局树；字段值即向导收集的参数） */
  schema: Schema
  /** 校验：参数 → 是否合法；返回错误文案（raw），null 表示通过 */
  validate?: (values: Record<string, unknown>) => string | null
  /** 组装创建命令参数：由向导参数生成 { path?, name?, namespace?, content? }（发给 system.resource:create） */
  buildArgs: (values: Record<string, unknown>) => {
    path?: string
    name?: string
    namespace?: string
    content?: string
  }
}

/** 资源类型定义：文件（node）匹配规则 + 编辑器标签属性 + 可选的新建向导 */
export interface ResourceType {
  /** 资源类型 id（编辑器标签 type 字段，WorkspaceTabs 按它分派） */
  type: ResourceTypeId
  /** 编辑器标签标题（i18n key） */
  titleKey: string
  /** 编辑器标签图标（Blueprint icon 名） */
  icon: string
  /** 匹配：该文件节点是否属于本资源类型（按 name/path 判定） */
  matches(node: ProjectNode): boolean
  /** 新建向导（可选）：有则出现在资源管理器右键“新建资源…”；无则不提供新建 */
  create?: ResourceCreateSpec
}

/** 系统内置资源类型：project.json → project-config 配置编辑器 */
export const PROJECT_CONFIG_RESOURCE_TYPE = 'system.project-config' as const

/** 系统内置资源类型：语言文件（.lang）→ LangEditor */
export const LANG_RESOURCE_TYPE = 'system.lang' as const

/** 语言文件目录（相对项目根；.lang 资源统一放 assets/i18n/ 下，与主进程约定一致） */
export const LANG_DIR = 'i18n'

export const PROJECT_META_FILE = 'project.json'

/** 资源类型注册器接口（挂 PluginContext.resourceTypes，插件 init 时注册） */
export interface ResourceTypeRegistry {
  /** 注册一个资源类型；type 为空 / 重复报错 */
  register(type: ResourceType): void
  /** 按 type 取（未注册返回 undefined） */
  get(type: string): ResourceType | undefined
  /** 按文件节点匹配（第一个命中优先；未匹配返回 undefined = 无编辑器） */
  match(node: Pick<ProjectNode, 'name' | 'path' | 'type'>): ResourceType | undefined
  /** 全部已注册（含插件） */
  list(): ResourceType[]
  /** 移除（供测试/卸载） */
  unregister(type: string): void
}

/** 创建资源类型注册器（core 内置；由 createCore 实例化并挂到 ctx） */
export function createResourceTypeRegistry(): ResourceTypeRegistry {
  const types: ResourceType[] = []

  return {
    register(type: ResourceType): void {
      if (!type || typeof type.type !== 'string' || !type.type) {
        throw new Error('[resource] 资源类型缺少有效 type')
      }
      if (types.some((t) => t.type === type.type)) {
        throw new Error(`[resource] 资源类型 "${type.type}" 已注册，不能重复注册`)
      }
      types.push(type)
    },

    get(type: string): ResourceType | undefined {
      return types.find((t) => t.type === type)
    },

    match(node: Pick<ProjectNode, 'name' | 'path' | 'type'>): ResourceType | undefined {
      return types.find((t) => t.matches(node as ProjectNode))
    },

    list(): ResourceType[] {
      return [...types]
    },

    unregister(type: string): void {
      const idx = types.findIndex((t) => t.type === type)
      if (idx >= 0) types.splice(idx, 1)
    },
  }
}

/** 兼容函数：按文件节点匹配资源类型（保留旧调用点；等价于 registry.match） */
export function matchResourceType(
  node: Pick<ProjectNode, 'name' | 'path' | 'type'>,
  types: ResourceType[] = [],
): ResourceType | undefined {
  if (types.length > 0) return types.find((t) => t.matches(node as ProjectNode))
  // 无显式列表：回退到默认注册器（由 createCore 挂载，见 index.ts）
  return getDefaultResourceRegistry()?.match(node)
}

/** 兼容函数：由资源类型构造编辑器标签（EditorTab）；等价于注册器 + tabForResource */
export function tabForResource(type: ResourceType, node: Pick<ProjectNode, 'name' | 'path'>): {
  id: string
  type: ResourceTypeId
  title: string
  icon: string
  path: string
} {
  return {
    id: `${type.type}:${node.path}`,
    type: type.type,
    title: node.name,
    icon: type.icon,
    path: node.path,
  }
}

/**
 * 语言文件（.lang）资源类型的向导声明：
 * 参数表单 = 命名空间 + 语言（选项在向导打开时从项目动态注入：
 * namespace 取项目 namespaces、lang 取项目 languages 声明）。
 * 路径规范（命名空间层目录）：assets/<namespace>/i18n/<lang>.lang。
 */
export const LANG_RESOURCE_CREATE: ResourceCreateSpec = {
  schema: [
    {
      id: `${LANG_RESOURCE_TYPE}.create.namespace`,
      kind: 'field',
      field: {
        key: 'namespace',
        type: 'select',
        labelKey: 'system.resource.create.namespace',
        helperKey: 'system.resource.create.namespaceHelper',
        required: true,
        options: [],
      },
    },
    {
      id: `${LANG_RESOURCE_TYPE}.create.lang`,
      kind: 'field',
      field: {
        key: 'lang',
        type: 'select',
        labelKey: 'system.resource.create.lang',
        helperKey: 'system.resource.create.langHelper',
        required: true,
        options: [],
      },
    },
  ],
  validate: (values) => {
    const namespace = String(values['namespace'] ?? '').trim()
    const lang = String(values['lang'] ?? '').trim()
    return namespace && lang ? null : 'system.resource.create.missingRequired'
  },
  buildArgs: (values) => {
    const namespace = String(values['namespace'] ?? '').trim()
    const lang = String(values['lang'] ?? '').trim()
    return {
      path: `assets/${namespace}/${LANG_DIR}/${lang}.lang`,
    }
  },
}

/** 系统内置 .lang 资源类型（注册到默认注册器；含新建向导声明） */
export const LANG_RESOURCE_TYPE_DEF: ResourceType = {
  type: LANG_RESOURCE_TYPE,
  titleKey: 'system.lang.title',
  icon: 'globe',
  matches: (node) => node.type === 'file' && node.name.toLowerCase().endsWith('.lang'),
  create: LANG_RESOURCE_CREATE,
}

/** 兼容导出：系统内置资源类型列表（供旧调用点/测试）；新代码用注册器 */
export const BUILTIN_RESOURCE_TYPES: ResourceType[] = [
  {
    type: PROJECT_CONFIG_RESOURCE_TYPE,
    titleKey: 'system.projectConfig.title',
    icon: 'cog',
    matches: (node) => node.type === 'file' && node.name === PROJECT_META_FILE,
  },
  LANG_RESOURCE_TYPE_DEF,
]

/* ---- 默认注册器（createCore 挂载后由这里注入，供兼容函数回退） ---- */

let defaultRegistry: ResourceTypeRegistry | undefined

/** 由 createCore 注入默认注册器（index.ts 装配时调用） */
export function setDefaultResourceRegistry(registry: ResourceTypeRegistry): void {
  defaultRegistry = registry
}

function getDefaultResourceRegistry(): ResourceTypeRegistry | undefined {
  return defaultRegistry
}
