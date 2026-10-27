import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

/**
 * LiteWeave MCP Server：被外部宿主（CodeAgent 等）通过 relay 连接。
 *
 * 架构（用户定案）：
 * - 保留 relay（stdio → HTTP），Electron 主进程内嵌本 server 并提供 HTTP /mcp
 * - MCP 工具调用（run_command）→ 注入的 onCommand 回调把命令推给渲染进程执行
 * - 独立 Web server（Express）模式仍可复用本模块（node:http 与 express req/res 兼容）
 *
 * 实现：单 transport 复用模式。
 * - 首个 initialize 请求创建 transport 并 connect（拿到 session id）
 * - 后续带 session id 的请求复用同一个 transport
 * - 新 initialize（重连场景，如 relay 重启后）先 close 旧 transport 再重建
 */
/** 命令定义：带 schema 的命令可直接注册为独立 MCP 工具；run_command 仍可兜底动态命令 */
export interface CommandDefinition {
  /** 命令名（如 system.project:open），前端 CommandBus 按此执行 */
  name: string
  /** 命令说明（供 get_commands / AI 决策） */
  description: string
  /** 命令参数 zod schema（ZodRawShape）；缺省视为无参命令 */
  schema?: z.ZodRawShape
  /** MCP 工具名；缺省由 name 转换（点/冒号 → 下划线，如 system.project:open → system_project_open） */
  toolName?: string
}

/** 把命令名转换为合法 MCP 工具名（字母数字下划线） */
export function commandToToolName(name: string): string {
  return name.replace(/[.:]+/g, '_').replace(/[^A-Za-z0-9_-]/g, '_')
}

export class LiteweaveMcpServer {
  readonly mcpServer: McpServer
  private transport: StreamableHTTPServerTransport | undefined
  private sessionId: string | undefined

  /**
   * 命令落地回调：run_command / 独立命令工具触发时调用，宿主据此把命令推给前端执行。
   * @param command 命令名（如 system.project:open）
   * @param args 命令参数
   * @returns 可选的结果文本（回给 AI）
   */
  private readonly onCommand: (command: string, args: unknown) => string | void | Promise<string | void>

  /** 可用命令清单（供 get_commands 工具暴露给 AI） */
  private readonly commands: CommandDefinition[]

  /** 已注册为独立工具的命名集合（幂等：重复同步跳过） */
  private readonly registeredToolNames = new Set<string>()

