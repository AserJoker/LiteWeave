/**
 * engine Worker 入口（业务大脑）。
 *
 * 职责：
 * - 启动时发 ready，等主线程 cleared（握手协议）
 * - 注入 engine 全局对象（命令式 API，业务脚本调用）
 * - 执行业务逻辑（当前临时硬编码，未来加载 dist/main.js）
 *
 * 详见 docs/design/engine-redesign.md §1、§5、§6。
 */
import { waitReady, setNotifyHandler } from './engineChannel'
import { createEngine, resetEngine, type Engine, type Scene } from './engineApi'

// bootstrap 经 postMessage 从主线程传入
let bootstrapResolve: ((v: { projectId: string; entryScene?: string }) => void) | null = null
const bootstrapPromise = new Promise<{ projectId: string; entryScene?: string }>((resolve) => {
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

  const engine = createEngine(bootstrap.projectId)

  // 临时硬编码脚本逻辑（代替 DemoGame dist/main.js 的 console.log 占位）
  // 未来：await import(/* @vite-ignore */ bootstrap.entryScript) 或类似机制加载业务脚本
  await runDemoLogic(engine, bootstrap.entryScene!)
})().catch((err) => {
  console.error('[engine-worker] 执行失败:', err instanceof Error ? err.stack : err)
})

/**
 * 临时硬编码脚本逻辑：setScene + 静态相机 + 渲染循环。
 * 验证 Worker → 主线程命令链路 + 渲染。未来由业务脚本（dist/main.js）替代。
 */
async function runDemoLogic(engine: Engine, entryScene: string): Promise<void> {
  // mat4 用轻量手算（避免引 gl-matrix，Worker 内保持纯 TS）
  const scene = await engine.setScene(entryScene)
  console.log('[engine-worker] setScene 完成:', scene.name, '（RO:', scene.renderObjects.length, '）')

  const cam = scene.camera
  const view = lookAt(cam.position, cam.target, cam.up)
  let aspect = 1 // 主线程会按 canvas 算实际 aspect，这里先占位
  let projection = perspective(cam.fov, aspect, cam.near, cam.far)

  // 取 cube RO 影子（setScene 已为有 name 的静态 RO 建影子），验证 setField(modelMatrix) 链路
  const cube = engine.render.getRenderObject('cube')

  // 渲染循环：每帧推 setViewProjection + 旋转 modelMatrix + commit
  let frame = 0
  function tick() {
    frame++
    const angle = frame * 0.02 // ~1.15°/帧
    const mm = rotationY(angle)
    cube.setField('modelMatrix', mm)
    engine.render.setViewProjection(view, projection)
    void engine.render.commit().catch((e) => console.error('[engine-worker] commit 失败:', e))
    setTimeout(tick, 16) // ~60fps，用 setTimeout 而非 rAF（Worker 无 rAF）
  }
  tick()
}

/* ---------------- 轻量矩阵工具（Worker 内，避免引 gl-matrix） ---------------- */

function lookAt(eye: number[], center: number[], up: number[]): Float32Array {
  const z = normalize([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]])
  const x = normalize(cross(up, z))
  const y = cross(z, x)
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ])
}

function perspective(fov: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fov / 2)
  const nf = 1 / (near - far)
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ])
}

function normalize(v: number[]): number[] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / len, v[1] / len, v[2] / len]
}

/** 绕 Y 轴旋转矩阵（列主序，WebGPU/GL 约定） */
function rotationY(rad: number): Float32Array {
  const c = Math.cos(rad), s = Math.sin(rad)
  return new Float32Array([
    c,  0, -s, 0,
    0,  1,  0, 0,
    s,  0,  c, 0,
    0,  0,  0, 1,
  ])
}

function cross(a: number[], b: number[]): number[] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
