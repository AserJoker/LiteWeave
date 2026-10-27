/**
 * i18nRegistry —— 国际化注册器（基础架构）。
 *
 * 设计（与事件/命令注册器同风格的"模块注册"模式）：
 * - 模块在 init 时调用 `i18n.register(localeId, namespace, kv递归对象)` 注册自己的翻译资源
 * - 资源结构：{ namespace: { a: { b: { c: '字符串' } } } }，key 为 `namespace.a.b.c`
 * - 使用：`t('namespace.a.b.c')` 取当前语言的渲染字符串；key 未命中时逐语言回退，最终回退到 key 本身
 * - 语言切换：`setLocale(localeId)` → 广播 `system.i18n:localeChanged`（携带新语言 id），组件订阅后重渲染
 * - 预置语言列表：`getLocales()` 返回 [{ id, displayName }]，displayName 即该语言的自称
 * - 保留命名空间 `system`：框架/系统级字符串（框架内置，模块不能注册该命名空间）
 *
 * 事件契约：
 * - `system.i18n:localeChanged`：语言切换后广播，载荷 { locale: string }
 */
import type { IEventBus } from '../types.js'
import type { Unsubscribe } from '../types.js'
import { systemZhCN, systemEnUS } from './systemStrings.js'
import { SYSTEM_NAMESPACE } from '../namespace.js'

/* ---------------- 类型 ---------------- */

/** 翻译字典：{ 命名空间: 递归 kv 对象 } */
export type I18nDictionary = Record<string, I18nNode>

/** 递归 kv 对象：叶子为字符串，中间为嵌套对象 */
export type I18nNode = string | Record<string, unknown>

/** 语言描述：id + displayName（displayName 用该语言自称，如 "简体中文" / "English"） */
export interface I18nLocale {
  id: string
  displayName: string
}

/** 语言切换事件载荷 */
export interface LocaleChangedPayload {
  locale: string
}

/* ---------------- 常量 ---------------- */

/** 保留命名空间：系统级字符串（定义见 namespace.ts，顶部已引用） */

/** 语言切换事件名（system 命名空间前缀，全局隔离） */
export const I18N_LOCALE_CHANGED = `${SYSTEM_NAMESPACE}.i18n:localeChanged`

/** 默认语言 id（首个语言，未指定时使用） */
export const DEFAULT_LOCALE = 'zh-CN'

/** 预置语言列表（框架内置；模块可再 register 扩充） */
export const PRESET_LOCALES: I18nLocale[] = [
  { id: 'zh-CN', displayName: '简体中文' },
  { id: 'en-US', displayName: 'English' },
]

/* ---------------- 工具 ---------------- */

/** 解析 "namespace.a.b.c" → ['namespace','a','b','c']，过滤空段 */
function parseKey(key: string): string[] {
  return key
    .split('.')
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0)
}

/** 按路径在递归对象里取值；未命中返回 undefined */
function getAtPath(node: I18nNode | undefined, segments: string[]): I18nNode | undefined {
  let cur: I18nNode | undefined = node
  for (const seg of segments) {
    if (cur === undefined || typeof cur !== 'object' || Array.isArray(cur)) {
      return undefined
    }
    cur = (cur as Record<string, unknown>)[seg] as I18nNode | undefined
  }
  return cur
}

/** 把 kv 递归对象递归合并进目标字典（深合并，叶子覆盖） */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key]
    if (
      existing !== undefined &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      // 两边都是对象 → 递归合并
      deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      target[key] = value
    }
  }
}

/* ---------------- 注册器 ---------------- */

/**
 * 国际化注册器接口（挂到 ModuleContext.i18n，供模块注册资源 / 组件取用）。
 */
export interface I18nRegistry {
  /**
   * 注册翻译资源：register(localeId, namespace, kv递归对象)。
   * namespace 不能是保留的 `system`（系统命名空间由框架内置占用）。
   */
  register(localeId: string, namespace: string, kv: Record<string, unknown>): void

  /** 取当前语言的字符串：key 形如 `namespace.a.b.c`；未命中逐语言回退，最终回退 key 本身 */
  t(key: string): string

  /** 取指定语言的字符串（不切换）；用于语言列表显示名等场景 */
  tFor(localeId: string, key: string): string

  /** 当前语言 id */
  getLocale(): string

