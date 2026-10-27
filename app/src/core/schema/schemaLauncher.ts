/**
 * schemaLauncher —— 启动器"新建项目"表单的 schema 定义。
 *
 * 把 ProjectLauncher 的新建项目对话框迁移为 Schema 驱动渲染：
 * - 字段：name（必填）/ type（select: 2d/3d）/ defaultNamespace（text）
 * - 文案复用 system.launcher.* i18n key（launcherStrings.ts）
 * - 值生命周期：宿主用 createMemoryStore 承载（本地编辑，确定时提交），不落 store
 *
 * 后续扩展（schema patch）：插件可通过 schema 链 key（如 "type.options"）编辑本 schema 节点，
 * 例如给 type 增加 2.5D 选项（见 docs/design/schema-driven-ui.md 第 6 节）。
 */
import type { SchemaDefinition } from './schemaRegistry.js'
import type { Schema } from './schemaForm.js'

/** 创建项目表单 schema id（ProjectLauncher 消费） */
export const CREATE_PROJECT_SCHEMA_ID = 'system.launcher.createProject'

/** 布局树：name → type → defaultNamespace（竖排） */
const schema: Schema = [
  {
    id: `${CREATE_PROJECT_SCHEMA_ID}.name`,
    kind: 'field',
    field: {
      key: 'name',
      type: 'text',
      labelKey: 'system.launcher.projectName',
      helperKey: 'system.launcher.projectNameHelper',
      placeholderKey: 'system.launcher.projectNamePlaceholder',
      required: true,
    },
  },
  {
    id: `${CREATE_PROJECT_SCHEMA_ID}.type`,
    kind: 'field',
    field: {
      key: 'type',
      type: 'select',
      labelKey: 'system.launcher.projectType',
      helperKey: 'system.launcher.projectTypeHelper',
      defaultValue: '2d',
      options: [
        { value: '2d', labelKey: 'system.launcher.type2d' },
        { value: '3d', labelKey: 'system.launcher.type3d' },
      ],
    },
  },
  {
    id: `${CREATE_PROJECT_SCHEMA_ID}.defaultNamespace`,
    kind: 'field',
    field: {
      key: 'defaultNamespace',
      type: 'text',
      labelKey: 'system.launcher.defaultNamespace',
      helperKey: 'system.launcher.defaultNamespaceHelper',
      placeholderKey: 'system.launcher.defaultNamespacePlaceholder',
    },
  },
]

/** 创建项目表单 schema 定义 */
export const createProjectSchema: SchemaDefinition = {
  id: CREATE_PROJECT_SCHEMA_ID,
  titleKey: 'system.launcher.newProject',
  schema,
}
