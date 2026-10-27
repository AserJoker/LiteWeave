/**
 * schema 引擎自身文案（system.schema.*）。
 *
 * 并入 system 保留命名空间（由 systemStrings.ts 聚合，框架预置）。
 * 引擎文案：system.schema.empty（数组空）/ addRow（添加行）/ removeRow（删除行）/ emptyOption（清空）。
 */

export const schemaZhCN = {
  schema: {
    empty: '暂无数据',
    addRow: '添加行',
    removeRow: '删除行',
    emptyOption: '（空）',
    noResults: '无匹配项',
  },
}

export const schemaEnUS = {
  schema: {
    empty: 'No items',
    addRow: 'Add row',
    removeRow: 'Remove row',
    emptyOption: '(empty)',
    noResults: 'No results',
  },
}
