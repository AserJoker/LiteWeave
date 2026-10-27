/**
 * 历史面板/历史功能文案（system.history.* 命名空间）。
 * 供历史面板（HistoryPanel）、Toolbar 撤销/重做提示消费。
 */

export const historyZhCN = {
  history: {
    title: '历史',
    empty: '暂无历史',
    emptyHint: '编辑资源后会在这里记录历史项',
    emptyNoEditor: '未选择编辑器',
    emptyNoEditorHint: '打开一个编辑器后显示其历史记录',
    clear: '清空历史',
    undo: '撤销',
    redo: '重做',
    undoHint: '撤销上一步修改',
    redoHint: '重做已撤销的修改',
    restoreHint: '一键回到该历史点（不清理后续；新编辑才截断）',
  },
}

export const historyEnUS = {
  history: {
    title: 'History',
    empty: 'No history',
    emptyHint: 'Edit a resource to record history items here',
    emptyNoEditor: 'No editor open',
    emptyNoEditorHint: 'Open an editor to see its history',
    clear: 'Clear History',
    undo: 'Undo',
    redo: 'Redo',
    undoHint: 'Undo last change',
    redoHint: 'Redo last undone change',
    restoreHint: 'Restore to this point (keeps later items; new edits truncate)',
  },
}
