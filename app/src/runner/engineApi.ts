/**
 * engine API（Worker 侧，注入给业务脚本）。
 *
 * 命令式 API，业务脚本只看到 engine 对象，不感知通讯。
 * - engine.setScene(id)：读 scene JSON + 批量加载资产 + 返回只读 Scene
 * - engine.render.*：只写命令缓冲区（RO 影子/setViewProjection/动态 buffer），commit 才提交
 * - engine.assets.load(ids)：req/res 加载额外静态资产
 *
 * 详见 docs/design/engine-redesign.md §6。
 */
import { request, sendFrame } from './engineChannel'
import type { Command } from './protocol'

/** 只读 Scene 数据（setScene 返回） */
export interface Scene {
  name: string
  graph: string
  camera: {
    type: string
    position: [number, number, number]
    target: [number, number, number]
    up: [number, number, number]
    fov: number
    near: number
    far: number
  }
  renderObjects: SceneRenderObject[]
  assets?: { models: string[]; materials: string[]; images: string[] }
}

export interface SceneRenderObject {
  name?: string
  model: string
  material: string
  pipelineBindings: Record<string, Record<string, string>>
}

/** 命令缓冲区（render.* push，commit 发送） */
const commandBuffer: Command[] = []

/** lock 状态追踪（commit 时校验配对，未 unlock 的 RO 命令全部剔除 + warn） */
const lockedRos = new Set<string>()

/** RO 影子对象（只写句柄） */
class ROShadow {
  constructor(private readonly name: string) {}

  setField(field: string, value: Float32Array): void {
    commandBuffer.push({ op: 'setField', name: this.name, field, value })
  }

  lock(): void {
    lockedRos.add(this.name)
    commandBuffer.push({ op: 'lockRO', name: this.name })
  }

  unlock(): void {
    lockedRos.delete(this.name)
    commandBuffer.push({ op: 'unlockRO', name: this.name })
  }

  withLock(fn: () => void): void {
    this.lock()
    try {
      fn()
    } finally {
      this.unlock()
    }
  }

  remove(): void {
    commandBuffer.push({ op: 'removeRO', name: this.name })
  }
}

/** 已创建的 RO 影子（按 name 索引，getRenderObject 取） */
const roShadows = new Map<string, ROShadow>()

/** RenderAPI（所有方法只写缓冲区，commit 才提交） */
const render = {
  getRenderObject(name: string): ROShadow {
    const ro = roShadows.get(name)
    if (!ro) throw new Error(`RenderObject 不存在: ${name}`)
    return ro
  },

  addRenderObject(opts: {
    name: string
    model: string
    material: string
    pipelineBindings: Record<string, Record<string, string>>
    initialFields?: Record<string, Float32Array>
  }): ROShadow {
    if (roShadows.has(opts.name)) throw new Error(`RenderObject name 冲突: ${opts.name}`)
    const ro = new ROShadow(opts.name)
    roShadows.set(opts.name, ro)
    commandBuffer.push({
      op: 'addRO',
      name: opts.name,
      modelId: opts.model,
      materialId: opts.material,
      pipelineBindings: opts.pipelineBindings,
      initialFields: opts.initialFields,
    })
    return ro
  },

  removeRenderObject(name: string): void {
    roShadows.delete(name)
    commandBuffer.push({ op: 'removeRO', name })
  },

  setViewProjection(view: Float32Array, projection: Float32Array): void {
    commandBuffer.push({ op: 'setViewProjection', view, projection })
  },

  createDynamicBuffer(id: string, opts: { size: number; usage: number }): void {
    commandBuffer.push({ op: 'createDynamicBuffer', id, size: opts.size, usage: opts.usage })
  },

  writeDynamicBuffer(id: string, data: ArrayBuffer): void {
    commandBuffer.push({ op: 'writeDynamicBuffer', id, data })
  },

  destroyDynamicBuffer(id: string): void {
    commandBuffer.push({ op: 'destroyDynamicBuffer', id })
  },

  /** 提交命令缓冲区（唯一提交点）。校验 lock 配对，未 unlock 的 RO 命令剔除 + warn */
  async commit(): Promise<void> {
    // 校验 lock 配对：未 unlock 的 RO，其所有命令全部剔除
    if (lockedRos.size > 0) {
      const warned = new Set<string>()
      const filtered = commandBuffer.filter((cmd) => {
        const name = (cmd as { name?: string }).name
        if (name && lockedRos.has(name)) {
          if (!warned.has(name)) {
            console.warn(`[engine] RO "${name}" lock 未配对 unlock，本帧命令已剔除`)
            warned.add(name)
          }
          return false
        }
        return true
      })
      commandBuffer.length = 0
      sendFrame(filtered)
      return
    }
    const commands = commandBuffer.splice(0)
    sendFrame(commands)
  },
}

