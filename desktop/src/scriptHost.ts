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
import { mat4, quat, vec3 } from 'gl-matrix'
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

/* ---------------- 几何组件（主进程专用，Runner 透明） ---------------- */
/**
 * TransformComponent —— 几何组件，挂在主进程 Entity（RO）上。
 *
 * 设计（见 2026-10-28 决策）：
 * - 脚本调 setTransform 改 Component 参数（position/rotation quat/scale）
 * - tick 末主进程算 modelMatrix = T×R×S，作为字段级命令推给 Runner
 * - Runner 只看到 modelMatrix uniform 变更，不认识 Transform（渲染线程干净）
 * - rotation 用四元数：无万向锁，为后续动画组件插值铺路
 *
 * 后续动画/物理组件会修改同一个 TransformComponent 的参数，组件统一算矩阵。
 */
type Vec3 = [number, number, number]
type Quat = [number, number, number, number]

class TransformComponent {
  position: Vec3
  rotation: Quat
  scale: Vec3
  constructor(opts?: { position?: Vec3; rotation?: Quat; scale?: Vec3 }) {
    this.position = opts?.position ? [opts.position[0], opts.position[1], opts.position[2]] : [0, 0, 0]
    this.rotation = opts?.rotation ? [opts.rotation[0], opts.rotation[1], opts.rotation[2], opts.rotation[3]] : [0, 0, 0, 1]
    this.scale = opts?.scale ? [opts.scale[0], opts.scale[1], opts.scale[2]] : [1, 1, 1]
  }
  /** 覆盖式应用（未传字段保留；数组显式拷贝避免共享引用） */
  apply(input: { position?: Vec3; rotation?: Quat; scale?: Vec3 }): void {
    if (input.position) this.position = [input.position[0], input.position[1], input.position[2]]
    if (input.rotation) this.rotation = [input.rotation[0], input.rotation[1], input.rotation[2], input.rotation[3]]
    if (input.scale) this.scale = [input.scale[0], input.scale[1], input.scale[2]]
  }
  /** 算 modelMatrix = T(position) × R(rotation) × S(scale)（列主序 4×4） */
  computeModelMatrix(): Float32Array {
    const m = mat4.create()
    mat4.fromRotationTranslationScale(
      m,
      quat.fromValues(this.rotation[0], this.rotation[1], this.rotation[2], this.rotation[3]),
      vec3.fromValues(this.position[0], this.position[1], this.position[2]),
      vec3.fromValues(this.scale[0], this.scale[1], this.scale[2]),
    )
    return m as Float32Array
  }
}

/** 绕指定轴生成四元数（轴角对；脚本便捷工具） */
function quatFromAxisAngle(ax: number, ay: number, az: number, angle: number): Quat {
  const q = quat.create()
  quat.setAxisAngle(q, [ax, ay, az], angle)
  return [q[0], q[1], q[2], q[3]]
}

