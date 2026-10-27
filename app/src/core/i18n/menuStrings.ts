/**
 * system.menu 子命名空间字符串 —— 顶部菜单栏文案。
 *
 * 并入 system 保留命名空间（由 systemStrings.ts 聚合，框架预置）。
 * key 形如 system.menu.name.file / system.menu.file.new。
 * 结构：菜单名在 menu.name.*（避免与菜单项 menu.file.* 路径冲突），
 * 菜单项在 menu.<菜单id>.<项>。
 * 注：menu.name 是保留给菜单名的子命名空间（命名约定，不是 system 那种保留）。
 */

export const menuZhCN = {
  menu: {
    // 菜单名（system.menu.name.file / system.menu.name.edit / ...）
    name: {
      file: '文件',
      edit: '编辑',
      view: '视图',
      help: '帮助',
    },
    file: {
      newProject: '新建项目',
      open: '打开项目...',
      closeProject: '关闭项目',
      importProject: '导入项目...',
      exportProject: '导出项目...',
      projectConfig: '项目配置',
      settings: '设置',
      exit: '退出',
    },
    edit: {
      undo: '撤销',
      redo: '重做',
      cut: '剪切',
      copy: '复制',
      paste: '粘贴',
    },
    view: {
      explorer: '资源管理器',
      inspector: '检视器',
      statusbar: '状态栏',
      theme: '切换主题',
    },
    help: {
      docs: '文档',
      about: '关于 LiteWeave',
    },
  },
}

export const menuEnUS = {
  menu: {
    name: {
      file: 'File',
      edit: 'Edit',
      view: 'View',
      help: 'Help',
    },
    file: {
      newProject: 'New Project',
      open: 'Open Project...',
      closeProject: 'Close Project',
      importProject: 'Import Project...',
      exportProject: 'Export Project...',
      projectConfig: 'Project Settings',
      settings: 'Settings',
      exit: 'Exit',
    },
    edit: {
      undo: 'Undo',
      redo: 'Redo',
      cut: 'Cut',
      copy: 'Copy',
      paste: 'Paste',
    },
    view: {
      explorer: 'Explorer',
      inspector: 'Inspector',
      statusbar: 'Status Bar',
      theme: 'Toggle Theme',
    },
    help: {
      docs: 'Docs',
      about: 'About LiteWeave',
    },
  },
}
