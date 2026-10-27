/**
 * 通用持久化存储路由工厂 —— 每个数据域（settings / editorState…）各挂一份。
 *
 * - GET  /api/:domain         全量数据
 * - PUT  /api/:domain         写入：单条 {key, value} 或批量 {updates: [{key, value}]}
 *                             一次校验、一次持久化；批量时逐条 notify（SSE 逐条推送，前端语义不变）
 * - GET  /api/:domain/events  SSE 推送通道：数据变更 → 前端 EventSource 订阅
 */
import { Router } from 'express'
import { z } from 'zod'
import type { JsonFileStore } from '../store/jsonFileStore.js'

const setBodySchema = z.union([
  // 批量：一次提交多个字段（前端防抖批量队列使用）
  z.object({
    updates: z
      .array(z.object({ key: z.string().min(1).max(200), value: z.unknown() }))
      .min(1)
      .max(200),
  }),
  // 单条：兼容旧调用
  z.object({
    key: z.string().min(1).max(200),
    value: z.unknown(),
  }),
])

export function createStoreRoutes(store: JsonFileStore): Router {
  const router = Router()

  // 全量数据
  router.get('/', (_req, res) => {
    res.json(store.getAll())
  })

  // 写入：单条或批量
  router.put('/', async (req, res) => {
    const parsed = setBodySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request body', details: parsed.error.flatten() })
      return
    }

    try {
      const body = parsed.data
      const updates = 'updates' in body ? body.updates : [{ key: body.key, value: body.value }]
      const changedCount = await store.setMany(updates)
      res.json({ ok: true, changed: changedCount })
    } catch (err) {
      console.error('[store] set error:', err)
      res.status(400).json({ error: 'set failed' })
    }
  })

  // SSE 推送通道
  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    // 防止被浏览器/代理缓冲
    res.flushHeaders()

    // 发送初始注释行，帮助部分代理立即建立连接
    res.write(': connected\n\n')

    const unsubscribe = store.onChange((change) => {
      res.write(`data: ${JSON.stringify(change)}\n\n`)
    })

    // 客户端断开时清理订阅
    req.on('close', () => {
      unsubscribe()
    })
  })

  return router
}