/** 当前项目 id（setScene 时设置，assets.load 用） */
let currentProjectId = ''

/** setScene：读 scene JSON + 批量加载资产 + 返回只读 Scene */
async function setScene(id: string): Promise<Scene> {
  const bytes = await request('readFile', { projectId: currentProjectId, assetId: id })
  const text = new TextDecoder().decode(bytes)
  const scene = JSON.parse(text) as Scene

  // 组装批量加载资产列表：graph + 所有 RO 的 model/material + pipeline + scene 声明的 assets
  const assetIds = new Set<string>()
  assetIds.add(scene.graph)
  const pipelineIds: string[] = []
  for (const ro of scene.renderObjects) {
    assetIds.add(ro.model)
    assetIds.add(ro.material)
    for (const pid of Object.keys(ro.pipelineBindings)) {
      assetIds.add(pid)
      pipelineIds.push(pid)
    }
  }
  if (scene.assets) {
    for (const m of scene.assets.models) assetIds.add(m)
    for (const m of scene.assets.materials) assetIds.add(m)
    for (const m of scene.assets.images) assetIds.add(m)
  }

  // pipeline 依赖 shader：先读 pipeline JSON 解析出 shader id 加入加载列表
  // （shader 是 pipeline 构建的前置依赖，必须在同批 loadAssets 中一起加载）
  if (pipelineIds.length > 0) {
    const pipelineBytes = await Promise.all(
      pipelineIds.map((pid) => request('readFile', { projectId: currentProjectId, assetId: pid })),
    )
    for (const b of pipelineBytes) {
      try {
        const desc = JSON.parse(new TextDecoder().decode(b)) as { shader?: string }
        if (desc.shader) assetIds.add(desc.shader)
      } catch {
        // 解析失败留给主线程 buildPipeline 报错
      }
    }
  }

  // 批量加载（主线程拉字节 + 建 GPU 对象）
  await request('loadAssets', { projectId: currentProjectId, assetIds: [...assetIds] })

  // 为 scene 里有 name 的静态 RO 建影子对象 + push addRO 命令
  // 无 name 的静态 RO 不可被脚本访问，但仍需主线程渲染——也 push addRO（name 用生成的不重复占位）
  for (const ro of scene.renderObjects) {
    const name = ro.name ?? `__scene_ro_${roShadows.size}`
    if (roShadows.has(name)) continue
    const shadow = new ROShadow(name)
    roShadows.set(name, shadow)
    commandBuffer.push({
      op: 'addRO',
      name,
      modelId: ro.model,
      materialId: ro.material,
      pipelineBindings: ro.pipelineBindings,
    })
  }

  return scene
}

/** AssetAPI */
const assets = {
  async load(ids: string[]): Promise<void> {
    await request('loadAssets', { projectId: currentProjectId, assetIds: ids })
  },
}

/** engine 对象（注入给业务脚本） */
export interface Engine {
  setScene(id: string): Promise<Scene>
  render: typeof render
  assets: typeof assets
}

/** 创建 engine 实例（注入 projectId） */
export function createEngine(projectId: string): Engine {
  currentProjectId = projectId
  return { setScene, render, assets }
}

/** 重置 engine 状态（reload 时调用，清命令缓冲区 + RO 影子 + lock） */
export function resetEngine(): void {
  commandBuffer.length = 0
  roShadows.clear()
  lockedRos.clear()
}
