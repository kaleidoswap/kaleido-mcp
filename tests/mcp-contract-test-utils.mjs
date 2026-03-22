import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_ENV = {
  WDK_SEED: '',
  SPARK_NETWORK: 'MAINNET',
  RLN_NODE_URL: 'http://localhost:3001',
  KALEIDOSWAP_API_URL: 'https://api.kaleidoswap.com',
}

export async function listToolNames({ cwd = process.cwd(), env = {} } = {}) {
  const root = path.resolve(cwd)
  const serverUrl = new URL('./dist/server.js', pathToFileURL(`${root}/`))
  const { createServer } = await import(`${serverUrl.href}?t=${Date.now()}`)

  const config = { ...DEFAULT_ENV, ...env }
  const stderrWrite = process.stderr.write
  process.stderr.write = () => true

  try {
    const server = createServer({
      wdkSeed: config.WDK_SEED,
      sparkNetwork: config.SPARK_NETWORK,
      rlnNodeUrl: config.RLN_NODE_URL,
      kaleidoswapApiUrl: config.KALEIDOSWAP_API_URL,
      sparkScanApiKey: config.SPARK_SCAN_API_KEY,
      sparkUsdtToken: config.SPARK_USDT_TOKEN,
    })

    const tools = server?._registeredTools
    assert.ok(tools && typeof tools === 'object', 'Server did not expose a tool registry')
    return Object.keys(tools).sort()
  } finally {
    process.stderr.write = stderrWrite
  }
}

export function assertHasAllTools(actual, expected) {
  const missing = expected.filter(tool => !actual.includes(tool))
  assert.deepStrictEqual(missing, [], `Missing tools: ${missing.join(', ')}`)
}
