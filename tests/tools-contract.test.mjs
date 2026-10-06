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

const RLN_TOOLS = [
  'atomic_taker', 'close_channel', 'connect_peer', 'create_ln_invoice', 'create_rgb_invoice',
  'create_utxos', 'get_address', 'get_asset_balance', 'get_balances', 'get_channel_id',
  'get_node_info', 'get_swap', 'issue_asset', 'list_assets', 'list_channels', 'list_payments',
  'list_swaps', 'list_transfers', 'mpp_pay', 'open_channel', 'pay_invoice', 'refresh_transfers',
  'send_asset', 'send_btc',
]

const LIQUID_TOOLS = [
  'liquid_get_node_info', 'liquid_get_address', 'liquid_get_balance', 'liquid_get_asset_balance',
  'liquid_list_assets', 'liquid_list_transactions', 'liquid_list_unspents',
  'liquid_send_btc', 'liquid_send_asset', 'liquid_get_fee_rates',
]

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

  assertHasAllTools(tools, [...CORE_TOOLS, ...SPARK_TOOLS, ...LIQUID_TOOLS])
  for (const name of REMOVED_TOOLS) assert.ok(!tools.includes(name), `${name} should be removed`)
})

test('without WDK_SEED the non-Spark tools are still registered', async () => {
  const tools = await listToolNames({ cwd, env: { KALEIDO_NETWORK: 'signet' } })

  assertHasAllTools(tools, CORE_TOOLS)
  for (const name of SPARK_TOOLS) assert.ok(!tools.includes(name), `${name} should need WDK_SEED`)
  for (const name of LIQUID_TOOLS) assert.ok(!tools.includes(name), `${name} should need LIQUID_MNEMONIC`)
})

test('every RLN tool is exposed as wdk_* with an rln_* alias', async () => {
  const tools = await listToolNames({ cwd, env: { KALEIDO_NETWORK: 'signet' } })

  assert.deepEqual(tools.filter(n => n.startsWith('wdk_')).sort(), RLN_TOOLS.map(n => `wdk_${n}`))
  assert.deepEqual(tools.filter(n => n.startsWith('rln_')).sort(), RLN_TOOLS.map(n => `rln_${n}`))
})

test('LIQUID_MNEMONIC alone enables the Liquid tools on testnet under the signet preset', async () => {
  await withClient({ cwd, env: { KALEIDO_NETWORK: 'signet', LIQUID_MNEMONIC: TEST_MNEMONIC } }, async client => {
    const names = (await client.listTools()).tools.map(t => t.name)
    assertHasAllTools(names, LIQUID_TOOLS)
    for (const name of SPARK_TOOLS) assert.ok(!names.includes(name), `${name} should need WDK_SEED`)

    const res = await client.callTool({ name: 'liquid_get_address', arguments: {} })
    assert.ok(!res.isError)
    assert.match(JSON.parse(res.content[0].text).address, /^tlq1/)
  })
})

test('an unknown LIQUID_NETWORK fails fast', async () => {
  const { spawnSync } = await import('node:child_process')
  const res = spawnSync(process.execPath, ['dist/index.js'], {
    cwd,
    env: { PATH: process.env.PATH ?? '', LIQUID_NETWORK: 'liquidv1' },
    input: '',
    encoding: 'utf8',
  })

  assert.equal(res.status, 1)
  assert.match(res.stderr, /LIQUID_NETWORK must be one of/)
})

test('wdk_issue_asset validates arguments and scales display amounts by precision', async () => {
  const { createServer } = await import('node:http')
  const bodies = []
  const rln = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      bodies.push({ url: req.url, body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(req.url === '/listtransfers'
        ? { transfers: [{ idx: 1, kind: 'Issuance', status: 'Settled', requested_assignment: { type: 'Fungible', value: 150 }, created_at: 1, updated_at: 2 }] }
        : { asset: { asset_id: 'rgb:test', name: body?.name, ticker: body?.ticker, precision: body?.precision, issued_supply: body?.amounts?.[0] ?? 1 } }))
    })
  })
  await new Promise(r => rln.listen(0, '127.0.0.1', r))
  const RLN_NODE_URL = `http://127.0.0.1:${rln.address().port}`

  try {
    await withClient({ cwd, env: { KALEIDO_NETWORK: 'signet', RLN_NODE_URL } }, async client => {
      const call = async (name, args) => {
        const res = await client.callTool({ name, arguments: args })
        return { isError: res.isError === true, body: JSON.parse(res.content[0].text) }
      }

      assert.deepEqual(await call('wdk_issue_asset', { name: 'No Ticker', amount: 1 }), { isError: true, body: { error: 'ticker is required for NIA' } })
      assert.deepEqual(await call('rln_issue_asset', { name: 'No Amount', ticker: 'TKT' }), { isError: true, body: { error: 'amount is required for NIA' } })

      const nia = await call('wdk_issue_asset', { name: 'Ticket', ticker: 'TKT', amount: 1.5, precision: 2 })
      assert.equal(nia.isError, false)
      assert.equal(nia.body.issued_supply_raw, 150)

      const uda = await call('rln_issue_asset', { schema: 'UDA', name: 'Badge', ticker: 'BDG' })
      assert.equal(uda.body.issued_supply_raw, 1)

      const transfers = await call('wdk_list_transfers', { asset_id: 'rgb:test' })
      assert.equal(transfers.body[0].amount_raw, 150)
    })
  } finally {
    rln.close()
  }

  assert.deepEqual(bodies.map(b => b.url), ['/issueassetnia', '/issueassetuda', '/listtransfers'])
  assert.deepEqual(bodies[0].body, { amounts: [150], ticker: 'TKT', name: 'Ticket', precision: 2 })
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
