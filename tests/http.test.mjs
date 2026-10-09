import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpHttpServer, httpHost } from '../dist/http.js'

test('HTTP sessions survive sequential and concurrent requests and client disconnects', async () => {
  let disposed = 0
  const server = createMcpHttpServer(async () => {
    const mcp = new McpServer({ name: 'test', version: '1' })
    const close = mcp.close.bind(mcp)
    mcp.close = async () => { disposed++; await close() }
    mcp.tool('ping', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
    return mcp
  }, 'test-token')
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`)
  const clients = []
  const transports = []
  try {
    assert.equal((await fetch(url)).status, 401)
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer test-token', Origin: 'https://evil.example' } })).status, 403)
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: 'test', version: '1' })
      clients.push(client)
      const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer test-token' } } })
      transports.push(transport)
      await client.connect(transport)
      assert.equal((await client.listTools()).tools[0].name, 'ping')
    }
    assert.notEqual(transports[0].sessionId, transports[1].sessionId)
    const results = await Promise.all(clients.flatMap(c => [c.callTool({ name: 'ping', arguments: {} }), c.listTools()]))
    assert.equal(results[0].content[0].text, 'pong')
    const oldSession = transports[0].sessionId
    await transports[0].terminateSession()
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer test-token', 'mcp-session-id': oldSession } })).status, 404)
    assert.equal(disposed, 1)
    assert.equal((await clients[1].callTool({ name: 'ping', arguments: {} })).content[0].text, 'pong')
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer test-token' }, body: '{' })).status, 400)
    assert.equal((await clients[1].listTools()).tools.length, 1)
  } finally {
    for (const t of transports) await t.terminateSession().catch(() => {})
    for (const c of clients) await c.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test('remote listeners require authentication', () => {
  assert.equal(httpHost(), '127.0.0.1')
  assert.equal(httpHost('::1'), '::1')
  assert.throws(() => httpHost('0.0.0.0'), /MCP_AUTH_TOKEN/)
  assert.equal(httpHost('0.0.0.0', 'token'), '0.0.0.0')
})
