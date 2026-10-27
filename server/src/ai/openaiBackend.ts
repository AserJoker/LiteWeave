/**
 * OpenAI 兼容协议的聊天后端。
 * 通过环境变量配置端点 / key / 模型，避免把凭据硬编码进代码。
 *
 * 当前接入：灵枢 DeepSeek-V4.1-Flash（OpenAI 兼容 /chat/completions）。
 * 配置（server/.env）：
 *   LLM_BASE_URL=https://computing.huawei.com/lingshu/api/v1
 *   LLM_API_KEY=sk-...
 *   LLM_MODEL=DeepSeek-V4.1-Flash
 */
import type { ChatBackend, ChatMessage } from './chatService.js'

interface OpenAiChatCompletionsResponse {
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string }
}

/** 系统提示：让模型知道自己是 LiteWeave 编辑器的 AI 助手 */
const SYSTEM_PROMPT =
  '你是 LiteWeave（游戏引擎资源编辑器 IDE）的内置 AI 助手。' +
  '你帮助用户完成资源编辑、场景搭建、问题解答等任务。' +
  '请用简体中文简洁回答。'

export class OpenAICompatibleChatBackend implements ChatBackend {
  readonly name = 'openai-compatible'

  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly model: string

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const baseUrl = env.LLM_BASE_URL
    const apiKey = env.LLM_API_KEY
    const model = env.LLM_MODEL
    if (!baseUrl || !apiKey || !model) {
      throw new Error(
        'OpenAICompatibleChatBackend 需要环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，' +
          '请在 server/.env 中配置',
      )
    }
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.apiKey = apiKey
    this.model = model
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      max_tokens: 2048,
      stream: false,
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`LLM 请求失败: ${res.status} ${detail}`)
    }

    const data = (await res.json()) as OpenAiChatCompletionsResponse
    if (data.error?.message) {
      throw new Error(`LLM 返回错误: ${data.error.message}`)
    }
    const content = data.choices?.[0]?.message?.content
    if (!content) {
      throw new Error('LLM 返回内容为空')
    }
    return content
  }
}
