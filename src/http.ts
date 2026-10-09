import { createServer, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/** Each MCP session owns a server and transport; HTTP responses do not own them. */
export function createMcpHttpServer(factory: () => Promise<McpServer>, token?: string) {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; touched: number }>()
  let initializing = 0
  const reply = (res: ServerResponse, status: number, error: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error }))
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (token) {
        const actual = Buffer.from(req.headers.authorization ?? '')
        const expected = Buffer.from(`Bearer ${token}`)
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          reply(res, 401, 'Unauthorized'); return
        }
      }
      if (!token) {
        let hostname = ''
        try { hostname = new URL(`http://${req.headers.host}`).hostname } catch {}
        if (!['127.0.0.1', '[::1]', 'localhost'].includes(hostname)) {
          reply(res, 403, 'Host not allowed'); return
        }
      }
      // Browser clients must come from this origin; native MCP clients send no Origin.
      if (req.headers.origin) {
        let sameHost = false
        try { sameHost = new URL(req.headers.origin).host === req.headers.host } catch {}
        if (!sameHost) { reply(res, 403, 'Origin not allowed'); return }
      }
      if (req.url !== '/mcp' && req.url !== '/') { reply(res, 404, 'Not found'); return }
      const id = req.headers['mcp-session-id']
      if (id) {
        const session = typeof id === 'string' ? sessions.get(id) : undefined
        if (!session) { reply(res, 404, 'Unknown MCP session'); return }
        session.touched = Date.now()
        await session.transport.handleRequest(req, res)
        return
      }
      if (req.method !== 'POST') { reply(res, 400, 'Initialize an MCP session first'); return }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 1024 * 1024) { reply(res, 413, 'Request too large'); return }
        chunks.push(Buffer.from(chunk))
      }
      let body: unknown
      try { body = JSON.parse(Buffer.concat(chunks).toString()) }
      catch { reply(res, 400, 'Invalid JSON'); return }
      if (!isInitializeRequest(body)) { reply(res, 400, 'Initialize an MCP session first'); return }
      if (sessions.size + initializing >= 64) { reply(res, 503, 'Too many MCP sessions'); return }
      initializing++
      try {
        const mcp = await factory()
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: id => { sessions.set(id, { transport, touched: Date.now() }) },
        })
        await mcp.connect(transport)
        // connect installs the protocol's close callback: preserve it when cleaning the map.
        const onclose = transport.onclose
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId)
          onclose?.()
          // WdkMcpServer.close also disposes wallet key material.
          void mcp.close().catch(() => {})
        }
        try { await transport.handleRequest(req, res, body) }
        catch (error) { await transport.close(); throw error }
        if (!transport.sessionId) await transport.close()
      } finally { initializing-- }
    } catch (error) {
      process.stderr.write(`[kaleido-mcp] HTTP request failed: ${error}\n`)
      if (!res.headersSent) reply(res, 500, 'Internal server error')
      else res.end()
    }
  })
  const expiry = setInterval(() => {
    for (const [id, session] of sessions) {
      if (Date.now() - session.touched > 30 * 60_000) {
        sessions.delete(id)
        void session.transport.close().catch(() => {})
      }
    }
  }, 60_000).unref()
  server.on('close', () => {
    clearInterval(expiry)
    for (const { transport } of sessions.values()) void transport.close().catch(() => {})
    sessions.clear()
  })
  return server
}

export function httpHost(host = '127.0.0.1', token?: string): string {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !token) {
    throw new Error('MCP_AUTH_TOKEN is required when MCP_HOST is not loopback')
  }
  return host
}
