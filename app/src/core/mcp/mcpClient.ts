/**
 * MCP 命令订阅客户端 —— 接收主进程推送的 MCP 命令并交给 CommandBus 执行。
 *
 * 链路：agent（CodeAgent）经 MCP run_command 工具 → relay → Electron 主进程 MCP server
 * → onCommand 回调 → webContents.send('mcp:command') → 本客户端 → runCommand → 界面响应。
 *
 * 仅 Electron 可用（依赖 preload 的 window.liteweave.onMcpCommand）；
 * Web/非 Electron 环境下订阅为空操作（返回空取消函数）。
 */

/** MCP 命令载荷（主进程 onMcpCommand 透传） */
export interface McpCommandPayload {
  command: string
  args?: unknown
}

/** preload 暴露的桥接口（与 desktop/src/preload.cjs 契约一致） */
interface McpBridge {
  onMcpCommand?: (cb: (payload: unknown) => void) => () => void
}

function getBridge(): McpBridge | undefined {
  const w = window as unknown as { liteweave?: McpBridge }
  return w.liteweave
}

/**
 * 订阅 MCP 命令；返回取消订阅函数。
 * 非 Electron / preload 未暴露时返回空操作（不抛错）。
 */
export function subscribeMcpCommands(handler: (payload: McpCommandPayload) => void): () => void {
  const bridge = getBridge()
  if (!bridge || typeof bridge.onMcpCommand !== 'function') {
    console.warn('[mcp] preload 未暴露 onMcpCommand，跳过 MCP 命令订阅（非 Electron 环境）')
    return () => {}
  }
  return bridge.onMcpCommand((payload) => {
    const { command, args } = (payload ?? {}) as { command?: string; args?: unknown }
    if (typeof command === 'string' && command) {
      handler({ command, args })
    }
  })
}