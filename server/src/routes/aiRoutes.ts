import { Router } from 'express'
import { z } from 'zod'
import type { AiChatService } from '../ai/chatService.js'

const chatBodySchema = z.object({
  message: z.string().min(1).max(4000),
  sessionId: z.string().optional(),
})

export function createAiRoutes(chatService: AiChatService): Router {
  const router = Router()

  // 前端 AI 面板调用的对话接口
  router.post('/chat', async (req, res) => {
    const parsed = chatBodySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request body', details: parsed.error.flatten() })
      return
    }

    const { message, sessionId } = parsed.data
    try {
      const result = await chatService.chat(message, sessionId)
      res.json(result)
    } catch (err) {
      console.error('[ai] chat error:', err)
      res.status(500).json({ error: 'chat failed' })
    }
  })

  return router
}
