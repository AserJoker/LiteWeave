/**
 * project 业务域 —— 项目配置 / 创建项目 / 资源管理器 / 检视器。
 *
 * 内容：
 * - schema：创建项目 schema + 项目配置 schema + lang-list 渲染器（项目配置语言列表字段用）
 * - 资源类型 + 编辑器：project.json → ProjectConfigEditor
 * - 侧边栏面板：资源管理器（explorer）+ 检视器（inspector）
 * - MCP 命令：项目生命周期（open/create/close/import/export/remove）+ 项目配置（set/open）+ 资源管理器（resource:open/create/delete/write + dir:create/delete + resource:rename）
 * - postInit：给创建项目 schema 的 type 字段加 2.5D 选项（演示 schema patch 就地生效）
 */
import type { PluginContext } from '../module.js'
import { CREATE_PROJECT_SCHEMA_ID, createProjectSchema } from '../schema/schemaLauncher.js'
import { projectConfigSchema } from '../schema/schemaProjectConfig.js'
import { LANG_LIST_TYPE, langListRenderer } from '../schema/schemaBuiltinRenderers.js'
import {
  PROJECT_CONFIG_RESOURCE_TYPE,
  PROJECT_META_FILE,
  type ResourceType,
} from '../resources/resourceTypes.js'
import { ProjectConfigEditor } from '../../components/editors/ProjectConfigEditor.js'
import { ExplorerPanel } from '../../components/Sidebar/ExplorerPanel.js'
import { InspectorPanel } from '../../components/Sidebar/InspectorPanel.js'

