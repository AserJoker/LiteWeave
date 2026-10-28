/**
 * ScriptHost —— 主进程脚本宿主（第一阶段：搬宿主 + tick 末推值）。
 *
 * 定位（见 docs/design/script-host-main-process.md §第一阶段）：
 * - 主进程是业务权威：加载 Scene、跑脚本、tick 循环、算矩阵、推 dirty 给 Runner
 * - Runner 是纯渲染器：消费 scene-ready/tick-delta 事件，调 GPU 渲染
 * - 脚本 API 与 v0.1 一致（engine.scene.setField / engine.camera.apply / engine.time / engine.canvas / engine.log）
 * - tick 计算逻辑不变（脚本仍每 tick 算 modelMatrix），只是宿主从 Runner 搬到主进程
 *
 * 与 Runner 的通讯（经 runnerManager.sendToRunner，走 runner:event channel）：
 *   主进程 ──sendToRunner──► Runner：scene-ready / tick-delta / script-error / reload / stop
 *
 * Dirty 缓冲（三类合一，第一阶段简化为 fields + camera）：
 *   脚本调 setField → 写主进程 RO.fieldValues（权威）+ dirty.fields
 *   脚本调 camera.apply() → 算 view/projection 矩阵 → dirty.camera
 *   tick 末 flushDirty → 一次 IPC 推给 Runner
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  AssetLoader,
  Camera,
  createAssetTypeRegistry,
  registerBuiltinLoaders,
  type AssetManifest,
  type FileSystemAdapter,
  type Scene,
  type RenderObject,
  type Camera as CameraDesc,
  type PipelineGraph,
} from '@liteweave/engine'

/** 脚本生命周期钩子（与 v0.1 一致） */
interface ScriptHooks {
  onInit?: () => void
  onTick?: (dt: number) => void
  onResize?: (w: number, h: number) => void
  onDispose?: () => void
}

