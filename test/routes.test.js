import assert from 'node:assert/strict'
import { it } from 'vitest'
import { jsonRoute } from '../src/host/routes'

function makeReq({ method = 'POST', headers = { 'content-type': 'application/json' } } = {}) {
  const listeners = new Map()
  const req = {
    method,
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers,
    on(event, listener) {
      listeners.set(event, listener)
      return () => {}
    },
    destroy() {},
  }
  const emit = (event, payload) => {
    listeners.get(event)?.(payload)
  }
  return {
    req,
    emit,
    end: async () => {
      listeners.get('end')?.()
      await Promise.resolve()
    },
  }
}

function makeRes() {
  const res = {
    statusCode: undefined,
    body: undefined,
    headers: {},
    responses: 0,
    writeHead(code, headers) {
      res.statusCode = code
      Object.assign(res.headers, headers)
    },
    setHeader(name, value) {
      res.headers[name] = value
    },
    end(body) {
      res.responses += 1
      res.body = body
    },
    destroy() {},
  }
  return res
}

const okHandler = async () => [200, { ok: true }]

it('enforces method restrictions on mutate routes', async () => {
  const route = jsonRoute('/api/x', okHandler, { mutate: true })
  const { req, end } = makeReq({ method: 'GET' })
  const res = makeRes()
  route.handler(req, res)
  await end()
  assert.equal(res.statusCode, 405)
  assert.equal(res.responses, 1)
})

it('rejects oversized bodies immediately with 413', async () => {
  const route = jsonRoute('/api/x', okHandler, { mutate: true })
  const { req, emit } = makeReq()
  const res = makeRes()
  route.handler(req, res)
  emit('data', 'x'.repeat(20000))
  assert.equal(res.statusCode, 413)
  assert.equal(res.responses, 1)
})

it('returns 415 for non-JSON content types on mutate routes', async () => {
  const route = jsonRoute('/api/x', okHandler, { mutate: true })
  const { req, end } = makeReq({ headers: { 'content-type': 'text/plain' } })
  const res = makeRes()
  route.handler(req, res)
  await end()
  assert.equal(res.statusCode, 415)
})

it('sets nosniff and no-store headers on every response', async () => {
  const route = jsonRoute('/api/x', okHandler, { mutate: true })
  const { req, end } = makeReq()
  const res = makeRes()
  route.handler(req, res)
  await end()
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['cache-control'], 'no-store')
})

it('never responds twice when the stream errors after a response', async () => {
  const route = jsonRoute('/api/x', okHandler, { mutate: true })
  const { req, end, emit } = makeReq()
  const res = makeRes()
  route.handler(req, res)
  await end()
  emit('error', new Error('late stream error'))
  assert.equal(res.statusCode, 200)
  assert.equal(res.responses, 1)
})
