/**
 * LiteWeave Runner —— 纯渲染器（第一阶段：消费主进程推送的渲染数据）。
 *
 * 定位（见 docs/design/script-host-main-process.md §第一阶段）：
 * - Runner 是纯渲染器 + 输入采集（第一阶段不做输入）
 * - 主进程（scriptHost）加载 Scene + 跑脚本 + tick + 推 dirty
 * - Runner 消费 scene-ready（建 GPU 资源）+ tick-delta（应用 dirty）+ script-error（显示错误态）
 * - 渲染循环（rAF）独立于主进程 tick；resize 本地兜底重算 projection
 *
 * 通讯（preload 暴露 window.liteweaveRunner）：
 *   Runner ──invoke──► 主进程：runner:ready（含 canvasSize）/ runner:heartbeat / runner:console
 *   主进程 ──onEvent──► Runner：scene-ready / tick-delta / script-error / reload / stop
 */
import { Renderer, type Scene, type RenderObject, type PipelineGraph, type Camera as CameraDesc } from '@liteweave/engine'
import { mat4 } from 'gl-matrix'
import './runner.css'
import {
  getGpuDevice,
  getAdapterInfo,
  configureCanvas,
  resizeCanvasToDisplaySize,
  type GpuDeviceHandle,
} from './webgpuHelpers.js'

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

/** 主进程推送的 scene-ready payload（TypedArray 已序列化为 number[]） */
interface SceneReadyPayload {
  type: 'scene-ready'
  graph: PipelineGraph
  renderObjects: Array<{
    id: number
    model: {
      id: string
      vertices: number[]
      indices: number[]
      vertexLayouts: RenderObject['model']['vertexLayouts']
    }
    material: RenderObject['material']
    pipelineBindings: RenderObject['pipelineBindings']
    initialFieldValues: Record<string, number[]>
  }>
  camera: CameraDesc
  canvasSize: { width: number; height: number }
}

/** 主进程推送的 tick-delta payload */
interface TickDeltaPayload {
  type: 'tick-delta'
  tickCount: number
  dirtyFields: Array<{ roId: number; fieldName: string; value: number[] }>
  camera: { view: number[]; projection: number[] } | null
}

interface RunnerState {
  status: 'initializing' | 'ready' | 'running' | 'stopped' | 'error'
  project?: { id: string; name: string; root: string }
  entry?: { scene?: string; script?: string }
  lastError?: string
  heartbeatCount: number
  lastEvent?: { type: string; at: string }
  gpu?: { vendor: string; architecture: string; description: string; format: string }
  canvasSize?: { width: number; height: number; dpr: number }
  frameCount: number
}