/** 推给 Runner 的 scene-ready payload（序列化友好：TypedArray → number[]） */
export interface SceneReadyPayload {
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

/** 推给 Runner 的 tick-delta payload */
export interface TickDeltaPayload {
  type: 'tick-delta'
  tickCount: number
  dirtyFields: Array<{ roId: number; fieldName: string; value: number[] }>
  camera: { view: number[]; projection: number[] } | null
}

/** 推给 Runner 的事件统一类型 */
export type RunnerEvent =
  | SceneReadyPayload
  | TickDeltaPayload
  | { type: 'script-error'; message: string }
  | { type: 'reload' }
  | { type: 'stop' }

/** Dirty 缓冲 */
interface DirtyBuffer {
  fields: Array<{ roId: number; fieldName: string; value: number[] }>
  camera: { view: number[]; projection: number[] } | null
}

/** Runner 状态回调接口（由 main.js 注入） */
export interface RunnerManagerLike {
  sendToRunner: (event: RunnerEvent) => void
}

/** ScriptHost 配置 */
export interface ScriptHostOptions {
  projectRoot: string
  projectId: string
  projectName: string
  entryScene: string
  entryScript?: string
  namespaces?: string[]
  defaultNamespace?: string
  tickRateMs?: number
  runnerManager: RunnerManagerLike
}

/**
 * 创建 ScriptHost 实例。
 *
 * 生命周期：
 * - start()：加载 Scene + 脚本 + 启 tick；Runner ready 后推 scene-ready
 * - handleRunnerReady(canvasSize)：Runner WebGPU 就绪时调，触发推 scene-ready
 * - reload()：重新加载脚本（不重载 Scene）+ 推 reload 给 Runner
 * - stop()：停 tick + 清钩子 + 推 stop
 */
export function createScriptHost(opts: ScriptHostOptions) {
  const {
    projectRoot,
    entryScene,
    entryScript,
    namespaces = ['demogame'],
    defaultNamespace = 'demogame',
    tickRateMs = 50,
    runnerManager,
  } = opts

  let scene: Scene | null = null
  let camera: Camera | null = null
  let scriptHooks: ScriptHooks = {}
  let scriptLoaded = false
  let scriptStopped = false
  let tickIntervalId: ReturnType<typeof setInterval> | null = null

  const roIndex = new Map<number, RenderObject>()
  const dirty: DirtyBuffer = { fields: [], camera: null }

  const engine = {
    scene: {
      findRenderObject(pipelineId: string) {
        if (!scene) return null
        const ro = scene.renderObjects.find(
          (r) => Object.prototype.hasOwnProperty.call(r.material.pipelineBindings, pipelineId),
        )
        if (!ro) return null
        return { id: ro.id, modelId: ro.model.id, materialId: ro.material.id }
      },
      listRenderObjects() {
        if (!scene) return []
        return scene.renderObjects.map((r) => ({ id: r.id, modelId: r.model.id, materialId: r.material.id }))
      },
      setField(roId: number, fieldName: string, value: Float32Array) {
        const ro = roIndex.get(roId)
        if (!ro) throw new Error(`[engine.scene.setField] 未找到 RO id=${roId}`)
        const copy = new Float32Array(value)
        ro.fieldValues.set(fieldName, copy)
        dirty.fields.push({ roId, fieldName, value: Array.from(copy) })
      },
      getField(roId: number, fieldName: string) {
        const ro = roIndex.get(roId)
        if (!ro) return undefined
        const v = ro.fieldValues.get(fieldName)
        return v ? new Float32Array(v) : undefined
      },
    },
    camera: null as unknown as Camera,
    time: { elapsed: 0, delta: 0, tickCount: 0 },
    canvas: { width: 0, height: 0, aspect: 0 },
    log: (...args: unknown[]) => console.log('[script]', ...args),
  }

  /** Node fs 适配器（主进程直读，不走 IPC） */
  const fsAdapter: FileSystemAdapter = {
    async readText(relativePath: string) {
      const abs = path.resolve(projectRoot, relativePath)
      const rel = path.relative(projectRoot, abs)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`path escapes project root: ${relativePath}`)
      }
      return fs.readFile(abs, 'utf8')
    },
    async readBinary(relativePath: string) {
      const abs = path.resolve(projectRoot, relativePath)
      const rel = path.relative(projectRoot, abs)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`path escapes project root: ${relativePath}`)
      }
      const buf = await fs.readFile(abs)
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    },
  }

  /** 加载 Scene 资产（复用 engine AssetLoader） */
  async function loadScene(): Promise<void> {
    const registry = createAssetTypeRegistry()
    registerBuiltinLoaders(registry)

    let manifest: AssetManifest | undefined
    try {
      const projText = await fsAdapter.readText('project.json')
      const proj = JSON.parse(projText) as { resources?: AssetManifest }
      manifest = proj.resources
      console.log(`[scriptHost] project.json 资源清单已加载（${manifest?.length ?? 0} 条）`)
    } catch (err) {
      console.warn('[scriptHost] 读 project.json 失败，退化为按后缀推断 type:', err)
    }

    const loader = new AssetLoader({
      projectRoot,
      namespaces,
      defaultNamespace,
      fs: fsAdapter,
      registry,
      manifest,
    })

    scene = await loader.loadAsset<Scene>(entryScene)
    console.log(`[scriptHost] Scene 已加载: ${entryScene}（${scene.renderObjects.length} 个 RO）`)

    for (const ro of scene.renderObjects) {
      roIndex.set(ro.id, ro)
    }

    camera = Camera.fromSceneCamera(scene.camera)
    // apply 闭包：算矩阵写 dirty 缓冲（tick 末推给 Runner，不直接调 renderer）
    camera.apply = () => {
      if (!camera) return
      const view = camera.computeView()
      const projection = camera.computeProjection()
      dirty.camera = {
        view: Array.from(view),
        projection: Array.from(projection),
      }
    }
    engine.camera = camera
  }

  /** 加载脚本（new Function 包裹 CommonJS 风格） */
  async function loadScript(): Promise<void> {
    if (!entryScript) {
      console.log('[scriptHost] 未配置 entryScript，跳过脚本加载')
      return
    }
    try {
      const scriptText = await fsAdapter.readText(entryScript)
      const exportsObj: ScriptHooks = {}
      const noopRequire = () => {
        throw new Error('[scriptHost] require 暂未支持（第一阶段）')
      }
      const scriptFn = new Function('engine', 'exports', 'require', scriptText)
      scriptFn(engine, exportsObj, noopRequire)
      scriptHooks = exportsObj
      scriptLoaded = true
      const hooks = ['onInit', 'onTick', 'onResize', 'onDispose']
        .filter((k) => scriptHooks[k as keyof ScriptHooks])
        .join(',')
      console.log(`[scriptHost] 脚本已加载: ${entryScript}（钩子: ${hooks || '无'}）`)

      if (scriptHooks.onInit) {
        try {
          scriptHooks.onInit()
        } catch (err) {
          console.error('[scriptHost] 脚本 onInit 抛错:', err)
          scriptStopped = true
        }
      }
    } catch (err) {
      console.error('[scriptHost] 脚本加载失败:', err)
      scriptStopped = true
    }
  }

  /** 启动 tick 循环 */
  function startTick(): void {
    if (tickIntervalId !== null) return
    tickIntervalId = setInterval(() => {
      if (scriptStopped) return
      const delta = tickRateMs / 1000
      engine.time.delta = delta
      engine.time.elapsed += delta
      engine.time.tickCount += 1

      if (scriptHooks.onTick) {
        try {
          scriptHooks.onTick(delta)
        } catch (err) {
          console.error('[scriptHost] 脚本 onTick 抛错，停脚本（渲染继续）:', err)
          scriptStopped = true
          scriptHooks = {}
          runnerManager.sendToRunner({
            type: 'script-error',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }

      flushDirty()
    }, tickRateMs)
    console.log(`[scriptHost] tick 循环已启动（间隔 ${tickRateMs}ms）`)
  }

  /** tick 末批量推 dirty 给 Runner */
  function flushDirty(): void {
    if (dirty.fields.length === 0 && !dirty.camera) return
    const payload: TickDeltaPayload = {
      type: 'tick-delta',
      tickCount: engine.time.tickCount,
      dirtyFields: dirty.fields,
      camera: dirty.camera,
    }
    runnerManager.sendToRunner(payload)
    dirty.fields = []
    dirty.camera = null
  }

  /** 序列化 Scene 为 scene-ready payload */
  function buildSceneReadyPayload(canvasSize: { width: number; height: number }): SceneReadyPayload | null {
    if (!scene || !camera) return null
    return {
      type: 'scene-ready',
      graph: scene.graph,
      renderObjects: scene.renderObjects.map((ro) => ({
        id: ro.id,
        model: {
          id: ro.model.id,
          vertices: Array.from(ro.model.vertices),
          indices: ro.model.indices ? Array.from(ro.model.indices) : [],
          vertexLayouts: ro.model.vertexLayouts,
        },
        material: ro.material,
        pipelineBindings: ro.pipelineBindings,
        initialFieldValues: Object.fromEntries(
          Array.from(ro.fieldValues.entries()).map(([k, v]) => [k, Array.from(v)]),
        ),
      })),
      camera: {
        type: camera.type,
        position: [camera.position[0], camera.position[1], camera.position[2]],
        target: [camera.target[0], camera.target[1], camera.target[2]],
        up: [camera.up[0], camera.up[1], camera.up[2]],
        fov: camera.fov,
        near: camera.near,
        far: camera.far,
        aspect: camera.aspect,
      } as CameraDesc,
      canvasSize,
    }
  }

  /** 启动 ScriptHost：加载 Scene + 脚本（Runner ready 后推 scene-ready） */
  async function start(): Promise<void> {
    await loadScene()
    await loadScript()
    // 不立即推 scene-ready —— 等 Runner ready（handleRunnerReady 触发）
    // 不立即启 tick —— 等 scene-ready 推送后启（确保 Runner 已建资源再推 dirty）
  }

  /** Runner 就绪回调：推 scene-ready + 启 tick */
  function handleRunnerReady(canvasSize: { width: number; height: number }): void {
    const payload = buildSceneReadyPayload(canvasSize)
    if (payload) {
      runnerManager.sendToRunner(payload)
      console.log('[scriptHost] scene-ready 已推送给 Runner')
    }
    if (camera && canvasSize.width > 0) {
      camera.aspect = canvasSize.width / Math.max(1, canvasSize.height)
      engine.canvas.width = canvasSize.width
      engine.canvas.height = canvasSize.height
      engine.canvas.aspect = camera.aspect
      // 推初始 camera 矩阵
      camera.apply?.()
      flushDirty()
    }
    if (!scriptStopped) {
      startTick()
    }
  }

  /** 重新加载脚本（不重载 Scene） */
  async function reload(): Promise<void> {
    // 停 tick + 清钩子
    if (tickIntervalId !== null) {
      clearInterval(tickIntervalId)
      tickIntervalId = null
    }
    if (scriptHooks.onDispose && !scriptStopped) {
      try {
        scriptHooks.onDispose()
      } catch (err) {
        console.warn('[scriptHost] 脚本 onDispose 抛错（忽略）:', err)
      }
    }
    scriptHooks = {}
    scriptLoaded = false
    scriptStopped = false
    dirty.fields = []
    dirty.camera = null
    engine.time = { elapsed: 0, delta: 0, tickCount: 0 }

    runnerManager.sendToRunner({ type: 'reload' })

    await loadScript()
    // 重新推 scene-ready（Runner reload 后重建资源）+ 启 tick
    // canvasSize 用上次记录的（Runner reload 后 canvas 尺寸不变）
    const canvasSize = { width: engine.canvas.width, height: engine.canvas.height }
    handleRunnerReady(canvasSize)
  }

  /** 停止 ScriptHost */
  function stop(): void {
    if (tickIntervalId !== null) {
      clearInterval(tickIntervalId)
      tickIntervalId = null
    }
    if (scriptHooks.onDispose && !scriptStopped) {
      try {
        scriptHooks.onDispose()
      } catch (err) {
        console.warn('[scriptHost] 脚本 onDispose 抛错（忽略）:', err)
      }
    }
    scriptHooks = {}
    scriptLoaded = false
    scriptStopped = false
    scene = null
    camera = null
    roIndex.clear()
    dirty.fields = []
    dirty.camera = null
    runnerManager.sendToRunner({ type: 'stop' })
  }

  return {
    start,
    handleRunnerReady,
    reload,
    stop,
  }
}
