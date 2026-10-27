/**
 * MCP 命令注册器 —— 命令元数据（单一来源在前端）。
 *
 * 设计（见 docs/design/plugin-system.md §4.5/§7）：
 * - 命令 handler 本就在渲染进程（ctx.commands.onCommand 注册），因此命令元数据也由
 *   渲染进程插件注册（ctx.mcpCommands.register），聚合后经 IPC 回传主进程 MCP server。
 * - 参数 schema 用结构化描述（type/optional/enum/description），主进程转 zod。
 */
/** 命令参数 schema 描述（结构化解，主进程转 zod；避免前后端共享 zod 实例） */
export interface McpArgSchema {
  type: 'string' | 'number' | 'boolean' | 'object'
  optional?: boolean
  description?: string
  enum?: string[]
}

/** MCP 命令定义：描述 + 参数 schema */
export interface McpCommandDef {
  /** 命令名（命名空间风格，如 system.project:create） */
  name: string
  /** 描述（MCP 工具 description） */
  description: string
  /** 参数 schema 描述（可选） */
  args?: Record<string, McpArgSchema>
}

/** MCP 命令注册器接口（挂 PluginContext.mcpCommands，插件 init 时注册） */
export interface McpCommandRegistry {
  /** 注册一条命令；name 为空 / 重复报错 */
  register(def: McpCommandDef): void
  /** 按 name 取 */
  get(name: string): McpCommandDef | undefined
  /** 全部已注册命令 */
  list(): McpCommandDef[]
  /** 移除（供测试/卸载） */
  unregister(name: string): void
}

/** 创建 MCP 命令注册器（core 内置；由 createCore 实例化并挂到 ctx） */
export function createMcpCommandRegistry(): McpCommandRegistry {
  const defs = new Map<string, McpCommandDef>()

  return {
    register(def: McpCommandDef): void {
      if (!def || typeof def.name !== 'string' || !def.name) {
        throw new Error('[mcp] 命令定义缺少有效 name')
      }
      if (defs.has(def.name)) {
        throw new Error(`[mcp] 命令 "${def.name}" 已注册，不能重复注册`)
      }
      defs.set(def.name, def)
    },

    get(name: string): McpCommandDef | undefined {
      return defs.get(name)
    },

    list(): McpCommandDef[] {
      return Array.from(defs.values())
    },

    unregister(name: string): void {
      defs.delete(name)
    },
  }
}
