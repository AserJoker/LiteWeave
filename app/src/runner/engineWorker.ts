/**
 * engine Worker 入口（业务大脑）。
 *
 * 职责：
 * - 启动时发 ready，等主线程 cleared（握手协议）
 * - 注入 engine 全局对象到 globalThis（业务脚本通过 globalThis.engine 访问）
 * - 加载并执行业务脚本（dist/main.js，经 readScript 拿文本 + blob import）
 *
 * 详见 docs/design/engine-redesign.md §1、§5、§6。
 */
import { waitReady, setNotifyHandler, request } from './engineChannel'
import { createEngine, resetEngine } from './engineApi'

// bootstrap 经 postMessage 从主线程传入
let bootstrapResolve: ((v: { projectId: string; entryScript?: string }) => void) | null = null
const bootstrapPromise = new Promise<{ projectId: string; entryScript?: string }>((resolve) => {
  bootstrapResolve = resolve
})

// 拦截第一条 __bootstrap 消息，其余交给 engineChannel
const _origOnMessage = self.onmessage
self.onmessage = (ev: MessageEvent) => {
  const data = ev.data
  if (data && typeof data === 'object' && '__bootstrap' in data) {
    if (bootstrapResolve) {
      bootstrapResolve(data.__bootstrap)
      bootstrapResolve = null
    }
    return
  }
  if (_origOnMessage) _origOnMessage.call(self, ev)
}

;(async () => {
  setNotifyHandler((msg) => {
    if (msg.type === 'warn') console.warn('[engine] 主线程警告:', msg.payload)
    else if (msg.type === 'error') console.error('[engine] 主线程错误:', msg.payload)
  })

  const bootstrap = await bootstrapPromise
  await waitReady()
  console.log('[engine-worker] 握手完成，开始执行')

  // 注入 engine 全局对象（业务脚本通过 globalThis.engine 访问命令式 API）
  const engine = createEngine(bootstrap.projectId)
  ;(globalThis as { engine?: unknown }).engine = engine

  // 加载并执行业务脚本（dist/main.js）
  if (!bootstrap.entryScript) {
    console.error('[engine-worker] 无 entryScript，跳过业务脚本加载')
    return
  }
  try {
    const scriptText = await request('readScript', { projectId: bootstrap.projectId, path: bootstrap.entryScript })
    console.log('[engine-worker] 业务脚本已读取:', bootstrap.entryScript, `(${scriptText.length} 字符)`)
    // 用 blob URL 动态 import（esbuild 打包为 ESM 单文件，顶部 banner 引用 globalThis.engine）
    const blob = new Blob([scriptText], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await import(/* @vite-ignore */ url)
      console.log('[engine-worker] 业务脚本执行完成')
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch (err) {
    console.error('[engine-worker] 业务脚本加载/执行失败:', err instanceof Error ? err.stack : err)
  }
})().catch((err) => {
  console.error('[engine-worker] 执行失败:', err instanceof Error ? err.stack : err)
})

/** 重置 engine 状态（reload 时由外部调用，清命令缓冲区 + RO 影子 + lock + engine 全局） */
export function resetWorkerState(): void {
  resetEngine()
  ;(globalThis as { engine?: unknown }).engine = undefined
}
