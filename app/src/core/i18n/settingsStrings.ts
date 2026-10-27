/**
 * system.settings 子命名空间字符串 —— 设置对话框文案。
 *
 * 并入 system 保留命名空间（由 systemStrings.ts 聚合，框架预置）。
 * key 形如 system.settings.title / system.settings.field.language 等。
 *
 * 结构：settings.title / settings.search / settings.empty 为对话框级文案；
 * settings.section.<大类id> 为大类名；settings.item.<小类id> 为小类名；
 * settings.field.<字段key>(Helper) 为字段 label / helper；
 * settings.option.<值> 为 select 选项显示文案。
 * 字段 placeholder 是示例值而非翻译文案，不注册 i18n。
 */

export const settingsZhCN = {
  settings: {
    title: '设置',
    search: '搜索设置…',
    empty: '无匹配项',
    section: {
      general: '通用',
      editor: '编辑器',
      project: '项目',
    },
    // 小类名：按大类分组（不同大类下小类 id 可重复，如 general.behavior / ai.behavior）
    item: {
      general: {
        appearance: '外观',
        behavior: '行为',
      },
      editor: {
        scene: '场景',
        animation: '动画',
      },
      project: {
        paths: '路径',
        sync: '同步',
      },
    },
    field: {
      language: '界面语言',
      languageHelper: '编辑器界面使用的语言',
      theme: '主题',
      themeHelper: '界面主题',
      fontSize: '界面字号',
      fontSizeHelper: '单位 px',
      autoSave: '自动保存',
      autoSaveHelper: '编辑资源时自动保存到磁盘',
      confirmDelete: '删除前确认',
      confirmDeleteHelper: '删除资源前弹出确认框',
      gridSize: '网格大小',
      gridSizeHelper: '场景编辑器网格间距（px）',
      showGrid: '显示网格',
      showGridHelper: '场景编辑区显示网格',
      snapToGrid: '吸附网格',
      snapToGridHelper: '拖动对象时吸附到网格',
      defaultFps: '默认帧率',
      defaultFpsHelper: '新建动画的默认 FPS',
      onionSkin: '洋葱皮',
      onionSkinHelper: '动画编辑器显示前后帧',
      defaultProject: '默认项目目录',
      autoOpenLast: '启动时打开上次项目',
      autoRefresh: '自动刷新资源',
      autoRefreshHelper: '文件系统变化时自动刷新资源树',
      watchExternal: '监听外部修改',
      watchExternalHelper: '检测项目目录的外部改动',
    },
    option: {
      zh_CN: '简体中文',
      en_US: 'English',
      dark: '深色',
      light: '浅色',
    },
  },
}

export const settingsEnUS = {
  settings: {
    title: 'Settings',
    search: 'Search settings…',
    empty: 'No matches',
    section: {
      general: 'General',
      editor: 'Editor',
      project: 'Project',
    },
    // 小类名：按大类分组（不同大类下小类 id 可重复，如 general.behavior / ai.behavior）
    item: {
      general: {
        appearance: 'Appearance',
        behavior: 'Behavior',
      },
      editor: {
        scene: 'Scene',
        animation: 'Animation',
      },
      project: {
        paths: 'Paths',
        sync: 'Sync',
      },
    },
    field: {
      language: 'Language',
      languageHelper: 'Language used for the editor UI',
      theme: 'Theme',
      themeHelper: 'UI theme',
      fontSize: 'UI Font Size',
      fontSizeHelper: 'in px',
      autoSave: 'Auto Save',
      autoSaveHelper: 'Automatically save resources to disk while editing',
      confirmDelete: 'Confirm Before Delete',
      confirmDeleteHelper: 'Show a confirmation dialog before deleting resources',
      gridSize: 'Grid Size',
      gridSizeHelper: 'Scene editor grid spacing (px)',
      showGrid: 'Show Grid',
      showGridHelper: 'Show grid in the scene editor',
      snapToGrid: 'Snap to Grid',
      snapToGridHelper: 'Snap objects to the grid when dragging',
      defaultFps: 'Default FPS',
      defaultFpsHelper: 'Default FPS for new animations',
      onionSkin: 'Onion Skin',
      onionSkinHelper: 'Show previous/next frames in the animation editor',
      defaultProject: 'Default Project Directory',
      autoOpenLast: 'Reopen Last Project on Startup',
      autoRefresh: 'Auto Refresh Assets',
      autoRefreshHelper: 'Refresh the asset tree when files change',
      watchExternal: 'Watch External Changes',
      watchExternalHelper: 'Detect external changes to the project directory',
    },
    option: {
      zh_CN: '简体中文',
      en_US: 'English',
      dark: 'Dark',
      light: 'Light',
    },
  },
}