/** setTransform 的部分参数（所有字段可选，覆盖式语义） */
interface TransformInput {
  position?: Vec3
  rotation?: Quat
  scale?: Vec3
}

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
  /** 主循环运行标志（贪婪 while+sleep 循环的启停开关） */
  let loopRunning = false
  /** onTick 累积器：主循环每帧累加 frameDelta，≥tickRateMs 时回调 onTick 并减 tickRateMs */
  let onTickAccum = 0
  /** 主循环上一帧时间戳（算 frameDelta 用） */
  let lastFrameTime = 0

  const roIndex = new Map<number, RenderObject>()
  /** per-RO 几何组件（主进程专用；tick 末算 modelMatrix 推给 Runner） */
  const transformIndex = new Map<number, TransformComponent>()
  /** 本 tick 内 transform 有变更的 RO id 集合（tick 末遍历算矩阵写 dirty.fields） */
  const dirtyTransforms = new Set<number>()
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
      /**
       * 设置几何组件参数（覆盖式：未传字段保留）。
       * tick 末主进程算 modelMatrix = T×R×S，作为字段级命令推给 Runner。
       * Runner 不认识 Transform，只看到 modelMatrix uniform 变更。
       */
      setTransform(roId: number, input: TransformInput) {
        if (!transformIndex.has(roId)) {
          throw new Error(`[engine.scene.setTransform] 未找到 RO id=${roId}`)
        }
        const t = transformIndex.get(roId)!
        t.apply(input)
        dirtyTransforms.add(roId)
      },
      /** 读几何组件当前参数（返回拷贝，脚本改不影响内部状态） */
      getTransform(roId: number): { position: Vec3; rotation: Quat; scale: Vec3 } | undefined {
        const t = transformIndex.get(roId)
        if (!t) return undefined
        return {
          position: [t.position[0], t.position[1], t.position[2]],
          rotation: [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]],
          scale: [t.scale[0], t.scale[1], t.scale[2]],
        }
      },
      /** 绕轴生成四元数（脚本便捷工具；轴角对） */
      quatFromAxisAngle,
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
      // 每个 RO 默认内置几何组件（单位变换）；算初始 modelMatrix 写 fieldValues
      // scene-ready 推送时 initialFieldValues 含 modelMatrix，Runner 直接建资源
      const t = new TransformComponent()
      transformIndex.set(ro.id, t)
      ro.fieldValues.set('modelMatrix', t.computeModelMatrix())
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

  /**
   * 启动贪婪主循环（while + await sleep 4ms）。
   *
   * 架构（见 2026-10-28 决策）：
   * - 主循环高频跑（~250fps，sleep 4ms 让出 CPU），每帧算 modelMatrix 推 Runner
   * - onTick 不是每帧回调，而是按 tickRateMs（50ms）节流：
   *   累积 frameDelta，≥50ms 时回调 onTick(50ms) 并减 50ms（累积 delta 补偿漂移）
   * - 动画/物理组件（未来）在主循环里高频跑，与 onTick 节流解耦
   * - matrix 推送：每帧检查 dirtyTransforms，非空才算 matrix 推（只在 transform 变了才推）
   */
  async function startTick(): Promise<void> {
    if (loopRunning) return
    loopRunning = true
    onTickAccum = 0
    lastFrameTime = Date.now()
    console.log(`[scriptHost] 贪婪主循环已启动（onTick 节流 ${tickRateMs}ms，sleep 4ms）`)

    while (loopRunning) {
      const now = Date.now()
      const frameDeltaMs = now - lastFrameTime
      lastFrameTime = now

      if (!scriptStopped) {
        // onTick 节流：累积 frameDelta，≥tickRateMs 时回调脚本
        onTickAccum += frameDeltaMs
        if (onTickAccum >= tickRateMs) {
          const tickDelta = tickRateMs / 1000
          engine.time.delta = tickDelta
          engine.time.elapsed += tickDelta
          engine.time.tickCount += 1
          // 减 tickRateMs 而非清零：多跑的 delta 累到下次（补偿漂移）
          onTickAccum -= tickRateMs

          if (scriptHooks.onTick) {
            try {
              scriptHooks.onTick(tickDelta)
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
        }

        // 每帧：遍历 transform 有变更的 RO，算 modelMatrix 写 fieldValues + dirty.fields
        // Runner 只看到 modelMatrix uniform 变更（字段级命令），不认识 TransformComponent
        if (dirtyTransforms.size > 0) {
          for (const roId of dirtyTransforms) {
            const t = transformIndex.get(roId)
            const ro = roIndex.get(roId)
            if (!t || !ro) continue
            const modelMatrix = t.computeModelMatrix()
            ro.fieldValues.set('modelMatrix', modelMatrix)
            dirty.fields.push({ roId, fieldName: 'modelMatrix', value: Array.from(modelMatrix) })
          }
          dirtyTransforms.clear()
        }

        flushDirty()
      }

      // sleep 4ms 让出 CPU（~250fps；Node setTimeout 最低 1ms 精度，4ms 是平衡点）
      await new Promise<void>((resolve) => setTimeout(resolve, 4))
    }
  }

  /** 停止贪婪主循环 */
  function stopTick(): void {
    loopRunning = false
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
    // 停主循环 + 清钩子
    stopTick()
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
    dirtyTransforms.clear()
    // 重置所有几何组件为单位变换（脚本 reload 从初始状态开始；Scene 不重载所以 RO 还是那些）
    for (const [roId, t] of transformIndex) {
      t.position = [0, 0, 0]
      t.rotation = [0, 0, 0, 1]
      t.scale = [1, 1, 1]
      const ro = roIndex.get(roId)
      if (ro) ro.fieldValues.set('modelMatrix', t.computeModelMatrix())
    }
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
    stopTick()
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
    transformIndex.clear()
    dirtyTransforms.clear()
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
