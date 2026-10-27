/**
 * schemaCondition —— Schema 条件表达式（可见/禁用联动的轻量声明式表达）。
 *
 * 独立成文件：schemaForm.tsx 是组件文件（fast refresh），纯逻辑导出放这里避免 only-export-components 警告。
 * 用结构化条件对象，不引入表达式字符串解析（避免复杂度与注入风险）。
 *
 * 语义约定（调用点区分）：
 * - visibleWhen：条件成立才显示；undefined（无条件）恒显示
 * - disabledWhen：条件成立则禁用；undefined（无条件）不禁用——
 *   evalCondition(undefined) 返回 true，调用点必须按 `disabledWhen ? evalCondition(...) : false` 区分"无条件"与"条件不成立"
 */
import type { FieldValue, FormValues } from './schemaForm.js'

export interface SingleCondition {
  /** 依赖字段 key */
  when: string
  /** 值 === eq 时条件成立 */
  eq?: FieldValue
  /** 值 !== notEq 时条件成立 */
  notEq?: FieldValue
  /** 值命中 in 集合时条件成立 */
  in?: FieldValue[]
}

export type Condition = SingleCondition | { and: Condition[] } | { or: Condition[] } | { not: Condition }

/**
 * 求值条件（values 为当前表单值快照）。
 * 注意：undefined 恒真（visibleWhen 语义）；disabledWhen 的"无条件不禁用"由调用点自行判断。
 */
export function evalCondition(cond: Condition | undefined, values: FormValues): boolean {
  if (!cond) return true
  if ('when' in cond) {
    const v = values[cond.when]
    if (cond.eq !== undefined) return v === cond.eq
    if (cond.notEq !== undefined) return v !== cond.notEq
    if (cond.in) return cond.in.includes(v as FieldValue)
    return true
  }
  if ('and' in cond) return cond.and.every((c) => evalCondition(c, values))
  if ('or' in cond) return cond.or.some((c) => evalCondition(c, values))
  return !evalCondition(cond.not, values)
}
