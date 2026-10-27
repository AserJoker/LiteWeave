import { randomUUID } from 'node:crypto'

/** 一条对话消息 */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 聊天后端的抽象接口：后续可换成 MCP sampling / 直连 LLM */
export interface ChatBackend {
  readonly name: string
  chat(messages: ChatMessage[]): Promise<string>
}

/**
 * 模拟 AI 后端：确定性回复，用于打通并验证“前端 → 后端 → AI → 前端”链路。
 * 后续替换为真实模型后端时，只需实现 ChatBackend 接口。
 */
export class MockChatBackend implements ChatBackend {
  readonly name = 'mock'

  async chat(messages: ChatMessage[]): Promise<string> {
    const last = messages.at(-1)?.content ?? ''
    await new Promise((r) => setTimeout(r, 300)) // 模拟一点延迟，方便前端看到“正在输入”
    return `[mock-ai] 收到你的消息：${last}（当前会话共 ${messages.length} 条消息）`
  }
}

/**
 * AI 对话服务：管理会话，通过 ChatBackend 产出回复。
 * 目前用 MockChatBackend，后续接真实模型时替换 backend。
 */
export class AiChatService {
  private backend: ChatBackend = new MockChatBackend()
  private sessions = new Map<string, ChatMessage[]>()

  /** 设置聊天后端（默认为 mock），便于后续切换到 MCP sampling / 直连 LLM */
  setBackend(backend: ChatBackend): void {
    this.backend = backend
  }

  /** 获取或创建一个会话 */
  private getHistory(sessionId?: string): ChatMessage[] {
    if (sessionId) {
      let history = this.sessions.get(sessionId)
      if (!history) {
        history = []
        this.sessions.set(sessionId, history)
      }
      return history
    }
    // 无 sessionId 时用一次性会话，不持久化
    return []
  }

  /** 发送一条用户消息并得到 AI 回复 */
  async chat(message: string, sessionId?: string): Promise<{ sessionId: string; reply: string }> {
    const id = sessionId ?? randomUUID()
    const history = this.getHistory(id)
    history.push({ role: 'user', content: message })

    const reply = await this.backend.chat(history)
    history.push({ role: 'assistant', content: reply })
    return { sessionId: id, reply }
  }
}
