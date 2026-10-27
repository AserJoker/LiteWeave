/**
 * 命名空间规范 —— 全局命令/事件/字段 id 的统一前缀，用于全局隔离。
 *
 * 背景（用户定案）：
 * - 命名空间的核心作用是“隔离”：命令/事件未来插件都可以注册，
 *   系统自带的统一用 `system` 作为命名空间前缀，插件注册自己的命名空间时互不冲突。
 * - 格式：`<命名空间>.<域名>:<动作>`（命令/事件名），如 system.settings:set、system.settings:changed。
 * - 字段路径：`<命名空间>.<大类>.<小类>.<字段>`，如 system.general.appearance.language。
 *
 * 约定：
 * - 系统级命令/事件/字段统一加 `system.` 前缀；
 * - 插件/模块注册自己的命令/事件时用各自命名空间（如 myplugin.settings:set），
 *   与系统命名空间天然隔离。
 */

/** 系统保留命名空间（框架内置占用，系统级命令/事件/字段统一使用此前缀） */
export const SYSTEM_NAMESPACE = 'system'

/** 把命令/事件名规范为带系统命名空间前缀：`settings:set` -> `system.settings:set` */
export function systemCommand(name: string): string {
  return `${SYSTEM_NAMESPACE}.${name}`
}
