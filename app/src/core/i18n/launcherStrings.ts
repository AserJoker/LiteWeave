/**
 * system.launcher 子命名空间字符串 —— 启动器界面文案。
 *
 * 并入 system 保留命名空间（由 systemStrings.ts 聚合，框架预置）。
 * key 形如 system.launcher.newProject / system.launcher.updatedAt。
 */

export const launcherZhCN = {
  launcher: {
    newProject: '新建项目',
    importProject: '导入项目',
    export: '导出',
    remove: '删除',
    open: '打开',
    updatedAt: '更新于 {time}',
    emptyTitle: '还没有项目',
    loading: '正在加载项目…',
    projectName: '项目名称',
    projectNameHelper: '名称会用于项目目录与导出文件名',
    projectNamePlaceholder: '例如 MyGame',
    projectType: '项目类型',
    projectTypeHelper: '决定可创建的资源类型集合（3D 含模型/网格/材质）',
    type2d: '2D',
    type3d: '3D',
    type25d: '2.5D',
    defaultNamespace: '默认命名空间',
    defaultNamespaceHelper: '新资源默认归属；默认取项目名小写，可修改',
    defaultNamespacePlaceholder: '例如 mygame',
    create: '创建',
    cancel: '取消',
    removeConfirmTitle: '删除项目',
    removeConfirmBody: '确定要删除项目“{name}”吗？此操作会从磁盘移除项目目录，且不可恢复。',
    removeConfirmOk: '删除',
    removeConfirmCancel: '取消',
  },
}

export const launcherEnUS = {
  launcher: {
    newProject: 'New Project',
    importProject: 'Import Project',
    export: 'Export',
    remove: 'Delete',
    open: 'Open',
    updatedAt: 'Updated {time}',
    emptyTitle: 'No projects yet',
    loading: 'Loading projects…',
    projectName: 'Project Name',
    projectNameHelper: 'Used for project directory and export file name',
    projectNamePlaceholder: 'e.g. MyGame',
    projectType: 'Project Type',
    projectTypeHelper: 'Determines the creatable resource types (3D includes model/mesh/material)',
    type2d: '2D',
    type3d: '3D',
    type25d: '2.5D',
    defaultNamespace: 'Default Namespace',
    defaultNamespaceHelper: 'Default for new resources; defaults to the project name in lowercase, editable',
    defaultNamespacePlaceholder: 'e.g. mygame',
    create: 'Create',
    cancel: 'Cancel',
    removeConfirmTitle: 'Delete Project',
    removeConfirmBody: 'Delete project "{name}"? This removes the project directory from disk and cannot be undone.',
    removeConfirmOk: 'Delete',
    removeConfirmCancel: 'Cancel',
  },
}