/** init：注册 project 域 schema / 资源类型 / 编辑器 / 面板 / MCP 命令 */
export function registerProject(ctx: PluginContext): void {
  /* ---- schema ---- */
  ctx.schemas.register(createProjectSchema)
  ctx.schemas.register(projectConfigSchema)
  ctx.schemaRenderers.register(LANG_LIST_TYPE, langListRenderer)

  /* ---- 资源类型 + 编辑器 ---- */
  const projectConfigResourceType: ResourceType = {
    type: PROJECT_CONFIG_RESOURCE_TYPE,
    titleKey: 'system.projectConfig.title',
    icon: 'cog',
    matches: (node) => node.type === 'file' && node.name === PROJECT_META_FILE,
  }
  ctx.resourceTypes.register(projectConfigResourceType)
  ctx.editors.register(PROJECT_CONFIG_RESOURCE_TYPE, ({ tab }) => <ProjectConfigEditor path={tab.path} />)

  /* ---- 侧边栏面板：资源管理器（左）+ 检视器（右） ---- */
  ctx.panels.register({
    id: 'explorer',
    titleKey: 'system.menu.view.explorer',
    icon: 'folder-open',
    component: ExplorerPanel,
    side: 'left',
  })
  ctx.panels.register({
    id: 'inspector',
    titleKey: 'system.menu.view.inspector',
    icon: 'properties',
    component: InspectorPanel,
    side: 'right',
  })

  /* ---- MCP 命令：项目生命周期 ---- */
  ctx.mcpCommands.register({
    name: 'system.project:open',
    description: '打开项目',
    args: { id: { type: 'string', optional: true, description: '项目 id（缺省回到启动器）' } },
  })
  ctx.mcpCommands.register({
    name: 'system.project:create',
    description: '新建项目并打开',
    args: {
      name: { type: 'string', description: '项目名' },
      type: { type: 'string', optional: true, enum: ['2d', '3d'], description: '项目类型，默认 2d' },
      defaultNamespace: { type: 'string', optional: true, description: '默认命名空间（默认=项目名小写）' },
    },
  })
  ctx.mcpCommands.register({ name: 'system.project:close', description: '关闭当前项目' })
  ctx.mcpCommands.register({ name: 'system.project:import', description: '导入 .liteweave 项目包（弹系统文件框）' })
  ctx.mcpCommands.register({
    name: 'system.project:export',
    description: '导出项目为 .liteweave 包',
    args: { id: { type: 'string', optional: true, description: '项目 id（缺省当前项目）' } },
  })
  ctx.mcpCommands.register({
    name: 'system.project:remove',
    description: '删除项目',
    args: { id: { type: 'string', description: '项目 id' } },
  })

  /* ---- MCP 命令：项目配置 ---- */
  ctx.mcpCommands.register({
    name: 'system.project:config:set',
    description: '写 project.json 配置（可视化配置编辑器 / AI 共用链路）',
    args: { patch: { type: 'object', description: '嵌套补丁对象，深合并到 project.json' } },
  })
  ctx.mcpCommands.register({
    name: 'system.project:config:open',
    description: '打开项目配置编辑器（菜单"文件→项目配置"等价操作；打开 ProjectConfigEditor 标签）',
  })

  /* ---- MCP 命令：资源管理器（打开/创建/删除/写/重命名 + 目录创建/删除） ---- */
  ctx.mcpCommands.register({
    name: 'system.resource:open',
    description: '打开资源（资源管理器点击文件等价操作）：匹配资源类型 → 打开编辑器标签',
    args: {
      path: { type: 'string', description: '资源虚拟路径（相对项目根，/ 分隔，如 project.json）' },
      name: { type: 'string', description: '资源文件名（如 project.json）' },
    },
  })
  ctx.mcpCommands.register({
    name: 'system.resource:create',
    description: '创建资源文件（同步维护 project.json 资源清单，type 按后缀推断）；已存在返回 error',
    args: {
      path: { type: 'string', optional: true, description: '目标虚拟路径（相对项目根，如 assets/demo/i18n/zh_CN.lang）' },
      name: { type: 'string', optional: true, description: '文件名（如 zh_CN.lang）；path 缺省时用 默认命名空间/name 组装' },
      namespace: { type: 'string', optional: true, description: '命名空间（path 缺省时用，默认 defaultNamespace）' },
      content: { type: 'string', optional: true, description: '初始文件内容（UTF-8 文本）' },
    },
  })
  ctx.mcpCommands.register({
    name: 'system.resource:delete',
    description: '删除资源文件（同步从 project.json 资源清单移除）；不存在返回 error',
    args: {
      path: { type: 'string', description: '资源虚拟路径（相对项目根，如 assets/demo/i18n/zh_CN.lang）' },
    },
  })
  ctx.mcpCommands.register({
    name: 'system.resource:write',
    description: '写资源文件内容（UTF-8 文本；父目录自动创建），不维护资源清单',
    args: {
      path: { type: 'string', description: '资源虚拟路径（相对项目根）' },
      content: { type: 'string', description: '文件内容（UTF-8 文本）' },
    },
  })
  ctx.mcpCommands.register({
    name: 'system.dir:create',
    description: '创建目录（自由创建，不限层级）；已存在返回 error',
    args: {
      path: { type: 'string', description: '目标虚拟路径（相对项目根，如 assets/demo/i18n/sub）' },
    },
  })
  ctx.mcpCommands.register({
    name: 'system.dir:delete',
    description: '删除目录（递归删除整个目录树）；不存在返回 error',
    args: {
      path: { type: 'string', description: '目标虚拟路径（相对项目根）' },
    },
  })
  ctx.mcpCommands.register({
    name: 'system.resource:rename',
    description: '重命名/移动文件或目录（fs.rename；同步 project.json 资源清单）',
    args: {
      oldPath: { type: 'string', description: '源虚拟路径（相对项目根）' },
      newPath: { type: 'string', description: '目标虚拟路径（相对项目根）' },
    },
  })
}

/** postInit：给创建项目 schema 的 type 字段加 2.5D 选项（演示 schema patch 就地生效） */
export function setupProject(ctx: PluginContext): void {
  ctx.schemas.patch(CREATE_PROJECT_SCHEMA_ID, `${CREATE_PROJECT_SCHEMA_ID}.type`, {
    field: {
      options: [
        { value: '2d', labelKey: 'system.launcher.type2d' },
        { value: '3d', labelKey: 'system.launcher.type3d' },
        { value: '2.5d', labelKey: 'system.launcher.type25d' },
      ],
    },
  })
}
