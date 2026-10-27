/**
 * 主进程服务层 —— 承载业务服务 + 按 endpoint 路由 IPC 请求。
 *
 * 架构（用户方向）：
 * - 后端在 Electron 不需要 Express：协议统一 endpoint(URL)+JSON，传输走 IPC 消息
 * - 本模块 esbuild 打包 server/src 的纯逻辑（createServices），直接持有 JsonFileStore/AiChatService
 * - 渲染进程 window.liteweave.request('GET', '/api/settings') → IPC → 这里按 endpoint 路由到服务
 * - 服务变更（如 settings 写入）→ 通过回调推送回渲染进程（替代 SSE）
 *
 * 协议与 Web 模式完全一致（endpoint + JSON），未来 Web 移植只是传输层换 fetch/EventSource。
 */
import { createServices } from '../dist/services.mjs'

/** 订阅注册表：endpoint → Set<回调>（渲染进程订阅时注册，变更时通知） */
const eventSubscribers = new Map()

/** 推送回调（由 main.js 注入：webContents.send → 渲染进程） */
let push = () => {}

/** 服务实例（createServices 返回） */
let services = null

/**
 * 初始化服务层：加载打包的服务 + 组装订阅推送。
 * @param {object} opts
 * @param {string} opts.dataDir 数据文件根目录（userData）
 * @param {(endpoint: string, data: unknown) => void} opts.onPush 变更推送回调
 */
export async function initServices({ dataDir, onPush }) {
  push = onPush
  services = await createServices({ dataDir })
  console.log('[services] 已启动（Electron 内嵌，无 Express）')
  return services
}

/** 关闭服务（退出前等待持久化） */
export async function disposeServices() {
  if (services) {
    await services.dispose()
    services = null
  }
}

/** 校验 endpoint 前缀，避免越权访问 */
function assertApiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new Error(`invalid endpoint: ${path}`)
  }
}

/**
 * 处理 REST 语义请求（渲染进程 window.liteweave.request 调用）。
 * @param {string} method GET / PUT / POST / DELETE
 * @param {string} path  /api/xxx 或 /api/xxx/events（events 仅 GET，走订阅）
 * @param {unknown} body  PUT/POST 请求体（JSON）
 */
export async function handleRequest(method, path, body) {
  assertApiPath(path)
  if (!services) throw new Error('services not ready')

  // 健康检查
  if (path === '/api/health') {
    return { status: 'ok', timestamp: new Date().toISOString() }
  }

  // 数据域路由：/api/:domain[/events]
  const m = path.match(/^\/api\/([a-zA-Z0-9_-]+)(\/events)?$/)
  if (m) {
    const domain = m[1]
    const isEvents = m[2] === '/events'
    const store = services[domain]
    if (!store || typeof store.setMany !== 'function') {
      throw new Error(`unknown domain: ${domain}`)
    }

    if (isEvents) {
      // 订阅通道：返回当前快照 + 注册变更推送（语义对齐 Web 版 SSE /events）
      if (method !== 'GET') throw new Error('events only supports GET')
      return { snapshot: store.getAll() }
    }

    if (method === 'GET') {
      return store.getAll()
    }
    if (method === 'PUT') {
      const updates = parseUpdates(body)
      const changed = await store.setMany(updates)
      return { ok: true, changed }
    }
    throw new Error(`unsupported method: ${method}`)
  }

  // AI 对话：POST /api/ai/chat
  if (path === '/api/ai/chat') {
    if (method !== 'POST') throw new Error('chat only supports POST')
    const { message, sessionId } = body ?? {}
    if (typeof message !== 'string' || !message) {
      throw new Error('invalid message')
    }
    return services.chat.chat(message, sessionId)
  }

  throw new Error(`unknown endpoint: ${method} ${path}`)
}

/** 解析 PUT body：批量 {updates} 或单条 {key,value}，语义与 Web 版 storeRoutes 一致 */
function parseUpdates(body) {
  if (!body || typeof body !== 'object') throw new Error('invalid body')
  if (Array.isArray(body.updates)) {
    for (const u of body.updates) {
      if (!u || typeof u.key !== 'string') throw new Error('invalid updates entry')
    }
    return body.updates
  }
  if (typeof body.key === 'string') {
    return [{ key: body.key, value: body.value }]
  }
  throw new Error('invalid body: expected {updates} or {key,value}')
}

/**
 * 订阅 endpoint 变更（渲染进程 window.liteweave.subscribe 调用）。
 * 返回订阅 id；变更时通过 onPush(endpoint, data) 推回。
 */
export function handleSubscribe(path) {
  assertApiPath(path)
  const list = eventSubscribers.get(path) ?? new Set()
  const subId = `${path}#${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  list.add(subId)
  eventSubscribers.set(path, list)
  return subId
}

/** 取消订阅 */
export function handleUnsubscribe(subId) {
  for (const [path, list] of eventSubscribers) {
    if (list.has(subId)) {
      list.delete(subId)
      if (list.size === 0) eventSubscribers.delete(path)
      return true
    }
  }
  return false
}

/**
 * 把 store 变更推给订阅了对应 endpoint 的渲染进程。
 * 由 createServices 组装时把 settings.onChange 接进来。
 * 契约：push(subId, data) → 渲染进程 preload 按 subId 分发到回调。
 */
export function wireStorePush() {
  if (!services) return
  // settings 域变更 → 推给订阅 /api/settings/events 的客户端
  const wire = (domain) => {
    const store = services[domain]
    if (!store || typeof store.onChange !== 'function') return
    store.onChange((change) => {
      const endpoint = `/api/${domain}/events`
      for (const subId of eventSubscribers.get(endpoint) ?? []) {
        push(subId, change)
      }
    })
  }
  wire('settings')
  // layout 域不走 SSE 订阅：拖拽是高频变更，回推会与本地 state 主导的拖拽流程叠加造成卡顿。
  // layout 改用"初始化主动拉取 + 运行时只写不读"模式（前端 usePersistentLayout 不订阅 changed）。
}
