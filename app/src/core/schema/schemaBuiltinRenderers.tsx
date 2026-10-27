/* oxlint-disable react/only-export-components */
/**
 * schemaBuiltinRenderers —— 框架内置自定义控件渲染器。
 *
 * 当前内置：
 * - `system.lang-list`：project.json 的 languages 字段控件（对象数组编码为 JSON 字符串存扁平值）
 *
 * 插件可仿照 langListRenderer 模式注册自己的控件类型
 * （type 统一命名空间 id `<namespace>.<name>`，内置用 system 前缀）。
 */
import { Button, InputGroup } from '@blueprintjs/core'
import type { FieldValue } from './schemaForm.js'
import type { FieldRenderer, RenderContext } from './schemaRenderers.js'

/** 语言列表控件类型 id（project.json 的 languages 字段；对象数组编码为 JSON 字符串存扁平值） */
export const LANG_LIST_TYPE = 'system.lang-list'

/** 语言条目（project.json languages 声明；.lang 资源按 id 命名 <id>.lang） */
export interface LangEntry {
  id: string
  display_name: string
}

/** 解析扁平值（JSON 字符串）→ 语言列表；非法/空返回 [] */
export function parseLangListValue(value: FieldValue | undefined): LangEntry[] {
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((l) => l && typeof l === 'object' && typeof l.id === 'string')
      : []
  } catch {
    return []
  }
}

/** 语言列表 → 扁平值（JSON 字符串）；供渲染器写回与宿主组装 patch 复用 */
export function stringifyLangList(langs: LangEntry[]): string {
  return JSON.stringify(langs.map((l) => ({ id: l.id, display_name: l.display_name ?? '' })))
}

/**
 * lang-list 渲染器：project.json 语言列表编辑（每行 id + display_name + 删除；底部添加）。
 * 值模型：扁平值 = JSON 字符串（schemaForm 值模型不支持对象数组，编码为标量存值）。
 * 删除某语言时只更新值（ctx.setValue）；是否有关联 .lang 的联动确认由宿主
 * （ProjectConfigEditor 的 FormStore.set 拦截）负责，渲染器不持有业务状态。
 */
export const langListRenderer: FieldRenderer = (field, value, ctx) => {
  return <LangListControl key={field.key} value={value} ctx={ctx} />
}

interface LangListControlProps {
  value: FieldValue | undefined
  ctx: RenderContext
}

function LangListControl({ value, ctx }: LangListControlProps) {
  const langs = parseLangListValue(value)
  const setLangs = (next: LangEntry[]): void => {
    ctx.setValue(stringifyLangList(next))
  }
  const update = (idx: number, patch: Partial<LangEntry>): void => {
    setLangs(langs.map((l, i) => (i === idx ? { ...l, ...patch } : l)))
  }
  const remove = (idx: number): void => {
    setLangs(langs.filter((_, i) => i !== idx))
  }
  const add = (): void => {
    setLangs([...langs, { id: '', display_name: '' }])
  }
  return (
    <div className="lw-lang-list-editor">
      {langs.length === 0 && <div className="lw-schema-array-empty">{ctx.t('system.schema.empty')}</div>}
      {langs.map((lang, idx) => (
        <div className="lw-lang-list-row" key={`${lang.id}-${idx}`}>
          <InputGroup
            className="lw-lang-list-id"
            placeholder="zh_CN"
            value={lang.id}
            disabled={ctx.disabled}
            spellCheck={false}
            onChange={(e) => update(idx, { id: e.target.value })}
          />
          <InputGroup
            className="lw-lang-list-name"
            placeholder="简体中文"
            value={lang.display_name}
            disabled={ctx.disabled}
            onChange={(e) => update(idx, { display_name: e.target.value })}
          />
          <Button icon="cross" minimal small title={ctx.t('system.lang.remove')} disabled={ctx.disabled} onClick={() => remove(idx)} />
        </div>
      ))}
      <Button icon="plus" small text={ctx.t('system.schema.addRow')} disabled={ctx.disabled} onClick={add} />
    </div>
  )
}

