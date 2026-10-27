/**
 * core —— LiteWeave 底层框架入口。
 *
 * 提供三层结构：
 * - 事件总线（事件驱动底层）：EventBus
 * - 命令总线（命令驱动上层雏形）：CommandBus，命令作为事件的一种类型
 * - 插件注册表（插件化注册）：PluginHost，插件导出 preInit/init/postInit/dispose，
 *   在 init 中向 ctx 暴露的各注册器（events/commands/schemas/resourceTypes/editors/panels/menus/mcpCommands…）注册自己的资源
 *
 * 后续：设置/资源/编辑器等插件、撤销重做、脏标记等都建立在此之上。
 */
import { EventBus } from './EventBus.js'
import { createCommandBus, type CommandBus } from './commandBus.js'
import { createPluginHost, type PluginHost } from './moduleManager.js'
import type { ModuleContext, PluginContext } from './module.js'
import type { IEventBus } from './types.js'
import { createI18nRegistry, type I18nRegistry } from './i18n/i18nRegistry.js'
import { createSchemaRegistry, type SchemaRegistry } from './schema/schemaRegistry.js'
import { createSchemaRendererRegistry, type SchemaRendererRegistry } from './schema/schemaRenderers.js'
import {
  createResourceTypeRegistry,
  setDefaultResourceRegistry,
  type ResourceTypeRegistry,
} from './resources/resourceTypes.js'
import { createEditorRegistry, type EditorRegistry } from './plugins/editorRegistry.js'
import { createPanelRegistry, type PanelRegistry } from './plugins/panelRegistry.js'
import { createMenuRegistry, type MenuRegistry } from './plugins/menuRegistry.js'
import { createMcpCommandRegistry, type McpCommandRegistry } from './plugins/mcpCommandRegistry.js'
import { createTransportForEnv, type Transport } from './transport/index.js'

export { EventBus } from './EventBus.js'
export { SYSTEM_NAMESPACE, systemCommand } from './namespace.js'
export { createCommandBus, COMMAND_PREFIX, commandEventName } from './commandBus.js'
export { createPluginHost } from './moduleManager.js'
export { createI18nRegistry } from './i18n/i18nRegistry.js'
export { createSchemaRegistry } from './schema/schemaRegistry.js'
export { createSchemaRendererRegistry } from './schema/schemaRenderers.js'
export { createResourceTypeRegistry } from './resources/resourceTypes.js'
export { createEditorRegistry } from './plugins/editorRegistry.js'
export { createPanelRegistry } from './plugins/panelRegistry.js'
export { createMenuRegistry } from './plugins/menuRegistry.js'
export { createMcpCommandRegistry } from './plugins/mcpCommandRegistry.js'
export type { SchemaRegistry, SchemaDefinition } from './schema/schemaRegistry.js'
export type { HistoryApi, HistoryItem, HistoryStack, HistoryChangedPayload } from './history/historyModule.js'
export type { SchemaRendererRegistry, RenderContext, FieldRenderer } from './schema/schemaRenderers.js'
export type { Schema, SchemaNode, FieldSchema, AnyFieldSchema, CustomFieldSchema, CustomTypeId } from './schema/schemaForm.js'
export type { ResourceTypeRegistry, ResourceType, ResourceTypeId } from './resources/resourceTypes.js'
export type { EditorRegistry, EditorComponent, EditorProps } from './plugins/editorRegistry.js'
export type { PanelRegistry, PanelDefinition, PanelSide } from './plugins/panelRegistry.js'
export type { MenuRegistry, MenuDef, MenuItemDef } from './plugins/menuRegistry.js'
export type { McpCommandRegistry, McpCommandDef, McpArgSchema } from './plugins/mcpCommandRegistry.js'
export {
  I18N_LOCALE_CHANGED,
  DEFAULT_LOCALE,
  PRESET_LOCALES,
} from './i18n/i18nRegistry.js'
export type {
  I18nRegistry,
  I18nDictionary,
  I18nNode,
  I18nLocale,
  LocaleChangedPayload,
} from './i18n/i18nRegistry.js'
export type { CommandBus } from './commandBus.js'
export type { PluginHost, ModuleManager } from './moduleManager.js'
export type { Plugin, Module, ModuleContext, PluginContext } from './module.js'
export type { IEventBus, EventDefinition, EventListener, Unsubscribe, Validator } from './types.js'

