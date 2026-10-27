/**
 * 模块/插件注册 —— 插件接口与插件上下文类型。
 *
 * 架构约定（用户定案，见 docs/design/plugin-system.md）：
 * - 插件注册的本质是“向各个已有的注册器注册自己的资源”。
 * - 一个插件 = 一个端到端业务域；系统内置用一个 system 插件承载全部系统资源。
 * - 插件生命周期三级钩子（宿主批量推进）：
 *   - preInit：配置加载生效 / 插件自身初始化（其它插件资源尚未注册，不能引用）
 *   - init：注册资源 + 初始化订阅（向 ctx 暴露的各注册器声明资源）
 *   - postInit：patch 资源 / 与其他插件联动（所有插件 init 完成后执行）
 * - 插件间不直接引用，只通过注册器/事件通信。
 *
 * 兼容：原 Module（单级 init）即只用了二级钩子的插件（Plugin 别名）。
 */
import type { CommandBus } from './commandBus.js'
import type { PluginHost } from './moduleManager.js'
import type { IEventBus } from './types.js'
import type { I18nRegistry } from './i18n/i18nRegistry.js'
import type { SchemaRegistry } from './schema/schemaRegistry.js'
import type { SchemaRendererRegistry } from './schema/schemaRenderers.js'
import type { ResourceTypeRegistry } from './resources/resourceTypes.js'
import type { EditorRegistry } from './plugins/editorRegistry.js'
import type { PanelRegistry } from './plugins/panelRegistry.js'
import type { MenuRegistry } from './plugins/menuRegistry.js'
import type { McpCommandRegistry } from './plugins/mcpCommandRegistry.js'
import type { Transport } from './transport/index.js'

/**
 * 插件上下文：暴露给插件的各注册器。
 * 随框架演进扩展：settings / ui / resources / commands 等注册器都会挂到这里。
 */
export interface ModuleContext {
  /** 事件注册器：define 事件契约、subscribe/emit */
  readonly events: IEventBus
  /** 命令注册器：onCommand 注册命令 handler、runCommand 发起命令 */
  readonly commands: CommandBus
  /** 插件宿主：插件可在 init 前注册子模块（宿主统一调度三级生命周期）；register 只登记不执行 */
  modules: PluginHost
  /** 国际化注册器：插件 init 时 register 自己的语言资源，组件用 t() 取字符串 */
  readonly i18n: I18nRegistry
  /** 表单 schema 注册器：插件 init 时 register 自己的表单契约，SchemaForm 渲染 */
  readonly schemas: SchemaRegistry
  /** 自定义控件渲染器注册器：插件 init 时 register 自己的控件类型渲染函数，SchemaForm 遇到该 type 自动渲染 */
  readonly schemaRenderers: SchemaRendererRegistry
  /** 资源类型注册器：文件 → 类型 → 编辑器/图标 */
  readonly resourceTypes: ResourceTypeRegistry
  /** 编辑器注册器：资源类型 id → 编辑器渲染组件（WorkspaceTabs 按注册表分派） */
  readonly editors: EditorRegistry
  /** 侧边栏面板注册器：面板 id → 标题/图标/渲染组件（Left/RightSidebar 按注册表渲染） */
  readonly panels: PanelRegistry
  /** 菜单注册器：菜单项声明（含命令绑定）（MenuBar 按注册表渲染） */
  readonly menus: MenuRegistry
  /** MCP 命令注册器：命令元数据，聚合后回传主进程 */
  readonly mcpCommands: McpCommandRegistry
  /** 通讯通道：模块经它做前后端交互（Electron=IPC / Web=HTTP，协议统一 endpoint+JSON） */
  readonly transport: Transport
  /** 服务容器：各插件/模块把公开 API 挂到 services.<id>（core.services 供组件/SSE 客户端取用） */
  readonly services: Record<string, unknown>
}

/** 兼容别名：ModuleContext 即 PluginContext */
export type PluginContext = ModuleContext

/**
 * 插件接口。
 * - id：全局唯一插件标识（建议命名空间风格，如 "system"、"mycompany.terrain"）
 * - preInit：配置加载生效 / 插件自身初始化；其它插件资源尚未注册，不能引用；可选
 * - init：注册资源 + 初始化订阅；必填
 * - postInit：patch 资源 / 与其他插件联动（所有插件 init 完成后执行）；可选
 * - dispose：卸载协议（尽力而为，不保证真正移除）；可选
 */
export interface Plugin {
  readonly id: string
  readonly version?: string
  readonly nameKey?: string
  preInit?(ctx: PluginContext): void | Promise<void>
  init(ctx: PluginContext): void | Promise<void>
  postInit?(ctx: PluginContext): void | Promise<void>
  dispose?(): void | Promise<void>
}

/** 兼容别名：原 Module 即 Plugin（单级 init 的模块可视为只用了二级钩子的插件） */
export type Module = Plugin
