/**
 * FormStore —— SchemaForm 与数据源之间的“端口”（port）。
 *
 * 设计（见 docs/design/schema-driven-ui.md）：
 * - SchemaForm 只依赖本接口，不关心数据实际存哪、怎么被消费（store / 命令 / 后端 SSE / 本地内存）。
 * - 宿主提供适配器（adapter）：
 *   · 设置表单：包装 storeModule 的 api + 命令（改→发命令→后端→SSE 回推→subscribe 触发重新取值）
 *   · 创建项目表单：本地 state + 确定时提交（值不落 store，只收集）
 *   · 纯演示：createMemoryStore（内置内存适配器）
 * - 值协议：扁平 key → FieldValue | FieldValue[]（与 SchemaForm 值模型一致）。
 * - 订阅约定：subscribe 在值变化（本地 set 或外部推回）时触发；宿主 adapter 保证不自我成环
 *   （本地 set 若也触发自身 subscribe，值相同 React 不重渲染，天然断环）。
 */
import { useEffect, useState } from 'react'
import type { FieldValue, FormValues } from './schemaForm.js'

/** FormStore 端口：SchemaForm 读取 / 写入 / 订阅外部变更的统一接口 */
export interface FormStore {
  /** 读当前值（未设返回 undefined；SchemaForm 用 schema 默认值兜底） */
  get(key: string): FieldValue | FieldValue[] | undefined
  /**
   * 写值（宿主决定怎么消费：本地 state / 发命令 / 防抖队列）。
   * changedKey：本次变更的字段 key（数组增删行为数组 key）；宿主可借此精准定位，避免全字段 diff。
   */
  set(key: string, value: FieldValue | FieldValue[], changedKey?: string): void
  /** 订阅值变化（本地 set / 外部推回均触发）；返回取消订阅函数 */
  subscribe(listener: () => void): () => void
}

/* ---------------- 内置内存适配器 ---------------- */

/**
 * 用内存对象承载值的内存 store（非受控模式的默认实现；跨实例不持久化）。
 * 值变化时同步通知所有订阅者；快照每次 set 重建（不可变更新）。
 */
export function createMemoryStore(initialValues?: FormValues): FormStore {
  let snapshot: FormValues = { ...(initialValues ?? {}) }
  const listeners = new Set<() => void>()

  return {
    get(key: string) {
      return snapshot[key]
    },

    set(key: string, value: FieldValue | FieldValue[]) {
      snapshot = { ...snapshot, [key]: value }
      for (const l of Array.from(listeners)) l()
    },

    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * 订阅 store 变化并触发重渲染（渲染期重新 store.get 取最新值）。
 * SchemaForm 内部使用；宿主用 memory store 时也可用它驱动 UI。
 */
export function useFormStoreSubscribe(store: FormStore): void {
  const [, force] = useState(0)
  useEffect(() => {
    return store.subscribe(() => force((n) => n + 1))
  }, [store])
}
