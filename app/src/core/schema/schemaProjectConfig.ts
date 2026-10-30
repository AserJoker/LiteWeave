/**
 * schemaProjectConfig —— project.json 可视化配置表单的 schema 定义。
 *
 * 把 project.json（嵌套结构）映射为扁平表单值（点路径 key）：
 * - 值模型：扁平 key → FieldValue | FieldValue[]（与 SchemaForm 一致）
 * - key 用点路径对应 project.json 的嵌套字段，如 'settings.rendering.targetFps'
 * - map.toForm / fromForm 在嵌套 meta 与扁平表单值之间转换（见 SchemaDefinition.map）
 *
 * 编辑链路：SchemaForm 改字段 → FormStore.set → host 组装 patch（点路径 → 嵌套对象）
 * → system.project:config:set 命令 → 主进程写盘 → 回推 system.project:config:changed → cache 更新。
 *
 * 可被插件 patch（SchemaRegistry.patch 按节点 id）：给任意节点注入变更（如给 type 加选项）。
 */
import type { FormValues } from './schemaForm.js'
import type { SchemaDefinition } from './schemaRegistry.js'
import type { Schema } from './schemaForm.js'

/** project 配置 schema id（ProjectConfigEditor 消费） */
export const PROJECT_CONFIG_SCHEMA_ID = 'system.project.config'

/** 项目类型选项（与主进程 PROJECT_TYPES 对齐；patch 可扩展） */
const TYPE_OPTIONS = [
  { value: '2d', labelKey: 'system.launcher.type2d' },
  { value: '3d', labelKey: 'system.launcher.type3d' },
]

/** 布局树：基本（name/type/entry）→ 命名空间（defaultNamespace + namespaces 数组）→ 分域参数（rendering/input/physics/build） */
const schema: Schema = [
  {
    id: `${PROJECT_CONFIG_SCHEMA_ID}.general`,
    kind: 'group',
    titleKey: 'system.projectConfig.section.general',
    children: [
      {
        id: `${PROJECT_CONFIG_SCHEMA_ID}.general.name`,
        kind: 'field',
        field: {
          key: 'name',
          type: 'text',
          labelKey: 'system.projectConfig.field.name',
          helperKey: 'system.projectConfig.field.nameHelper',
          required: true,
        },
      },
      {
        id: `${PROJECT_CONFIG_SCHEMA_ID}.general.type`,
        kind: 'field',
        field: {
          key: 'type',
          type: 'select',
          labelKey: 'system.projectConfig.field.type',
          helperKey: 'system.projectConfig.field.typeHelper',
          options: TYPE_OPTIONS,
        },
      },
      {
        id: `${PROJECT_CONFIG_SCHEMA_ID}.general.languages`,
        kind: 'field',
        field: {
          key: 'languages',
          type: 'system.lang-list',
          labelKey: 'system.projectConfig.field.languages',
          helperKey: 'system.projectConfig.field.languagesHelper',
        },
      },
    ],
  },
  {
    id: `${PROJECT_CONFIG_SCHEMA_ID}.namespace`,
    kind: 'group',
    titleKey: 'system.projectConfig.section.namespace',
    children: [
      {
        id: `${PROJECT_CONFIG_SCHEMA_ID}.namespace.defaultNamespace`,
        kind: 'field',
        field: {
          key: 'defaultNamespace',
          type: 'text',
          labelKey: 'system.projectConfig.field.defaultNamespace',
          helperKey: 'system.projectConfig.field.defaultNamespaceHelper',
          required: true,
        },
      },
      {
        id: `${PROJECT_CONFIG_SCHEMA_ID}.namespace.namespaces`,
        kind: 'array',
        key: 'namespaces',
        titleKey: 'system.projectConfig.field.namespaceList',
        item: {
          key: 'namespaces',
          type: 'text',
          labelKey: 'system.projectConfig.field.namespaceName',
          helperKey: 'system.projectConfig.field.namespaceNameHelper',
          placeholder: 'demo',
        },
        minItems: 1,
      },
    ],
  },
  {
    id: `${PROJECT_CONFIG_SCHEMA_ID}.settings`,
    kind: 'group',
    titleKey: 'system.projectConfig.section.settings',
    children: [
      {
        id: `${PROJECT_CONFIG_SCHEMA_ID}.settings.rendering`,
        kind: 'group',
        titleKey: 'system.projectConfig.field.rendering',
        children: [
          {
            id: `${PROJECT_CONFIG_SCHEMA_ID}.settings.rendering.targetFps`,
            kind: 'field',
            field: {
              key: 'settings.rendering.targetFps',
              type: 'number',
              labelKey: 'system.projectConfig.field.targetFps',
              min: 1,
              max: 240,
              step: 1,
              defaultValue: 60,
            },
          },
          {
            id: `${PROJECT_CONFIG_SCHEMA_ID}.settings.rendering.vsync`,
            kind: 'field',
            field: {
              key: 'settings.rendering.vsync',
              type: 'switch',
              labelKey: 'system.projectConfig.field.vsync',
              defaultValue: false,
            },
          },
          {
            id: `${PROJECT_CONFIG_SCHEMA_ID}.settings.rendering.pixelRatio`,
            kind: 'field',
            field: {
              key: 'settings.rendering.pixelRatio',
              type: 'number',
              labelKey: 'system.projectConfig.field.pixelRatio',
              min: 1,
              max: 4,
              step: 0.25,
              defaultValue: 1,
            },
          },
          {
            id: `${PROJECT_CONFIG_SCHEMA_ID}.settings.rendering.backgroundColor`,
            kind: 'field',
            field: {
              key: 'settings.rendering.backgroundColor',
              type: 'text',
              labelKey: 'system.projectConfig.field.backgroundColor',
              placeholder: '#1c2127',
              defaultValue: '#1c2127',
            },
          },
        ],
      },
      {
        id: `${PROJECT_CONFIG_SCHEMA_ID}.settings.input`,
        kind: 'group',
        titleKey: 'system.projectConfig.field.input',
        children: [
          {
            id: `${PROJECT_CONFIG_SCHEMA_ID}.settings.input.moveSpeed`,
            kind: 'field',
            field: {
              key: 'settings.input.moveSpeed',
              type: 'number',
              labelKey: 'system.projectConfig.field.moveSpeed',
              min: 0,
              step: 10,
              defaultValue: 200,
              unit: 'px/s',
            },
          },
        ],
      },
      {
        id: `${PROJECT_CONFIG_SCHEMA_ID}.settings.physics`,
        kind: 'group',
        titleKey: 'system.projectConfig.field.physics',
        children: [
          {
            id: `${PROJECT_CONFIG_SCHEMA_ID}.settings.physics.gravity`,
            kind: 'field',
            field: {
              key: 'settings.physics.gravity',
              type: 'number',
              labelKey: 'system.projectConfig.field.gravity',
              defaultValue: 9.8,
              step: 0.1,
            },
          },
          {
            id: `${PROJECT_CONFIG_SCHEMA_ID}.settings.physics.timeScale`,
            kind: 'field',
            field: {
              key: 'settings.physics.timeScale',
              type: 'number',
              labelKey: 'system.projectConfig.field.timeScale',
              min: 0,
              max: 10,
              step: 0.1,
              defaultValue: 1,
            },
          },
        ],
      },
      {
        id: `${PROJECT_CONFIG_SCHEMA_ID}.settings.build`,
        kind: 'group',
        titleKey: 'system.projectConfig.field.build',
        children: [
          {
            id: `${PROJECT_CONFIG_SCHEMA_ID}.settings.build.outputDir`,
            kind: 'field',
            field: {
              key: 'settings.build.outputDir',
              type: 'text',
              labelKey: 'system.projectConfig.field.outputDir',
              placeholder: 'dist',
              defaultValue: 'dist',
            },
          },
          {
            id: `${PROJECT_CONFIG_SCHEMA_ID}.settings.build.minify`,
            kind: 'field',
            field: {
              key: 'settings.build.minify',
              type: 'switch',
              labelKey: 'system.projectConfig.field.minify',
              defaultValue: true,
            },
          },
        ],
      },
    ],
  },
]

