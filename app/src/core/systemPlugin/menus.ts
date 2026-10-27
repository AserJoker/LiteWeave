/**
 * menus —— 跨业务域菜单集中注册。
 *
 * 文件菜单含项目/设置/退出等跨域项，集中维护避免散落到各业务域文件。
 * 各菜单项通过 command 字段绑定到对应业务域注册的命令（system.project:* / system.settings:* 等）。
 */
import type { PluginContext } from '../module.js'
import { OPEN_SETTINGS_COMMAND } from '../../components/shell/MenuBar.js'
import { CREATE_PROJECT_COMMAND } from '../project/projectModule.js'

/** init：注册文件/编辑/视图/帮助四个菜单 */
export function registerMenus(ctx: PluginContext): void {
  ctx.menus.register({
    i18nKey: 'system.menu.name.file',
    items: [
      { i18nKey: 'system.menu.file.newProject', icon: 'new-object', hotkey: 'Ctrl+N', command: CREATE_PROJECT_COMMAND },
      { i18nKey: 'system.menu.file.open', icon: 'folder-open', hotkey: 'Ctrl+O', command: 'system.project:open' },
      { i18nKey: 'system.menu.file.closeProject', icon: 'log-out', dividerAfter: true, command: 'system.project:close' },
      { i18nKey: 'system.menu.file.importProject', icon: 'import', command: 'system.project:import' },
      { i18nKey: 'system.menu.file.exportProject', icon: 'export', command: 'system.project:export' },
      { i18nKey: 'system.menu.file.projectConfig', icon: 'settings', command: 'system.project:config:open', dividerAfter: true },
      { i18nKey: 'system.menu.file.settings', icon: 'cog', command: OPEN_SETTINGS_COMMAND },
      { i18nKey: 'system.menu.file.exit', icon: 'log-out' },
    ],
  })
  ctx.menus.register({
    i18nKey: 'system.menu.name.edit',
    items: [
      { i18nKey: 'system.menu.edit.undo', icon: 'undo', hotkey: 'Ctrl+Z' },
      { i18nKey: 'system.menu.edit.redo', icon: 'redo', hotkey: 'Ctrl+Y', dividerAfter: true },
      { i18nKey: 'system.menu.edit.cut', icon: 'cut', hotkey: 'Ctrl+X' },
      { i18nKey: 'system.menu.edit.copy', icon: 'duplicate', hotkey: 'Ctrl+C' },
      { i18nKey: 'system.menu.edit.paste', icon: 'clip', hotkey: 'Ctrl+V' },
    ],
  })
  ctx.menus.register({
    i18nKey: 'system.menu.name.view',
    items: [
      { i18nKey: 'system.menu.view.explorer', icon: 'folder-open' },
      { i18nKey: 'system.menu.view.inspector', icon: 'properties' },
      { i18nKey: 'system.menu.view.statusbar', icon: 'timeline-events', dividerAfter: true },
      { i18nKey: 'system.menu.view.theme', icon: 'moon' },
    ],
  })
  ctx.menus.register({
    i18nKey: 'system.menu.name.help',
    items: [
      { i18nKey: 'system.menu.help.docs', icon: 'help' },
      { i18nKey: 'system.menu.help.about', icon: 'info-sign' },
    ],
  })
}