  constructor(options: {
    /** 命令落地回调（Electron 宿主注入；不注入则 run_command 返回未接入提示） */
    onCommand?: (command: string, args: unknown) => string | void | Promise<string | void>
    /** 可用命令清单（描述性 + 可带 schema，供 AI 决策用） */
    commands?: CommandDefinition[]
  } = {}) {
    this.onCommand = options.onCommand ?? (() => 'MCP 未接入命令执行（宿主未注入 onCommand）')
    this.commands = options.commands ?? []

    this.mcpServer = new McpServer(
      {
        name: 'liteweave',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    )
    this.registerTools()
  }

  /**
   * 注册自定义调试工具（宿主注入，如 debug_get_state / debug_eval，依赖宿主专属能力）。
   * 调试工具用于日常诊断（检查 DOM / console / 前后端 eval），替代外部 CDP/chrome-devtools。
   */
  registerDebugTool(
    name: string,
    description: string,
    handler: (args: Record<string, unknown>) => unknown | Promise<unknown>,
    inputSchema?: z.ZodRawShape,
  ): void {
    this.mcpServer.registerTool(
      name,
      {
        title: name,
        description,
        inputSchema: inputSchema ?? {
          expression: z.string().optional().describe('要执行的 JS 表达式/语句'),
          limit: z.number().optional().describe('返回条数上限'),
        },
      },
      async (args) => {
        try {
          const result = await handler(args ?? {})
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `错误：${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          }
        }
      },
    )
  }

  /** 注册一条命令为独立 MCP 工具（幂等：工具名已注册则跳过） */
  private registerCommandTool(cmd: CommandDefinition): void {
    const toolName = cmd.toolName ?? commandToToolName(cmd.name)
    // 幂等：SDK 不允许重复注册/移除工具，已注册则跳过（命令元数据可能重复同步）
    if (this.registeredToolNames.has(toolName)) return
    this.registeredToolNames.add(toolName)
    this.mcpServer.registerTool(
      toolName,
      {
        title: `LiteWeave 命令：${cmd.name}`,
        description: `执行 LiteWeave 命令 ${cmd.name}（等价于用户在界面操作）。${cmd.description}`,
        inputSchema: cmd.schema ?? {},
      },
      async (args) => {
        const result = await this.onCommand(cmd.name, args ?? {})
        return {
          content: [{ type: 'text' as const, text: typeof result === 'string' ? result : `命令已执行：${cmd.name}` }],
        }
      },
    )
  }

  /**
   * 增量同步命令清单（渲染进程回传：单一来源在前端）。
   * 把新命令追加进命令清单并注册为独立工具（幂等：已注册跳过）；
   * 供 get_commands 与工具选择使用。
   */
  syncCommands(commands: CommandDefinition[]): void {
    if (!Array.isArray(commands)) return
    for (const cmd of commands) {
      if (!cmd || typeof cmd.name !== 'string' || !cmd.name) continue
      if (!this.commands.some((c) => c.name === cmd.name)) {
        this.commands.push(cmd)
      }
      this.registerCommandTool(cmd)
    }
  }

  private registerTools(): void {
    // 每条命令注册为独立 MCP 工具（工具名 = commandToToolName(name)），带各自 args schema。
    // AI 直接选工具调用，无需先查命令清单再拼 args —— 比单一 run_command 更利于工具选择。
    for (const cmd of this.commands) {
      this.registerCommandTool(cmd)
    }

    // 执行 LiteWeave 前端命令（动态/未知命令兜底；人工操作与 AI 指令统一走 CommandBus）
    this.mcpServer.registerTool(
      'run_command',
      {
        title: '执行 LiteWeave 命令',
        description:
          '在 LiteWeave 编辑器里执行一条命令（等价于用户在界面操作）。' +
          'command 为命令名（如 system.project:open / system.settings:set / system.i18n:setLocale），' +
          'args 为命令参数对象。用 get_commands 查看可用命令清单；多数常用命令已注册为独立工具，优先用独立工具。',
        inputSchema: {
          command: z.string().describe('要执行的命令名，如 system.project:open'),
          args: z.record(z.string(), z.unknown()).optional().describe('命令参数对象'),
        },
      },
      async ({ command, args }) => {
        if (typeof command !== 'string' || !command) {
          return { content: [{ type: 'text' as const, text: '错误：缺少 command 参数' }], isError: true }
        }
        const result = await this.onCommand(command, args ?? {})
        return {
          content: [{ type: 'text' as const, text: typeof result === 'string' ? result : `命令已执行：${command}` }],
        }
      },
    )

    // 列出可用命令（供 AI 决策）
    this.mcpServer.registerTool(
      'get_commands',
      {
        title: '查看可用命令',
        description: '列出 LiteWeave 当前可执行的命令清单（命令名 + 说明），供决定调用哪个 run_command。',
        inputSchema: {},
      },
      async () => {
        const list = this.commands
          .map((c) => `- ${c.name}: ${c.description}`)
          .join('\n')
        return {
          content: [{ type: 'text' as const, text: list || '（当前无可用命令）' }],
        }
      },
    )

    // 演示工具：AI 可通过它向 LiteWeave 说一句话（占位，后续扩展为真正的编辑指令）
    this.mcpServer.registerTool(
      'chat',
      {
        title: '与 LiteWeave 对话',
        description: 'AI 通过该工具向 LiteWeave 发送一条消息，用于演示 AI ↔ 编辑器 的指令通道。',
        inputSchema: {
          message: z.string().describe('要发送给 LiteWeave 的消息内容'),
        },
      },
      async ({ message }) => {
        return {
          content: [{ type: 'text' as const, text: `[liteweave] 收到 AI 消息：${message}` }],
        }
      },
    )

    // 演示工具：回显，验证 MCP 链路
    this.mcpServer.registerTool(
      'echo',
      {
        title: '回显',
        description: '把输入原样返回，用于验证 MCP 链路是否通畅。',
        inputSchema: {
          text: z.string().describe('要回显的文本'),
        },
      },
      async ({ text }) => {
        return { content: [{ type: 'text' as const, text }] }
      },
    )
  }

  /** 关闭并重建 transport（重连场景） */
  private async resetTransport(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close()
      } catch {
        // ignore
      }
      this.transport = undefined
      this.sessionId = undefined
    }
  }

  /**
   * 处理 MCP HTTP 请求（node:http 兼容；Express 也可复用）。
   * 调用方负责解析 body 并以第三参传入（Express 由 json middleware 注入 req.body）。
   * 单 session 复用：
   * - POST + initialize（无 session）→ 创建/重建 transport
   * - POST + 已知 session → 复用
   * - POST + 未知 session → 404
   * - 其它 → 400
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void> {
    const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined
    const method = req.method ?? 'POST'
    // body 由调用方解析后以第三参传入（node:http 需手动读；express 可传 req.body）
    const parsedBody = body

    try {
      // 复用已有 session
      if (sessionId && this.sessionId === sessionId && this.transport) {
        await this.transport.handleRequest(req, res, parsedBody)
        return
      }

      // 初始化（新 session 或重连）
      if (method === 'POST' && isInitializeRequest(parsedBody)) {
        await this.resetTransport()
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            this.sessionId = id
          },
        })
        transport.onclose = () => {
          if (this.transport === transport) {
            this.transport = undefined
            this.sessionId = undefined
          }
        }
        this.transport = transport
        await this.mcpServer.connect(transport)
        await transport.handleRequest(req, res, parsedBody)
        return
      }

      // 带 session 但未知
      if (sessionId) {
        res.statusCode = 404
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }))
        return
      }

      // 无效请求
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      }))
    } catch (err) {
      console.error('[mcp] error handling request:', err)
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }))
      }
    }
  }
}

/**
 * 创建 MCP HTTP 请求处理器（node:http 用）。
 * 返回一个 (req, res) => void 的函数，供 http.createServer 或路由分发使用。
 * 自动读取并解析 JSON body。
 */
export function createMcpHttpHandler(mcp: LiteweaveMcpServer): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    // 只处理 POST /mcp
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method Not Allowed' }, id: null }))
      return
    }

    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      // 防超大 body
      if (raw.length > 1024 * 1024) {
        req.destroy()
      }
    })
    req.on('end', () => {
      let body: unknown = undefined
      if (raw.trim()) {
        try {
          body = JSON.parse(raw)
        } catch {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }))
          return
        }
      }
      void mcp.handleRequest(req, res, body)
    })
    req.on('error', () => {
      if (!res.headersSent) {
        res.statusCode = 400
        res.end()
      }
    })
  }
}