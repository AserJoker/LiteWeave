/**
 * LiteWeave 后端入口 —— 服务组装 + Express 壳（仅 Web 模式用）。
 *
 * 三种形态：
 * 1. 独立进程（纯 Web 开发）：`npm run dev -w server` → Express 监听端口。
 * 2. Electron 主进程内嵌：只复用 createServices()（纯逻辑，无 Express），
 *    IPC handler 直接调服务，不走 HTTP 端口。（用户方向：Electron 不需要 Express）
 * 3. Web 未来移植：transport 用 fetch/EventSource → 这里仍是 Express 壳。
 *
 * 协议统一：endpoint（URL）+ JSON。Electron 下 URL 是约定标识（IPC 路由用），
 * Web 下 URL 是真实路径。两端协议一致，未来 Web 兼容零改动。
 */
import { pathToFileURL } from 'node:url'
import cors from 'cors'
import express from 'express'
import { AiChatService } from './ai/chatService.js'
import { OpenAICompatibleChatBackend } from './ai/openaiBackend.js'
import { LiteweaveMcpServer } from './mcp/mcpServer.js'
import { createAiRoutes } from './routes/aiRoutes.js'
import { createStoreRoutes } from './routes/storeRoutes.js'
import { JsonFileStore } from './store/jsonFileStore.js'

export const DEFAULT_PORT = 3001

export { JsonFileStore } from './store/jsonFileStore.js'
export { AiChatService, MockChatBackend } from './ai/chatService.js'
export { OpenAICompatibleChatBackend } from './ai/openaiBackend.js'

/* ---------------- 纯逻辑服务组装（Electron 主进程复用，无 Express） ---------------- */

export interface LiteweaveServices {
  /** 持久化数据域（settings 为首个域；后续 editorState / scene…在此追加） */
  settings: JsonFileStore
  /** 布局数据域（面板容器归属 / 开关 / 宽度 / 激活面板） */
  layout: JsonFileStore
  /** AI 对话服务 */
  chat: AiChatService
  /** 关闭：等待持久化完成 */
  dispose(): Promise<void>
}

export interface CreateServicesOptions {
  /** 数据文件根目录；缺省取 process.cwd()（Electron 下由主进程传 userData） */
  dataDir?: string
}

/** 组装纯逻辑服务（不依赖 Express，供 Electron 主进程直接调用） */
export async function createServices(options: CreateServicesOptions = {}): Promise<LiteweaveServices> {
  // AI 对话
  const chat = new AiChatService()
  if (process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL) {
    chat.setBackend(new OpenAICompatibleChatBackend())
    console.log(`[liteweave] AI backend: ${process.env.LLM_MODEL} @ ${process.env.LLM_BASE_URL}`)
  } else {
    console.warn('[liteweave] 未配置 LLM 环境变量，使用 mock 后端（见 server/.env.example）')
  }

  // 持久化数据域
  const dataDir = options.dataDir ?? process.cwd()
  const settings = new JsonFileStore({ domain: 'settings', filePath: `${dataDir}/settings.json` })
  await settings.init()
  const layout = new JsonFileStore({ domain: 'layout', filePath: `${dataDir}/layout.json` })
  await layout.init()

  return {
    settings,
    layout,
    chat,
    dispose: async () => {
      await settings.dispose()
      await layout.dispose()
    },
  }
}

/* ---------------- Express 壳（仅 Web 模式 / 独立进程用） ---------------- */

export interface StartBackendOptions {
  /** 监听端口；缺省取 process.env.PORT ?? 3001 */
  port?: number
}

export interface BackendHandle {
  app: express.Express
  port: number
  services: LiteweaveServices
  /** 关闭 HTTP server（用于优雅退出） */
  dispose(): Promise<void>
}

/** 创建并启动 Express 后端；返回句柄（Web 模式 / 独立进程用） */
export async function startBackend(options: StartBackendOptions = {}): Promise<BackendHandle> {
  const services = await createServices()
  const app = express()
  const port = options.port ?? (Number(process.env.PORT) || DEFAULT_PORT)

  app.use(cors())
  app.use(express.json())

  // 健康检查
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // MCP Server（被外部宿主连接，Streamable HTTP transport）
  // 注：Electron 模式下 MCP server 内嵌主进程（desktop/src/main.js），此处仅独立 Web server 模式用
  const mcpServer = new LiteweaveMcpServer()
  app.use('/mcp', (req, res) => {
    void mcpServer.handleRequest(req, res, req.body)
  })

  // AI 对话（前端面板驱动）
  app.use('/api/ai', createAiRoutes(services.chat))

  // 持久化数据域：每域一个 JsonFileStore + REST/SSE 挂载
  app.use('/api/settings', createStoreRoutes(services.settings))
  app.use('/api/layout', createStoreRoutes(services.layout))

  const server = app.listen(port, () => {
    console.log(`[liteweave] server listening on http://localhost:${port}`)
    console.log(`[liteweave] MCP endpoint: http://localhost:${port}/mcp`)
  })

  return {
    app,
    port,
    services,
    dispose: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      }),
  }
}

// 独立进程入口：直接运行本文件时（npm run dev -w server / node dist/index.js）启动后端
// 用 pathToFileURL 规范化 Windows 路径（file:///D:/... 三斜杠），避免拼串出错
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startBackend()
}