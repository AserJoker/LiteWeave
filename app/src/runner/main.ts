/**
 * Runner 渲染进程入口 —— 引擎业务层的承载窗口。
 *
 * 定位（见 docs/design/monaco-tsserver.md §10 双窗口模型）：
 * - IDE 进程只编辑 + 静态预览（renderSceneOnce）
 * - Runner 独立 Electron 进程跑脚本 + 主循环（崩溃不影响 IDE）
 *
 * 当前阶段（引擎层重构后）：
 * - 引擎业务层（@liteweave/engine）提供 Renderer + 数据描述对象
 * - Runner 只负责：WebGPU 设备初始化 + canvas 配置 + 调 renderer.renderGraph(graph) + 状态上报
 * - 渲染流程描述（立方体场景）从 engine 导入（buildCubeScene）
 *
 * 通讯契约（preload 暴露 window.liteweaveRunner）：
 * - invoke(channel, payload?) → 调主进程 runner:* IPC
 * - onEvent(cb) → 订阅主进程推过来的 runner 事件（IDE→Runner 指令转发等）
 * - getBootstrap() → 取启动时主进程注入的项目/入口信息
 */
import './runner.css'
import { getGpuDevice, getAdapterInfo, configureCanvas, resizeCanvasToDisplaySize, type GpuDeviceHandle } from './webgpuHelpers.js'
import { Renderer, buildCubeScene, updateCubeMvp } from '@liteweave/engine'

