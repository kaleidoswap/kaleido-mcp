import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export async function withClient({ cwd, env = {} }, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'kaleido-mcp-contract-test', version: '0.0.0' })
  await client.connect(transport)
  try {
    return await fn(client)
  } finally {
    await client.close()
  }
}

export async function listTools(opts) {
  return withClient(opts, async client => (await client.listTools()).tools)
}

export async function listToolNames(opts) {
  return (await listTools(opts)).map(t => t.name)
}

export function assertHasAllTools(tools, expected) {
  const missing = expected.filter(name => !tools.includes(name))
  assert.deepEqual(missing, [], `missing tools: ${missing.join(', ')}`)
}
