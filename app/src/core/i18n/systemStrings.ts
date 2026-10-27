/**
 * system 保留命名空间的预置字符串（框架内置，createCore 时注册）。
 *
 * 系统级文案统一放在 system 下：框架自身（app/language/common）+ 各系统 UI
 * 模块（menu 菜单栏 / settings 设置对话框…）都作为 system 的子命名空间，
 * 由本文件聚合为一份完整 system 字典。key 形如 system.menu.file.new。
 *
 * 业务模块的自定义翻译不应放 system（保留命名空间），应使用自己的命名空间。
 */
import { menuZhCN, menuEnUS } from './menuStrings.js'
import { settingsZhCN, settingsEnUS } from './settingsStrings.js'
import { launcherZhCN, launcherEnUS } from './launcherStrings.js'
import { schemaZhCN, schemaEnUS } from './schemaStrings.js'
import { projectConfigZhCN, projectConfigEnUS } from './projectConfigStrings.js'
import { historyZhCN, historyEnUS } from './historyStrings.js'
import { langZhCN, langEnUS } from './langStrings.js'
import { resourceZhCN, resourceEnUS } from './resourceStrings.js'

export const systemZhCN = {
  app: {
    name: 'LiteWeave',
    tagline: '轻引擎 · 重脚本 · 数据驱动的资源编辑器 IDE',
    ready: '就绪',
  },
  language: {
    label: '界面语言',
    // 语言名显示（当前语言视角）
    zh_CN: '简体中文',
    en_US: 'English',
  },
  common: {
    confirm: '确认',
    cancel: '取消',
    ok: '确定',
    close: '关闭',
    save: '保存',
  },
  // 顶部菜单栏（menuStrings.ts）
  ...menuZhCN,
  // 设置对话框（settingsStrings.ts）
  ...settingsZhCN,
  // 启动器界面（launcherStrings.ts）
  ...launcherZhCN,
  // schema 引擎自身 + 内置示例（schemaStrings.ts）
  ...schemaZhCN,
  // project 配置编辑器（projectConfigStrings.ts）
  ...projectConfigZhCN,
  // 历史面板/历史功能（historyStrings.ts）
  ...historyZhCN,
  // 语言文件（.lang）编辑器（langStrings.ts）
  ...langZhCN,
  // 资源管理器（resourceStrings.ts）
  ...resourceZhCN,
} as const

export const systemEnUS = {
  app: {
    name: 'LiteWeave',
    tagline: 'Light engine · Heavy scripting · Data-driven asset editor IDE',
    ready: 'Ready',
  },
  language: {
    label: 'Language',
    zh_CN: '简体中文',
    en_US: 'English',
  },
  common: {
    confirm: 'Confirm',
    cancel: 'Cancel',
    ok: 'OK',
    close: 'Close',
    save: 'Save',
  },
  ...menuEnUS,
  ...settingsEnUS,
  ...launcherEnUS,
  // schema 引擎自身 + 内置示例（schemaStrings.ts）
  ...schemaEnUS,
  // project 配置编辑器（projectConfigStrings.ts）
  ...projectConfigEnUS,
  // 历史面板/历史功能（historyStrings.ts）
  ...historyEnUS,
  // 语言文件（.lang）编辑器（langStrings.ts）
  ...langEnUS,
  // 资源管理器（resourceStrings.ts）
  ...resourceEnUS,
} as const