const root = document.getElementById('runner-root')!

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
      Runner 纯渲染器：主进程跑脚本 + 推 dirty，前端消费渲染。
    </footer>
  `

  const overlayStatus = root.querySelector('[data-runner-field="overlay-status"]')
  if (overlayStatus) {
    overlayStatus.setAttribute('style', `color:${statusColor}`)
    overlayStatus.textContent = state.status
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
  // 1) 读取启动时主进程注入的项目/入口信息（仅用于卡片显示）
  const bootstrap = bridge.getBootstrap()
  if (bootstrap) {
    state.project = { id: bootstrap.projectId, name: bootstrap.projectName, root: bootstrap.projectRoot }
    state.entry = { scene: bootstrap.entryScene, script: bootstrap.entryScript }
  } else {
    state.lastError = '主进程未注入 bootstrap 信息'
  }

  // 2) 初始化 WebGPU 设备
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
  }

  if (gpuHandle) {
    state.status = 'ready'
  }
  render(state)

  // 3) 通知主进程：Runner 已就绪（含 canvas 尺寸，scriptHost 据此推 scene-ready + 启 tick）
  const canvas0 = document.getElementById('runner-canvas') as HTMLCanvasElement | null
  const initialCanvasSize = canvas0
    ? { width: canvas0.width || 300, height: canvas0.height || 150 }
    : { width: 300, height: 150 }
  void bridge.invoke('runner:ready', { at: new Date().toISOString(), gpuReady: !!gpuHandle, canvasSize: initialCanvasSize }).catch((err) => {
    console.error('[runner] runner:ready 失败:', err)
  })

  // 4) 订阅主进程推送的 runner 事件（scene-ready / tick-delta / script-error / reload / stop）
  let scene: Scene | null = null
  let renderer: Renderer | null = null
  let rafId: number | null = null
  let lastAspect = 0
  const roIndex = new Map<number, RenderObject>()

  bridge.onEvent((event) => {
    state.lastEvent = { type: event.type, at: new Date().toISOString() }

    if (event.type === 'scene-ready') {
      handleSceneReady(event as SceneReadyPayload)
    } else if (event.type === 'tick-delta') {
      handleTickDelta(event as TickDeltaPayload)
    } else if (event.type === 'script-error') {
      const p = event as { message?: string }
      state.status = 'error'
      state.lastError = p?.message ?? '脚本运行时错误'
      render(state)
    } else if (event.type === 'reload') {
      state.status = 'initializing'
      state.lastError = undefined
      state.frameCount = 0
      stopLoop()
      render(state)
    } else if (event.type === 'stop') {
      state.status = 'stopped'
      stopLoop()
      render(state)
    }
  })

  /** 处理 scene-ready：重建 Scene 对象 + 编译 pipeline + 建 GPU 资源 + 启渲染循环 */
  function handleSceneReady(payload: SceneReadyPayload) {
    if (!gpuHandle) {
      console.error('[runner] scene-ready 但 WebGPU 未就绪')
      return
    }
    const canvas = document.getElementById('runner-canvas') as HTMLCanvasElement | null
    if (!canvas) {
      state.lastError = '未找到 #runner-canvas 元素'
      render(state)
      return
    }

    try {
      const ctx = configureCanvas(canvas, gpuHandle.device, gpuHandle.format)
      console.log('[runner] canvas WebGPU context 已配置')

      // 同步 canvas 物理尺寸
      const syncCanvasSize = () => {
        const dpr = window.devicePixelRatio || 1
        state.canvasSize = { width: canvas.width, height: canvas.height, dpr }
        const node = root.querySelector('[data-runner-field="canvas-size"]')
        if (node) {
          node.innerHTML = `<code>${state.canvasSize.width}×${state.canvasSize.height}</code> @ ${dpr}x`
        } else {
          render(state)
        }
      }
      if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
        resizeCanvasToDisplaySize(canvas)
        syncCanvasSize()
      }
      const ro = new ResizeObserver(() => {
        resizeCanvasToDisplaySize(canvas)
        syncCanvasSize()
      })
      ro.observe(canvas)
      setTimeout(() => {
        if (canvas.width === 300 && canvas.height === 150 && canvas.clientWidth > 0) {
          resizeCanvasToDisplaySize(canvas)
          syncCanvasSize()
        }
      }, 100)

      renderer = new Renderer({
        device: gpuHandle.device,
        ctx,
        swapchainFormat: gpuHandle.format,
      })

      // 重建 Scene 对象（从 payload 反序列化；Renderer.renderGraph 需要 Scene）
      const renderObjects: RenderObject[] = payload.renderObjects.map((roData) => ({
        id: roData.id,
        model: {
          id: roData.model.id,
          vertices: new Float32Array(roData.model.vertices),
          indices: roData.model.indices.length > 0 ? new Uint16Array(roData.model.indices) : undefined,
          vertexLayouts: roData.model.vertexLayouts,
        },
        material: roData.material,
        fieldValues: new Map(
          Object.entries(roData.initialFieldValues).map(([k, v]) => [k, new Float32Array(v)]),
        ),
        pipelineBindings: roData.pipelineBindings,
      }))
      for (const ro of renderObjects) {
        roIndex.set(ro.id, ro)
      }
      scene = {
        id: payload.graph.id ?? 'scene-from-main',
        graph: payload.graph,
        camera: payload.camera,
        renderObjects,
      }
      console.log(`[runner] Scene 已从主进程推送重建（${renderObjects.length} 个 RO）`)

      // 用初始 camera 算 view/projection 同步给 Renderer
      const cam = payload.camera
      const aspect = canvas.width / Math.max(1, canvas.height)
      const view = mat4.create()
      mat4.lookAt(view, cam.position, cam.target, cam.up)
      const projection = mat4.create()
      mat4.perspective(projection, cam.fov, aspect, cam.near, cam.far)
      renderer.setView(view as Float32Array)
      renderer.setProjection(projection as Float32Array)
      lastAspect = aspect

      // 编译 pipeline（提前触发 + validation 检查）
      gpuHandle.device.pushErrorScope('validation')
      try {
        for (const node of payload.graph.nodes) {
          renderer.compilePipeline(node.pipeline)
        }
      } catch (err) {
        gpuHandle.device.popErrorScope().catch(() => {})
        throw err
      }
      gpuHandle.device.popErrorScope().then((pipelineError) => {
        if (pipelineError) {
          console.error('[runner] pipeline validation 失败:', pipelineError.message)
          state.status = 'error'
          state.lastError = `pipeline validation 失败: ${pipelineError.message}`
          render(state)
        } else {
          console.log('[runner] 所有 pipeline 编译通过')
        }
      })

      // 启动渲染循环
      state.status = 'running'
      render(state)
      startRenderLoop(canvas, renderer, scene)
      void bridge.invoke('runner:report-status', { status: 'running' }).catch(() => {})
      console.log('[runner] 渲染循环已启动（纯渲染器模式）')
    } catch (err) {
      state.status = 'error'
      state.lastError = `scene-ready 处理失败: ${err instanceof Error ? err.message : String(err)}`
      render(state)
      console.error('[runner] scene-ready 失败:', err)
    }
  }

  /** 处理 tick-delta：应用 dirty 字段 + camera 矩阵 */
  function handleTickDelta(payload: TickDeltaPayload) {
    if (!scene) return
    for (const change of payload.dirtyFields) {
      const ro = roIndex.get(change.roId)
      if (!ro) {
        console.warn(`[runner] tick-delta: 未找到 RO id=${change.roId}`)
        continue
      }
      ro.fieldValues.set(change.fieldName, new Float32Array(change.value))
    }
    if (payload.camera && renderer) {
      renderer.setView(new Float32Array(payload.camera.view))
      renderer.setProjection(new Float32Array(payload.camera.projection))
    }
  }

  /** 渲染循环（rAF） */
  function startRenderLoop(canvas: HTMLCanvasElement, r: Renderer, sc: Scene) {
    const frame = () => {
      // 同步 canvas 物理尺寸到 Renderer（attachment 按 currentWidth/Height 创建；
      // resize 内部有尺寸比较，没变化直接返回 false，零开销）
      r.resize(canvas.width, canvas.height)
      // resize 兜底：aspect 变化时本地重算 projection（与 v0.1 一致；不推主进程）
      const newAspect = canvas.width / Math.max(1, canvas.height)
      if (newAspect !== lastAspect) {
        const projection = mat4.create()
        mat4.perspective(projection, sc.camera.fov, newAspect, sc.camera.near, sc.camera.far)
        r.setProjection(projection as Float32Array)
        lastAspect = newAspect
        console.log(`[runner] aspect 变化: ${newAspect.toFixed(3)} → projection 本地重算`)
      }
      r.renderGraph(sc.graph, sc)
      state.frameCount += 1
      if (state.frameCount % 60 === 0) {
        const node = root.querySelector('[data-runner-field="frame-count"]')
        if (node) node.textContent = String(state.frameCount)
      }
      rafId = requestAnimationFrame(frame)
    }
    rafId = requestAnimationFrame(frame)
  }

  function stopLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    if (renderer) {
      renderer.dispose()
      renderer = null
    }
    scene = null
    roIndex.clear()
  }

  // 5) 心跳：每 2s 上报一次
  setInterval(() => {
    state.heartbeatCount += 1
    void bridge.invoke('runner:heartbeat', { seq: state.heartbeatCount }).catch(() => {})
    const node = root.querySelector('[data-runner-field="heartbeat"]')
    if (node) node.textContent = String(state.heartbeatCount)
  }, 2000)

  window.addEventListener('beforeunload', stopLoop)
}