/** Runner preload 暴露的桥（与 desktop/src/runnerPreload.cjs 契约一致） */
interface RunnerBridge {
  /** 命令式调用主进程 runner IPC（如 'runner:ready'） */
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>
  /** 订阅主进程推送的 runner 事件（IDE→Runner 指令转发等） */
  onEvent(cb: (event: { type: string; payload?: unknown }) => void): () => void
  /** 获取启动时主进程注入的项目/入口信息 */
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

interface RunnerState {
  status: 'initializing' | 'ready' | 'running' | 'stopped' | 'error'
  project?: { id: string; name: string; root: string }
  entry?: { scene?: string; script?: string }
  lastError?: string
  heartbeatCount: number
  lastEvent?: { type: string; at: string }
  /** GPU 设备信息（getGpuDevice 成功后填充；卡片显示用） */
  gpu?: { vendor: string; architecture: string; description: string; format: string }
  /** canvas 物理分辨率（resize 时更新；卡片显示用） */
  canvasSize?: { width: number; height: number; dpr: number }
  /** 渲染帧计数（每 60 帧更新一次显示） */
  frameCount: number
}

const root = document.getElementById('runner-root')!

/**
 * 一次性建立骨架 DOM：canvas-pane（含 canvas，固定不重渲染）+ info-pane（render 目标）。
 * 关键：canvas 元素一旦创建就不再被 innerHTML 覆盖（重渲染只更新 info-pane），
 * 否则每次 render 会销毁 canvas 重建，WebGPU context 丢失 + ResizeObserver 失效。
 */
function buildSkeleton() {
  root.innerHTML = `
    <div class="lwrunner-card lwrunner-card-split">
      <div class="lwrunner-canvas-pane">
        <canvas id="runner-canvas" class="lwrunner-canvas"></canvas>
        <div class="lwrunner-canvas-overlay">
          <span class="lwrunner-status" data-runner-field="overlay-status"></span>
        </div>
      </div>
      <aside class="lwrunner-info-pane" id="runner-info-pane"></aside>
    </div>
  `
}

buildSkeleton()

const infoPane = document.getElementById('runner-info-pane')!

function render(state: RunnerState) {
  const statusColor = {
    initializing: '#f5b041',
    ready: '#48aff0',
    running: '#3dcc91',
    stopped: '#bf5af2',
    error: '#f55656',
  }[state.status]

  const projectBlock = state.project
    ? `<div class="lwrunner-row"><span class="lwrunner-label">项目</span><span class="lwrunner-value">${escapeHtml(state.project.name)} <code>${escapeHtml(state.project.id)}</code></span></div>
       <div class="lwrunner-row"><span class="lwrunner-label">根目录</span><span class="lwrunner-value"><code>${escapeHtml(state.project.root)}</code></span></div>`
    : '<div class="lwrunner-row"><span class="lwrunner-value lwrunner-muted">无项目信息</span></div>'

  const entryBlock = state.entry?.scene || state.entry?.script
    ? `<div class="lwrunner-row"><span class="lwrunner-label">入口场景</span><span class="lwrunner-value">${escapeHtml(state.entry?.scene ?? '—')}</span></div>
       <div class="lwrunner-row"><span class="lwrunner-label">入口脚本</span><span class="lwrunner-value">${escapeHtml(state.entry?.script ?? '—')}</span></div>`
    : ''

  const errorBlock = state.lastError
    ? `<div class="lwrunner-row lwrunner-error"><span class="lwrunner-label">错误</span><span class="lwrunner-value">${escapeHtml(state.lastError)}</span></div>`
    : ''

  const gpuBlock = state.gpu
    ? `<div class="lwrunner-row"><span class="lwrunner-label">GPU</span><span class="lwrunner-value">${escapeHtml(state.gpu.description)}</span></div>
       <div class="lwrunner-row"><span class="lwrunner-label">Format</span><span class="lwrunner-value"><code>${escapeHtml(state.gpu.format)}</code></span></div>`
    : '<div class="lwrunner-row"><span class="lwrunner-value lwrunner-muted">GPU 未初始化</span></div>'

  const canvasSizeBlock = state.canvasSize
    ? `<div class="lwrunner-row"><span class="lwrunner-label">分辨率</span><span class="lwrunner-value" data-runner-field="canvas-size"><code>${state.canvasSize.width}×${state.canvasSize.height}</code> @ ${state.canvasSize.dpr}x</span></div>`
    : ''

  // 只更新 info-pane（canvas-pane 在骨架中固定，不参与重渲染）
  infoPane.innerHTML = `
    <header class="lwrunner-header">
      <h1>LiteWeave Runner</h1>
    </header>
    <section class="lwrunner-section">
      ${projectBlock}
      ${entryBlock}
    </section>
    <section class="lwrunner-section">
      ${gpuBlock}
      ${canvasSizeBlock}
      <div class="lwrunner-row"><span class="lwrunner-label">帧计数</span><span class="lwrunner-value" data-runner-field="frame-count">${state.frameCount}</span></div>
      ${errorBlock}
    </section>
    <section class="lwrunner-section">
      <div class="lwrunner-row"><span class="lwrunner-label">心跳</span><span class="lwrunner-value" data-runner-field="heartbeat">${state.heartbeatCount}</span></div>
      <div class="lwrunner-row"><span class="lwrunner-label">最近事件</span><span class="lwrunner-value" data-runner-field="last-event">${state.lastEvent ? escapeHtml(state.lastEvent.type) + ' @ ' + escapeHtml(state.lastEvent.at) : '—'}</span></div>
    </section>
    <footer class="lwrunner-footer">
      引擎业务层（@liteweave/engine）已接入：Renderer + PipelineGraph 双 pass 立方体。
    </footer>
  `

  // canvas overlay 状态徽章单独更新（不在 infoPane 内）
  const overlayStatus = root.querySelector('[data-runner-field="overlay-status"]')
  if (overlayStatus) {
    overlayStatus.setAttribute('style', `color:${statusColor}`)
    overlayStatus.textContent = `● ${state.status}`
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c] as string))
}

const state: RunnerState = { status: 'initializing', heartbeatCount: 0, frameCount: 0 }
render(state)

const bridge = getBridge()

