/**
 * 服务入口（Electron bundle 专用）—— 只导出纯逻辑服务，不引入 Express。
 *
 * 背景：Electron 主进程不需要 Express（用户方向），协议统一 endpoint+JSON，
 * 传输走 IPC。本入口让 esbuild 打包时只携带 createServices 及其依赖
 * （JsonFileStore / AiChatService 等），express / cors / routes 全部 tree-shake 掉。
 */
import { createServices } from './index.js'

export { createServices }
export { JsonFileStore } from './store/jsonFileStore.js'
export { AiChatService, MockChatBackend } from './ai/chatService.js'
export { OpenAICompatibleChatBackend } from './ai/openaiBackend.js'
export { LiteweaveMcpServer, createMcpHttpHandler } from './mcp/mcpServer.js'
