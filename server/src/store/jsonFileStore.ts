/**
 * JsonFileStore —— 通用 JSON 文件存储服务（持久化数据域的统一底座）。
 *
 * 职责：
 * - 从指定 JSON 文件加载全量数据（启动时 init，文件不存在/损坏回退空对象）
 * - 按路径（a.b.c.d）读取 / 批量写入，自动创建中间路径
 * - 写入后持久化到 JSON 文件
 * - 通过 onChange 订阅变更通知（供 SSE 通道把变更推给前端）
 *
 * 通用流程：每个需要持久化的数据域（settings / editorState / scene…）各建一个实例，
 * 每域一个独立 JSON 文件、独立生命周期。前端变更链路统一为：
 *   前端改字段 → PUT（单条或批量） → 本服务持久化 + notify → SSE 推回前端。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export interface StoreChange {
  key: string
  value: unknown
}

export type StoreChangeListener = (change: StoreChange) => void

/** 解析 "a.b.c.d" → ['a','b','c','d']，过滤空段 */
export function parsePath(path: string): string[] {
  return path
    .split('.')
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0)
}

function setAtPath(root: Record<string, unknown>, segments: string[], value: unknown): void {
  let node: Record<string, unknown> = root
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    const next = node[seg]
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      const created: Record<string, unknown> = {}
      node[seg] = created
      node = created
    } else {
      node = next as Record<string, unknown>
    }
  }
  node[segments[segments.length - 1]] = value
}

function getAtPath(root: Record<string, unknown>, segments: string[]): unknown {
  let node: unknown = root
  for (const seg of segments) {
    if (node === undefined || node === null || typeof node !== 'object' || Array.isArray(node)) {
      return undefined
    }
    node = (node as Record<string, unknown>)[seg]
  }
  return node
}

export interface JsonFileStoreOptions {
  /** 数据域名称（日志 / 事件域标识） */
  domain: string
  /** 文件路径；缺省 resolve(process.cwd(), `${domain}.json`)，可用环境变量 <DOMAIN>_FILE 覆盖 */
  filePath?: string
}

export class JsonFileStore {
  private readonly domain: string
  private readonly filePath: string
  private data: Record<string, unknown> = {}
  private readonly listeners = new Set<StoreChangeListener>()
  /** 持久化串行队列：避免并发写盘竞态（后写覆盖先写） */
  private persistChain: Promise<void> = Promise.resolve()

  constructor(options: JsonFileStoreOptions) {
    this.domain = options.domain
    const envName = `${this.domain.toUpperCase().replace(/-/g, '_')}_FILE`
    this.filePath =
      options.filePath ??
      process.env[envName] ??
      resolve(process.cwd(), `${this.domain}.json`)
  }

  /** 启动时加载；文件不存在或损坏时回退为空对象 */
  async init(): Promise<void> {
    console.log(`[store:${this.domain}] file: ${this.filePath}`)
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      this.data = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        console.warn(`[store:${this.domain}] 读取数据文件失败，使用空数据: ${this.filePath}`, err)
      }
      this.data = {}
    }
  }

  /** 全量数据快照 */
  getAll(): Record<string, unknown> {
    return this.data
  }

  /** 按路径读取，未命中返回 undefined */
  get(path: string): unknown {
    return getAtPath(this.data, parsePath(path))
  }

  /**
   * 批量写入：updates = [{key, value}, ...]，一次持久化、逐条通知。
   * 返回实际产生变更的条目数（无变更不写盘、不通知）。
   * 同 key 多条时后者覆盖前者，但按去重后的 key 只通知一次（取最后值）。
   */
  async setMany(updates: Array<{ key: string; value: unknown }>): Promise<number> {
    // 去重：同 key 保留最后一条（避免同字段快速连续变更导致重复写盘/通知）
    const deduped = new Map<string, unknown>()
    for (const { key, value } of updates) {
      if (parsePath(key).length === 0) {
        throw new Error(`invalid store path: ${key}`)
      }
      deduped.set(key, value)
    }

    const changed: Array<{ key: string; value: unknown }> = []
    for (const [key, value] of deduped) {
      const segments = parsePath(key)
      const prev = getAtPath(this.data, segments)
      // 简单同值判断（原始值比较；对象引用不同视为变更）
      if (!Object.is(prev, value)) {
        setAtPath(this.data, segments, value)
        changed.push({ key, value })
      }
    }

    if (changed.length === 0) {
      return 0
    }

    await this.persist()
    for (const change of changed) {
      this.notify(change)
    }
    return changed.length
  }

  /** 按路径写入单条；返回是否产生了实际变更 */
  async set(path: string, value: unknown): Promise<boolean> {
    return (await this.setMany([{ key: path, value }])) > 0
  }

  /** 订阅变更通知；返回取消订阅函数 */
  onChange(listener: StoreChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 关闭：等待进行中的持久化完成（可选，用于优雅退出） */
  async dispose(): Promise<void> {
    await this.persistChain
  }

  private persist(): Promise<void> {
    // 串行化写盘：每次写入追加到队列末尾
    this.persistChain = this.persistChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf8')
    })
    return this.persistChain
  }

  private notify(change: StoreChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch (err) {
        console.error(`[store:${this.domain}] onChange 监听器异常:`, err)
      }
    }
  }
}