if (!bridge) {
  state.status = 'error'
  state.lastError = 'window.liteweaveRunner 不可用（preload 未注入）'
  render(state)
} else {
  // 1) 读取启动时主进程注入的项目/入口信息
  const bootstrap = bridge.getBootstrap()
  if (bootstrap) {
    state.project = { id: bootstrap.projectId, name: bootstrap.projectName, root: bootstrap.projectRoot }
    state.entry = { scene: bootstrap.entryScene, script: bootstrap.entryScript }
  } else {
    state.lastError = '主进程未注入 bootstrap 信息'
  }

  // 2) 初始化 WebGPU 设备（异步；失败时状态置 error 并显示原因）
  let gpuHandle: GpuDeviceHandle | null = null
  try {
    gpuHandle = await getGpuDevice()
    const adapterInfo = getAdapterInfo(gpuHandle.adapter)
    state.gpu = {
      vendor: adapterInfo.vendor,
      architecture: adapterInfo.architecture,
      description: adapterInfo.description,
      format: gpuHandle.format,
    }
    console.log('[runner] WebGPU 设备就绪:', state.gpu)
  } catch (err) {
    state.status = 'error'
    state.lastError = `WebGPU 初始化失败: ${err instanceof Error ? err.message : String(err)}`
    render(state)
    void bridge.invoke('runner:ready', { at: new Date().toISOString(), gpuReady: false }).catch(() => {})
  }

  if (gpuHandle) {
    state.status = 'ready'
  }
  render(state)

  // 3) 通知主进程：Runner 已就绪
  void bridge.invoke('runner:ready', { at: new Date().toISOString(), gpuReady: !!gpuHandle }).catch((err) => {
    console.error('[runner] runner:ready 失败:', err)
  })

  // 4) 订阅主进程推送的 runner 事件
  bridge.onEvent((event) => {
    state.lastEvent = { type: event.type, at: new Date().toISOString() }
    if (event.type === 'reload') {
      state.status = 'initializing'
      state.heartbeatCount = 0
    } else if (event.type === 'stop') {
      state.status = 'stopped'
    } else if (event.type === 'run') {
      state.status = 'running'
    }
    render(state)
  })

  // 5) 心跳：每 2s 上报一次
  setInterval(() => {
    state.heartbeatCount += 1
    void bridge.invoke('runner:heartbeat', { seq: state.heartbeatCount }).catch(() => {})
    const node = root.querySelector('[data-runner-field="heartbeat"]')
    if (node) node.textContent = String(state.heartbeatCount)
  }, 2000)

  // 6) canvas 配置 + Renderer + 渲染循环
  if (gpuHandle) {
    const canvas = document.getElementById('runner-canvas') as HTMLCanvasElement | null
    if (canvas) {
      try {
        const ctx = configureCanvas(canvas, gpuHandle.device, gpuHandle.format)
        console.log('[runner] canvas WebGPU context 已配置')

        // 同步 canvas 物理尺寸到状态卡片
        const syncCanvasSize = () => {
          const dpr = window.devicePixelRatio || 1
          state.canvasSize = {
            width: canvas.width,
            height: canvas.height,
            dpr,
          }
          const node = root.querySelector('[data-runner-field="canvas-size"]')
          if (node) {
            node.innerHTML = `<code>${state.canvasSize.width}×${state.canvasSize.height}</code> @ ${dpr}x`
          } else {
            render(state)
          }
        }

        // 首次同步：gpuHandle 块在 await 后执行，此时 buildSkeleton 已同步完成且 layout 通常已稳定
        if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
          resizeCanvasToDisplaySize(canvas)
          syncCanvasSize()
        }

        // ResizeObserver：后续容器尺寸变化 → 同步物理像素 → 下一帧 getCurrentTexture 自动新尺寸
        const ro = new ResizeObserver(() => {
          resizeCanvasToDisplaySize(canvas)
          syncCanvasSize()
        })
        ro.observe(canvas)

        // 兜底：首次同步时 layout 尚未稳定（clientWidth=0），用 setTimeout 延迟重试
        setTimeout(() => {
          if (canvas.width === 300 && canvas.height === 150 && canvas.clientWidth > 0) {
            resizeCanvasToDisplaySize(canvas)
            syncCanvasSize()
          }
        }, 100)

        // 创建 Renderer + 构建立方体场景
        const renderer = new Renderer({
          device: gpuHandle.device,
          ctx,
          swapchainFormat: gpuHandle.format,
        })

        const aspect = canvas.width / Math.max(1, canvas.height)
        const { graph, cubeRenderObject } = buildCubeScene(gpuHandle.format, aspect)
        console.log('[runner] Renderer + PipelineGraph 已构建（立方体双 pass 图）')

        // 用 pushErrorScope('validation') 抓 shader/pipeline 编译期错误
        // （Renderer 在首次 renderGraph 时才编译 pipeline；此处提前调一次 compilePipeline 触发编译）
        gpuHandle.device.pushErrorScope('validation')
        try {
          for (const node of graph.nodes) {
            renderer.compilePipeline(node.pipeline)
          }
        } catch (err) {
          gpuHandle.device.popErrorScope().catch(() => {})
          throw err
        }
        const pipelineError = await gpuHandle.device.popErrorScope()
        if (pipelineError) {
          throw new Error(`pipeline validation 失败: ${pipelineError.message}`)
        }
        console.log('[runner] 所有 pipeline 编译通过')

        // 渲染循环（rAF）：每帧 resize 检查 → 更新 mvp（aspect 变化时）→ renderer.renderGraph
        let rafId: number | null = null
        let lastAspect = aspect
        const frame = () => {
          // 1) 尺寸检查（resize 后下一帧 getCurrentTexture 自动返回新尺寸纹理）
          resizeCanvasToDisplaySize(canvas)

          // 2) aspect 变化时更新 cubeRenderObject 的 mvp uniform
          const newAspect = canvas.width / Math.max(1, canvas.height)
          if (newAspect !== lastAspect) {
            updateCubeMvp(cubeRenderObject, newAspect)
            lastAspect = newAspect
            console.log(`[runner] aspect 变化: ${newAspect.toFixed(3)} → mvp 已更新`)
          }

          // 3) 通知 Renderer 当前 canvas 尺寸（用于重建 size='swapchain' 的 attachment）
          renderer.resize(canvas.width, canvas.height)

          // 4) 渲染整个 PipelineGraph（Renderer 内部：ensureAttachments + 遍历 nodes + submit）
          renderer.renderGraph(graph)

          // 帧计数 + 下一帧（每 60 帧更新一次显示，避免重渲染开销）
          state.frameCount += 1
          if (state.frameCount % 60 === 0) {
            const node = root.querySelector('[data-runner-field="frame-count"]')
            if (node) node.textContent = String(state.frameCount)
          }

          rafId = requestAnimationFrame(frame)
        }

        // 状态 ready → running，启动循环
        state.status = 'running'
        render(state)
        void bridge.invoke('runner:report-status', { status: 'running' }).catch((err) => {
          console.warn('[runner] 上报 running 状态失败:', err)
        })
        rafId = requestAnimationFrame(frame)
        console.log('[runner] 渲染循环已启动（@liteweave/engine Renderer）')

        // 窗口关闭/unload 时停止循环 + 释放 Renderer 缓存的 GPU 资源
        const stopLoop = () => {
          if (rafId !== null) {
            cancelAnimationFrame(rafId)
            rafId = null
          }
          renderer.dispose()
        }
        window.addEventListener('beforeunload', stopLoop)
      } catch (err) {
        state.status = 'error'
        state.lastError = `canvas 配置/Renderer 初始化失败: ${err instanceof Error ? err.message : String(err)}`
        render(state)
        console.error('[runner] canvas/Renderer 失败:', err)
      }
    } else {
      state.lastError = '未找到 #runner-canvas 元素'
      render(state)
    }
  }
}
