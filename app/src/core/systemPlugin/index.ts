/**
 * system 插件入口 —— 导出系统内置插件单例。
 *
 * 拆分（按业务域，见 docs/design/plugin-system.md §6）：
 * - SystemPlugin.ts：类封装，三级生命周期调度各业务域 register / setup 函数
 * - menus.ts：跨域菜单集中（文件/编辑/视图/帮助）
 * - project.ts：项目配置（schema/资源类型/编辑器/MCP 命令/创建项目 schema/资源管理器面板/inspector 面板/postInit schema patch）
 * - lang.ts：.lang 资源（资源类型/编辑器/MCP 命令/postInit 历史注册）
 * - history.ts：历史操作（MCP 命令/postInit projectConfig 历史注册）
 * - settings.ts：设置/布局/i18n（MCP 命令/命令占位/设置语言联动订阅）
 * - demo.ts：组件演示（schema/渲染器/帮助菜单 demo 项）
 *
 * 单例：appCore 通过 import { systemPlugin } 装配。
 */
import { SystemPlugin } from './SystemPlugin.js'

/** 系统内置插件单例（appCore 装配入口） */
export const systemPlugin = new SystemPlugin()