/** 按点路径在嵌套对象取值（返回 undefined 表示缺） */
function getAtPath(root: Record<string, unknown>, segments: string[]): unknown {
  let node: unknown = root
  for (const seg of segments) {
    if (node === undefined || node === null || typeof node !== 'object' || Array.isArray(node)) {
      return undefined
    }
    node = (node as Record<string, unknown>)[seg]
  }
  return node
}

/** 按点路径把值写入嵌套对象（沿途自动建中间对象） */
function setAtPath(root: Record<string, unknown>, segments: string[], value: unknown): void {
  let node: Record<string, unknown> = root
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    const next = node[seg]
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      const created: Record<string, unknown> = {}
      node[seg] = created
      node = created
    } else {
      node = next as Record<string, unknown>
    }
  }
  node[segments[segments.length - 1]] = value
}

/** 解析点路径（过滤空段） */
function parsePath(key: string): string[] {
  return key
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * 从 project.json meta（嵌套）→ 扁平表单值。
 * 只取 schema 声明的字段 key（其余字段如 id/dirName/path/createdAt… 不进入表单，只读展示）。
 * 特判：languages 是对象数组（{id, display_name}），schemaForm 值模型不支持对象数组，
 * 编码为 JSON 字符串存扁平值（渲染器 system.lang-list 内部 parse/stringify）。
 */
export function projectMetaToForm(meta: Record<string, unknown>): FormValues {
  const out: FormValues = {}
  for (const key of collectAllFieldKeys(schema)) {
    const v = getAtPath(meta, parsePath(key))
    if (v !== undefined && v !== null) {
      if (key === 'languages') {
        out[key] = JSON.stringify(v)
      } else {
        out[key] = (Array.isArray(v) ? v : v) as FormValues[keyof FormValues]
      }
    }
  }
  return out
}

/** 收集布局树中全部字段 key（含数组） */
function collectAllFieldKeys(nodes: Schema, keys: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === 'field') keys.push(node.field.key)
    else if (node.kind === 'group') collectAllFieldKeys(node.children, keys)
    else keys.push(node.key)
  }
  return keys
}

/**
 * 扁平表单值 → 嵌套 patch（只含被修改的字段；点路径展开成嵌套对象）。
 * 主进程 updateMeta 会把 patch 深合并到磁盘 meta（数组/标量替换）。
 */
export function projectFormToPatch(values: FormValues): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(values)) {
    const v = values[key]
    if (v === undefined || v === null) continue
    if (key === 'languages' && typeof v === 'string') {
      // languages 扁平值是 JSON 字符串 → 还原为对象数组写盘
      let parsed: unknown
      try {
        parsed = JSON.parse(v)
      } catch {
        parsed = []
      }
      setAtPath(patch, parsePath(key), parsed)
      continue
    }
    setAtPath(patch, parsePath(key), v)
  }
  return patch
}

/** project 配置 schema 定义（注册到 SchemaRegistry；ProjectConfigEditor 取用渲染） */
export const projectConfigSchema: SchemaDefinition = {
  id: PROJECT_CONFIG_SCHEMA_ID,
  titleKey: 'system.projectConfig.title',
  schema,
}
