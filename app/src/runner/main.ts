/**
 * LiteWeave Runner —— 渲染进程主线程。
 *
 * 阶段：Worker 业务大脑 + 主线程渲染状态机。
 * - 创建 WebGPU device/canvas + Renderer（渲染状态机）
 * - 创建 Worker（engineWorker.ts），注入 bootstrap（projectId/entryScene）
 * - 收 Worker ready → renderer.clear() → 回 cleared（握手协议）
 * - 收 Worker request（readFile/loadAssets）→ IPC 转发主进程 → 回 response
 * - 收 Worker frame → renderer.consumeCommands()
 *
 * 详见 docs/design/engine-redesign.md §1、§7。
 */
import './runner.css'
import { Renderer } from './renderer'
import type {
  RequestMessage,
  ResponseMessage,
  NotifyMessage,
  FrameMessage,
  ReadyMessage,
} from './protocol'

/** Runner preload 暴露的桥（与 desktop/src/runnerPreload.cjs 契约一致） */
interface RunnerBridge {
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>
  onEvent(cb: (event: { type: string; payload?: unknown }) => void): () => void
  getBootstrap(): {
    projectRoot: string
    projectId: string
    projectName: string
    entryScene?: string
    entryScript?: string
  } | null
}

function getBridge(): RunnerBridge | undefined {
  const w = window as unknown as { liteweaveRunner?: RunnerBridge }
  return w.liteweaveRunner
}

const root = document.getElementById('runner-root')!

const bridge = getBridge()
if (!bridge) {
  root.innerHTML = `<div class="lwrunner-empty"><h1>LiteWeave Runner</h1><p class="lwrunner-error">window.liteweaveRunner 不可用（preload 未注入）</p></div>`
} else {
  const bootstrap = bridge.getBootstrap()
  if (!bootstrap) {
    root.innerHTML = `<div class="lwrunner-empty"><h1>LiteWeave Runner</h1><p class="lwrunner-error">无 bootstrap 信息</p></div>`
  } else {
    void startRunner(bridge, bootstrap, root).catch((err) => {
      console.error('[runner] 启动失败:', err)
    })

    // 通知主进程：Runner 页面已就绪（窗口级）
    void bridge.invoke('runner:ready', { at: new Date().toISOString() }).catch((err) => {
      console.error('[runner] runner:ready 失败:', err)
    })
  }
}

/** 启动 Runner：WebGPU + Worker + 握手 + 转发 */
async function startRunner(
  bridge: RunnerBridge,
  bootstrap: NonNullable<ReturnType<RunnerBridge['getBootstrap']>>,
  root: HTMLElement,
): Promise<void> {
  // 1. 建 canvas（持久 DOM，GPU context 与 DOM 引用绑定，不可 innerHTML 重建）
  root.innerHTML = ''
  const canvas = document.createElement('canvas')
  canvas.className = 'lwrunner-canvas'
  root.appendChild(canvas)

  // 2. 初始化 WebGPU
  if (!navigator.gpu) throw new Error('WebGPU 不可用')
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('无可用 GPU adapter')
  const device = await adapter.requestDevice()
  const context = canvas.getContext('webgpu')!
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: 'premultiplied' })
  console.log('[runner] WebGPU 就绪', `${canvas.width}×${canvas.height}`)

  // 3. 建 Renderer（主线程渲染状态机）并启动 rAF 循环
  const renderer = new Renderer(device, context, format, canvas)
  renderer.start()

  // 4. 建 Worker，注入 bootstrap（首条 __bootstrap 消息）
  const worker = new Worker(new URL('./engineWorker.ts', import.meta.url), { type: 'module' })
  worker.postMessage({ __bootstrap: { projectId: bootstrap.projectId, entryScene: bootstrap.entryScene } })

  // 5. Worker → 主线程消息路由
  worker.onmessage = (ev: MessageEvent) => {
    const msg = ev.data
    if (!msg || typeof msg !== 'object') return
    handleWorkerMessage(msg, worker, renderer, bridge)
  }
  worker.onerror = (e) => {
    console.error('[runner] Worker 错误:', e.message, e.filename, e.lineno)
  }
}

/** 处理 Worker → 主线程消息（ready/request/frame） */
function handleWorkerMessage(
  msg: ReadyMessage | RequestMessage | FrameMessage,
  worker: Worker,
  renderer: Renderer,
  bridge: RunnerBridge,
): void {
  if (msg.kind === 'ready') {
    // 握手：Worker ready → 主线程清空状态 → 回 cleared
    console.log('[runner] 收到 Worker ready，清空状态')
    renderer.clear()
    const cleared: NotifyMessage = { kind: 'notify', type: 'cleared' }
    worker.postMessage(cleared)
    return
  }

  if (msg.kind === 'request') {
    void handleRequest(msg, worker, renderer, bridge).catch((err) => {
      console.error('[runner] 处理 Worker request 失败:', msg.type, err)
    })
    return
  }

  if (msg.kind === 'frame') {
    // 命令缓冲区批量提交 → 喂给渲染状态机
    renderer.consumeCommands(msg.commands)
    return
  }
}

/** 处理 Worker req/res（readFile/loadAssets → IPC 转发主进程） */
async function handleRequest(
  msg: RequestMessage,
  worker: Worker,
  renderer: Renderer,
  bridge: RunnerBridge,
): Promise<void> {
  let response: ResponseMessage
  if (msg.type === 'readFile') {
    const payload = msg.payload as { projectId: string; assetId: string }
    try {
      const r = await bridge.invoke<{ ok?: boolean; data?: Uint8Array; error?: string }>(
        'runner:read-asset',
        { projectId: payload.projectId, assetId: payload.assetId },
      )
      if (r.ok && r.data) {
        response = { kind: 'response', id: msg.id, ok: true, payload: r.data }
        worker.postMessage(response, [r.data.buffer])
      } else {
        response = { kind: 'response', id: msg.id, ok: false, error: r.error ?? 'unknown error' }
        worker.postMessage(response)
      }
    } catch (err) {
      response = { kind: 'response', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }
      worker.postMessage(response)
    }
    return
  }

  if (msg.type === 'loadAssets') {
    const payload = msg.payload as { projectId: string; assetIds: string[] }
    try {
      const r = await bridge.invoke<{ ok?: boolean; results?: Record<string, Uint8Array | { error: string }>; error?: string }>(
        'runner:load-assets',
        { projectId: payload.projectId, assetIds: payload.assetIds },
      )
      if (r.ok && r.results) {
        // 主线程同步建 GPU 对象（renderer.loadAssets），再回 Worker response
        await renderer.loadAssets(r.results)
        const resultsCopy: Record<string, Uint8Array | { error: string }> = {}
        const transfers: Transferable[] = []
        for (const [id, data] of Object.entries(r.results)) {
          if (data instanceof Uint8Array) {
            resultsCopy[id] = data
            transfers.push(data.buffer)
          } else {
            resultsCopy[id] = data
          }
        }
        response = { kind: 'response', id: msg.id, ok: true, payload: resultsCopy }
        worker.postMessage(response, transfers)
      } else {
        response = { kind: 'response', id: msg.id, ok: false, error: r.error ?? 'load-assets failed' }
        worker.postMessage(response)
      }
    } catch (err) {
      response = { kind: 'response', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }
      worker.postMessage(response)
    }
    return
  }
}