  /** 切换语言；广播 system.i18n:localeChanged；语言不存在时警告并忽略 */
  setLocale(localeId: string): void

  /** 预置语言列表（含 displayName） */
  getLocales(): I18nLocale[]

  /** 订阅语言切换；返回取消订阅函数 */
  onLocaleChanged(listener: (payload: LocaleChangedPayload) => void): Unsubscribe
}

/** 创建国际化注册器（core 内置；由 createCore 实例化并挂到 ctx） */
export function createI18nRegistry(events: IEventBus): I18nRegistry {
  // 语言 id → 该语言的完整字典 { namespace: {...} }
  const dictionaries = new Map<string, Record<string, unknown>>()

  // 预置语言列表（id → displayName 资源键，displayName 也走 i18n 自身解析）
  const locales: I18nLocale[] = [...PRESET_LOCALES]

  // 当前语言
  let currentLocale = DEFAULT_LOCALE

  // 事件契约：语言切换广播
  events.define({
    name: I18N_LOCALE_CHANGED,
    description: '语言切换后广播，载荷 { locale: string }',
  })

  /** 取某语言的完整字典（不存在则回退默认语言，再回退空） */
  function dictionaryFor(localeId: string): Record<string, unknown> | undefined {
    return dictionaries.get(localeId) ?? dictionaries.get(DEFAULT_LOCALE)
  }

  /** 按 key 在某语言的字典里取字符串；未命中回退默认语言，再回退 key 本身 */
  function resolve(localeId: string, key: string): string {
    const segments = parseKey(key)
    const dict = dictionaryFor(localeId)
    const value = dict ? getAtPath(dict as I18nNode, segments) : undefined
    if (typeof value === 'string') {
      return value
    }
    // 回退默认语言
    if (localeId !== DEFAULT_LOCALE) {
      const fallback = resolve(DEFAULT_LOCALE, key)
      if (fallback !== key) {
        return fallback
      }
    }
    return key
  }

  /** 内部注册：把 kv 深合并进 (localeId, namespace)。校验 kv 是递归对象。 */
  function registerInternal(localeId: string, namespace: string, kv: Record<string, unknown>): void {
    if (kv === null || typeof kv !== 'object' || Array.isArray(kv)) {
      throw new Error(`[i18n] 注册内容必须是递归对象: ${localeId}/${namespace}`)
    }
    let dict = dictionaries.get(localeId)
    if (!dict) {
      dict = {}
      dictionaries.set(localeId, dict)
    }
    // 命名空间下深合并：同一模块可多次注册/扩充
    const ns = (dict[namespace] ?? {}) as Record<string, unknown>
    deepMerge(ns, kv)
    dict[namespace] = ns
  }

  // 框架预置 system 保留命名空间
  registerInternal('zh-CN', SYSTEM_NAMESPACE, systemZhCN)
  registerInternal('en-US', SYSTEM_NAMESPACE, systemEnUS)

  return {
    register(localeId: string, namespace: string, kv: Record<string, unknown>): void {
      if (namespace === SYSTEM_NAMESPACE) {
        throw new Error(`[i18n] namespace "system" 是保留命名空间，不能注册`)
      }
      registerInternal(localeId, namespace, kv)
    },

    t(key: string): string {
      return resolve(currentLocale, key)
    },

    tFor(localeId: string, key: string): string {
      return resolve(localeId, key)
    },

    getLocale(): string {
      return currentLocale
    },

    setLocale(localeId: string): void {
      if (localeId === currentLocale) return
      if (!locales.some((l) => l.id === localeId)) {
        console.warn(`[i18n] 未知语言 "${localeId}"，忽略切换（可用语言: ${locales.map((l) => l.id).join(', ')}）`)
        return
      }
      currentLocale = localeId
      void events.emit(I18N_LOCALE_CHANGED, { locale: localeId } as LocaleChangedPayload)
    },

    getLocales(): I18nLocale[] {
      return locales.map((l) => ({ id: l.id, displayName: l.displayName }))
    },

    onLocaleChanged(listener: (payload: LocaleChangedPayload) => void): Unsubscribe {
      return events.subscribe(I18N_LOCALE_CHANGED, (payload) => {
        listener(payload as LocaleChangedPayload)
      })
    },
  }
}
