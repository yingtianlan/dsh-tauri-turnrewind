/**
 * host/routes/index.ts — 同源 HTTP 路由（/api/turnrewind/*）。
 *
 * ✓/✗ 按钮经此驱动两阶段确认：confirm（POST，loopback-only）原子 claim 后执行；
 * cancel（POST）；status（GET）供卡片轮询 plan 结局。与 worktree 插件的
 * jsonRoute 模式一致：方法严格限制、body 上限、变更仅回环。
 *
 * P1-3 加固：响应一次性 guard（异常客户端不会触发重复响应/崩溃）、
 * body 超限立即 413 并断开、mutate 路由校验 JSON Content-Type、
 * 统一 nosniff/no-store 响应头、处理超时兜底（长 undo 由 status 轮询
 * 恢复，响应中断不影响服务端继续执行）。
 */

import { Buffer } from 'node:buffer'
import { MAX_ROUTE_BODY_BYTES } from '../constants'

export interface RouteRequest {
  method?: string
  url?: string
  socket?: { remoteAddress?: string }
  headers?: Record<string, string | string[] | undefined>
  on: (event: string, listener: (...args: any[]) => void) => void
  destroy?: (error?: Error) => void
  setHeader?: (name: string, value: string) => void
}

export interface RouteResponse {
  writeHead: (code: number, headers: Record<string, string>) => void
  setHeader: (name: string, value: string) => void
  end: (body?: string) => void
}

export type RouteHandler = (body: Record<string, unknown>, req: RouteRequest) => Promise<[number, unknown]> | [number, unknown]

export interface WebRoute {
  kind: 'exact'
  path: string
  handler: (req: RouteRequest, res: RouteResponse) => void
}

export interface JsonRouteOptions {
  mutate?: boolean
  /** 允许的 HTTP 方法（大写）。缺省不限制；mutate 路由隐式限定 POST。 */
  methods?: string[]
  /**
   * 处理超时（ms）。默认 120s；超时后返回 504，服务端逻辑继续执行，
   * 客户端经 status 轮询恢复结果。
   */
  timeoutMs?: number
}

export function jsonRoute(path: string, handler: RouteHandler, { mutate = false, methods = [], timeoutMs = 120000 }: JsonRouteOptions = {}): WebRoute {
  const allowed = new Set(methods.map(m => m.toUpperCase()))
  if (mutate)
    allowed.add('POST')
  return {
    kind: 'exact',
    path,
    handler(req: RouteRequest, res: RouteResponse) {
      // P1-3: 一次性响应 guard——'error'/'end' 与超时竞争时绝不二次写出。
      let responded = false
      const send = (code: number, payload: unknown): void => {
        if (responded)
          return
        responded = true
        const body = JSON.stringify(payload)
        res.writeHead(code, {
          'content-type': 'application/json; charset=utf-8',
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        })
        res.end(body)
      }
      const timeoutPayload = { error: 'request timed out; the operation may still complete — poll /api/turnrewind/status' }
      const timeout = setTimeout(send, timeoutMs, 504, timeoutPayload)
      const finish = (): void => {
        clearTimeout(timeout)
      }
      if (mutate && req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        finish()
        send(405, { error: 'mutation routes require POST' })
        return
      }
      if (allowed.size > 0 && !allowed.has((req.method ?? '').toUpperCase())) {
        res.setHeader('allow', [...allowed].join(', '))
        finish()
        send(405, { error: 'method not allowed' })
        return
      }
      const parts: string[] = []
      let totalBytes = 0
      let tooLarge = false
      req.on('data', (chunk: Buffer | string) => {
        if (tooLarge)
          return
        const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        totalBytes += Buffer.byteLength(value, 'utf8')
        if (totalBytes > MAX_ROUTE_BODY_BYTES) {
          tooLarge = true
          // P1-3: 超限立即响应并断开，不再消费剩余流。
          finish()
          send(413, { error: 'request body too large' })
          req.destroy?.(new Error('body too large'))
          return
        }
        parts.push(value)
      })
      req.on('error', () => {
        finish()
        send(400, { error: 'request stream failed' })
      })
      req.on('end', () => {
        void (async () => {
          if (tooLarge)
            return finish()
          // P1-3: mutate 路由要求 JSON Content-Type（缺省视为不符）。
          if (mutate) {
            const peer = req.socket?.remoteAddress ?? ''
            const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
            if (!loopback)
              return send(403, { error: 'mutation routes only accept loopback calls' })
            const contentType = req.headers?.['content-type']
            const type = Array.isArray(contentType) ? contentType[0] : contentType
            if (!type || !type.toLowerCase().includes('application/json'))
              return send(415, { error: 'content-type must be application/json' })
          }
          try {
            const parsed = JSON.parse(parts.join('') || '{}') as Record<string, unknown>
            const [code, payload] = await handler(parsed, req)
            finish()
            send(code, payload)
          }
          catch (error) {
            finish()
            send(500, { error: String((error as Error)?.message ?? error) })
          }
        })()
      })
    },
  }
}
