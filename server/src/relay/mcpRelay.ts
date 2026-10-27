#!/usr/bin/env node
/**
 * LiteWeave MCP Relay（常驻进程）
 *
 * 作用：作为稳定的 MCP 管道，把 CodeAgent 的 MCP 连接转发到 LiteWeave 后端。
 * 后端（server）开发过程中会频繁重启，relay 常驻不依赖后端的生命周期，
 * 避免 CodeAgent 每次后端重启都要重新连接 MCP。
 *
 * 架构：
 *   CodeAgent ──stdio──► Relay(MCP Server) ──HTTP──► LiteWeave 后端 /mcp
 *
 * relay 对 CodeAgent 透明转发 tools/list 与 tools/call：
 * CodeAgent 看到的就是后端真实暴露的工具（chat、echo…），调用也直接透传。
 * 后端不可达时返回明确错误，后端恢复后自动继续工作（无需重启 relay）。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const BACKEND_URL = process.env.LW_BACKEND_URL ?? 'http://localhost:3001'
const MCP_PATH = process.env.LW_MCP_PATH ?? '/mcp'
const POLL_INTERVAL = Number(process.env.LW_POLL_INTERVAL ?? 3000)

/**
 * 与后端保持一个 MCP 会话（有状态 Streamable HTTP）。
 * 启动时向后端 initialize 拿 session id，后续请求带 session id。
 * 后端重启导致 session 失效时自动重新 initialize（无感重连）。
 */
class BackendConnection {
  private sessionId: string | undefined
  /** 串行化对后端的请求，避免并发请求竞争 session（后端是单会话） */
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * 向后端发送一个 MCP JSON-RPC 请求，返回 result 部分。
   * 若会话失效则重连一次后重试。
   * 所有请求串行执行（排队），保证同一时刻只有一次初始化/请求。
   */
  async request(method: string, params: unknown): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await this.rawRequest(method, params)
          return result
        } catch (err) {
          // 会话相关错误（未初始化 / session 失效 / 连接失败）：重连后重试一次
          const msg = err instanceof Error ? err.message : String(err)
          const lower = msg.toLowerCase()
          const needsReconnect =
            lower.includes('session') ||
            lower.includes('bad request') ||
            lower.includes('fetch failed') ||
            lower.includes('econnrefused')
          if (needsReconnect && attempt === 0) {
            console.error(`[relay] backend session lost (${msg}), reconnecting...`)
            this.sessionId = undefined
            await this.initialize()
            console.error(`[relay] reconnect done, sessionId=${this.sessionId ?? '(none)'}, retrying ${method}`)
            continue
          }
          console.error(`[relay] request failed (attempt ${attempt}): ${msg}`)
          throw err
        }
      }
      throw new Error('unreachable')
    }

    // 排队串行执行；前一个请求结束（无论成败）后才开始下一个
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** 单次请求超时（notification 等可能不返回 body，不能无限等） */
  private static readonly REQUEST_TIMEOUT_MS = 5000

  private async rawRequest(method: string, params: unknown, timeoutMs = BackendConnection.REQUEST_TIMEOUT_MS): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId
    }

    // notification 不带 id（JSON-RPC 通知），否则会被后端当成请求 → Method not found
    const isNotification = method.startsWith('notifications/')
    const body = isNotification
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: crypto.randomUUID(), method, params }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch(`${BACKEND_URL}${MCP_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`后端返回 ${res.status}: ${detail}`)
    }

    // 保存后端下发的 session id（初次 initialize 时）
    const newSessionId = res.headers.get('mcp-session-id')
    if (newSessionId) {
      this.sessionId = newSessionId
    }

    const text = await res.text().catch(() => '')
    if (!text.trim()) {
      // notification / 202 空响应：无 result 可解析，直接返回 undefined
      return undefined
    }
    const jsonText = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('')
    const parsed = JSON.parse(jsonText || text) as {
      result?: unknown
      error?: { message?: string; code?: number }
    }

    if (parsed.error) {
      const err = new Error(parsed.error.message ?? `后端错误 ${parsed.error.code}`)
      ;(err as Error & { code?: number }).code = parsed.error.code
      throw err
    }
    return parsed.result
  }

  async initialize(): Promise<void> {
    const result = (await this.rawRequest('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'liteweave-relay', version: '0.1.0' },
    })) as { serverInfo?: { name?: string } }
    console.error(`[relay] initialize ok, sessionId=${this.sessionId ?? '(none)'}`)
    // 通知初始化完成（notification 不带 id，后端应返回 202 空 body）
    await this.rawRequest('notifications/initialized', {})
    console.error(`[relay] backend MCP session established (${result.serverInfo?.name ?? 'unknown'})`)
  }
}

async function checkBackend(): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/health`, { method: 'GET' })
    return res.ok
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const backend = new BackendConnection()

  const server = new Server(
    {
      name: 'liteweave-relay',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
    },
  )

  // 工具列表：透明转发到后端，并注入本 relay 专属调试工具 debug_client_caps
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = (await backend.request('tools/list', {})) as { tools?: Array<{ name: string; [k: string]: unknown }> }
    const tools = result.tools ?? []
    tools.push({
      name: 'debug_client_caps',
      description: '返回 CodeAgent（本 relay 的 client）声明的 MCP capabilities（查证 sampling/elicitation/roots 能力）',
      inputSchema: { type: 'object', properties: {} },
    })
    return { tools }
  })

  // 工具调用：透明转发到后端；特判 debug_client_caps（查证 client capabilities，不转发）
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    if (name === 'debug_client_caps') {
      const caps = server.getClientCapabilities()
      return { content: [{ type: 'text', text: JSON.stringify(caps, null, 2) }] }
    }
    const result = (await backend.request('tools/call', { name, arguments: args ?? {} })) as {
      content?: unknown[]
      isError?: boolean
    }
    return { content: result.content ?? [], isError: result.isError ?? false }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // 打印 client capabilities（初始化后；CodeAgent 重连时触发）
  setTimeout(() => {
    const caps = server.getClientCapabilities()
    console.error(`[relay] client capabilities: ${JSON.stringify(caps)}`)
  }, 1000)

  // 周期性检查后端状态并打印日志（到 stderr，不污染 stdio 协议）
  let lastStatus: boolean | null = null
  setInterval(async () => {
    const ok = await checkBackend()
    if (ok !== lastStatus) {
      lastStatus = ok
      console.error(`[relay] backend ${ok ? 'connected' : 'unreachable'} (${BACKEND_URL})`)
    }
  }, POLL_INTERVAL).unref()

  console.error(`[relay] liteweave MCP relay started, forwarding to ${BACKEND_URL}${MCP_PATH}`)
}

main().catch((err) => {
  console.error('[relay] fatal:', err)
  process.exit(1)
})