/**
 * 框架核心对象：持有事件总线、命令总线、插件注册表、国际化注册器、schema 注册器、
 * 资源类型/编辑器/面板/菜单/MCP 命令注册器。
 * 应用启动时创建一次，作为依赖注入给各插件/组件。
 */
export interface Core {
  readonly events: IEventBus
  readonly commands: CommandBus
  readonly plugins: PluginHost
  /** 兼容别名：plugins 即原 modules */
  readonly modules: PluginHost
  /** 国际化注册器：插件 init 时注册语言资源、t() 取字符串、setLocale 切换语言 */
  readonly i18n: I18nRegistry
  /** 表单 schema 注册器：插件 init 时注册表单契约，SchemaForm 渲染 */
  readonly schemas: SchemaRegistry
  /** 自定义控件渲染器注册器：插件 init 时注册控件类型渲染函数，SchemaForm 遇到该 type 自动渲染 */
  readonly schemaRenderers: SchemaRendererRegistry
  /** 资源类型注册器：文件 → 类型 → 编辑器/图标 */
  readonly resourceTypes: ResourceTypeRegistry
  /** 编辑器注册器：资源类型 id → 编辑器渲染组件 */
  readonly editors: EditorRegistry
  /** 侧边栏面板注册器：面板 id → 标题/图标/渲染组件 */
  readonly panels: PanelRegistry
  /** 菜单注册器：菜单项声明（含命令绑定） */
  readonly menus: MenuRegistry
  /** MCP 命令注册器：命令元数据，聚合后回传主进程 */
  readonly mcpCommands: McpCommandRegistry
  /** 通讯通道：业务模块经它做前后端交互（Electron=IPC / Web=HTTP，协议统一 endpoint+JSON） */
  readonly transport: Transport
  /** 服务容器：各插件/模块把公开 API 挂到 services.<id>（组件/SSE 客户端取用） */
  readonly services: Record<string, unknown>
}

export interface CreateCoreOptions {
  /** 自定义通讯通道（默认按环境检测：Electron→IPC，Web→HTTP 占位） */
  transport?: Transport
  /** 插件宿主就绪动作（如聚合回传 MCP 命令清单） */
  onReady?: (ctx: PluginContext) => void | Promise<void>
}

export function createCore(options: CreateCoreOptions = {}): Core {
  const events = new EventBus()
  const commands = createCommandBus(events)
  const i18n = createI18nRegistry(events)
  const schemas = createSchemaRegistry()
  const schemaRenderers = createSchemaRendererRegistry()
  const resourceTypes = createResourceTypeRegistry()
  const editors = createEditorRegistry()
  const panels = createPanelRegistry()
  const menus = createMenuRegistry()
  const mcpCommands = createMcpCommandRegistry()
  const services: Record<string, unknown> = {}
  const transport = options.transport ?? createTransportForEnv()
  // 插件上下文：插件 init 时通过它访问各注册器
  // 注意：modules（宿主自身）有循环引用——先建 ctx（缺 modules），建宿主后补挂
  const ctx: ModuleContext = {
    events,
    commands,
    i18n,
    schemas,
    schemaRenderers,
    resourceTypes,
    editors,
    panels,
    menus,
    mcpCommands,
    transport,
    services,
    modules: undefined as unknown as PluginHost,
  }
  const plugins = createPluginHost(ctx, { onReady: options.onReady })
  // 补挂宿主自身到 ctx.modules（插件 init 前注册子模块用）
  ctx.modules = plugins
  // 兼容：把默认资源类型注册器注入 resourceTypes.ts（供 matchResourceType/tabForResource 兼容函数回退）
  setDefaultResourceRegistry(resourceTypes)

  return {
    events,
    commands,
    plugins,
    modules: plugins,
    i18n,
    schemas,
    schemaRenderers,
    resourceTypes,
    editors,
    panels,
    menus,
    mcpCommands,
    transport,
    services,
  }
}
