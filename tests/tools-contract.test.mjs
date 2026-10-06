import test from 'node:test'
import assert from 'node:assert/strict'
import { assertHasAllTools, listToolNames, withClient } from './mcp-contract-test-utils.mjs'

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const cwd = new URL('..', import.meta.url).pathname

const CORE_TOOLS = [
  'kaleidoswap_get_quote',
  'kaleidoswap_atomic_init',
  'wdk_get_node_info',
  'wdk_get_balances',
  'wdk_mpp_pay',
  'l402_get_price',
  'l402_get_market_data',
  'mpp_request_challenge',
  'search_paid_apis',
  'kaleido_node_status',
  'rln_get_node_info',
  'rln_mpp_pay',
  'get_price',
  'get_market_data',
]

const SPARK_TOOLS = ['spark_get_balance', 'spark_get_address', 'spark_transfer_token']

const REMOVED_TOOLS = [
  'kaleidoswap_place_order',
  'kaleidoswap_get_order_status',
  'kaleidoswap_cancel_order',
  'kaleidoswap_get_open_orders',
  'kaleidoswap_get_position',
]

test('kaleido-mcp includes the canonical focused-server contracts and legacy aliases', async () => {
  const tools = await listToolNames({
    cwd,
    env: {
      WDK_SEED: TEST_MNEMONIC,
      SPARK_NETWORK: 'REGTEST',
      RLN_NODE_URL: 'http://localhost:3001',
      KALEIDOSWAP_API_URL: 'https://api.kaleidoswap.com',
    },
  })

  assertHasAllTools(tools, [...CORE_TOOLS, ...SPARK_TOOLS])
  for (const name of REMOVED_TOOLS) assert.ok(!tools.includes(name), `${name} should be removed`)
})

test('without WDK_SEED the non-Spark tools are still registered', async () => {
  const tools = await listToolNames({ cwd, env: { KALEIDO_NETWORK: 'signet' } })

  assertHasAllTools(tools, CORE_TOOLS)
  for (const name of SPARK_TOOLS) assert.ok(!tools.includes(name), `${name} should need WDK_SEED`)
})

test('server reports the package version', async () => {
  const { version } = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const info = await withClient({ cwd, env: {} }, async client => client.getServerVersion())

  assert.equal(info?.version, version)
})

test('an unknown KALEIDO_NETWORK fails fast', async () => {
  const { spawnSync } = await import('node:child_process')
  const res = spawnSync(process.execPath, ['dist/index.js'], {
    cwd,
    env: { PATH: process.env.PATH ?? '', KALEIDO_NETWORK: 'testnet4' },
    input: '',
    encoding: 'utf8',
  })

  assert.equal(res.status, 1)
  assert.match(res.stderr, /KALEIDO_NETWORK must be one of/)
})

test('RGB invoices default to the network RGB proxy and honour an explicit override', async () => {
  const { createServer } = await import('node:http')
  const bodies = []
  const rln = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      bodies.push({ url: req.url, body: raw ? JSON.parse(raw) : null })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ invoice: 'rgb:test', recipient_id: 'utxob:test', expiration_timestamp: 1, batch_transfer_idx: 0 }))
    })
  })
  await new Promise(r => rln.listen(0, '127.0.0.1', r))
  const RLN_NODE_URL = `http://127.0.0.1:${rln.address().port}`

  try {
    await withClient({ cwd, env: { KALEIDO_NETWORK: 'signet', RLN_NODE_URL } }, async client => {
      await client.callTool({ name: 'wdk_create_rgb_invoice', arguments: {} })
      await client.callTool({ name: 'wdk_create_rgb_invoice', arguments: { transport_endpoints: ['rpc://127.0.0.1:3000/json-rpc'] } })
    })
    await withClient({ cwd, env: { KALEIDO_NETWORK: 'signet', RLN_NODE_URL, RGB_PROXY_ENDPOINT: 'rpc://proxy.example/json-rpc' } }, async client => {
      await client.callTool({ name: 'wdk_create_rgb_invoice', arguments: {} })
    })
  } finally {
    rln.close()
  }

  const invoices = bodies.filter(b => b.url === '/rgbinvoice').map(b => b.body.transport_endpoints)
  assert.deepEqual(invoices, [
    ['rpcs://proxy.iriswallet.com/0.2/json-rpc'],
    ['rpc://127.0.0.1:3000/json-rpc'],
    ['rpc://proxy.example/json-rpc'],
  ])
})
