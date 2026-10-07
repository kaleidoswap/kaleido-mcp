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

const SPARK_TOOLS = [
  'spark_get_balance', 'spark_get_address', 'spark_transfer_token',
  'spark_create_sats_invoice', 'spark_create_tokens_invoice',
  'spark_pay_invoice', 'spark_pay_spark_invoice', 'spark_get_invoices', 'spark_get_spark_invoices',
]

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

const SUBMARINE_TOOLS = [
  'kaleidoswap_submarine_pairs', 'kaleidoswap_submarine_create',
  'kaleidoswap_submarine_fund', 'kaleidoswap_submarine_status',
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
      KALEIDOSWAP_API_URL: 'https://maker.example.com',
    },
  })

  assertHasAllTools(tools, [...CORE_TOOLS, ...SPARK_TOOLS, ...LIQUID_TOOLS, ...SUBMARINE_TOOLS])
  for (const name of REMOVED_TOOLS) assert.ok(!tools.includes(name), `${name} should be removed`)
})

test('Spark invoice tools expose sender/expiry options and reject ambiguous amounts offline', async () => {
  await withClient({ cwd, env: { WDK_SEED: TEST_MNEMONIC, SPARK_NETWORK: 'REGTEST' } }, async client => {
    const tools = (await client.listTools()).tools
    for (const name of ['spark_create_sats_invoice', 'spark_create_tokens_invoice']) {
      const props = Object.keys(tools.find(t => t.name === name).inputSchema.properties)
      for (const opt of ['memo', 'sender_spark_address', 'expiry_minutes']) assert.ok(props.includes(opt), `${name} missing ${opt}`)
    }

    const sats = await client.callTool({ name: 'spark_create_sats_invoice', arguments: { amount_sats: 1, amount: 1 } })
    assert.equal(sats.isError, true)
    assert.match(JSON.parse(sats.content[0].text).error, /not both/)

    const pay = await client.callTool({ name: 'spark_pay_invoice', arguments: { invoices: [{ invoice: 'spark1x', amount: '1', amount_sats: 1 }] } })
    assert.equal(pay.isError, true)
    assert.match(JSON.parse(pay.content[0].text).error, /only one of/)
  })
})

test('without WDK_SEED the non-Spark tools are still registered', async () => {
  const tools = await listToolNames({ cwd, env: { KALEIDO_NETWORK: 'signet' } })

  assertHasAllTools(tools, [...CORE_TOOLS, ...SUBMARINE_TOOLS])
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

test('mainnet without a KaleidoSwap API URL fails fast', async () => {
  const { spawnSync } = await import('node:child_process')
  const res = spawnSync(process.execPath, ['dist/index.js'], {
    cwd,
    env: { PATH: process.env.PATH ?? '', KALEIDO_NETWORK: 'mainnet' },
    input: '',
    encoding: 'utf8',
  })

  assert.equal(res.status, 1)
  assert.match(res.stderr, /KALEIDOSWAP_API_URL/)
})

test('the default network is signet', async () => {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['dist/index.js'], { cwd, env: { PATH: process.env.PATH ?? '' } })
  let stderr = ''
  await new Promise(resolve => {
    child.stderr.on('data', c => {
      stderr += c
      if (stderr.includes('stdio connected')) resolve()
    })
    child.on('exit', resolve)
  })
  child.kill()

  assert.match(stderr, /network: signet/)
  assert.match(stderr, /KaleidoSwap\(https:\/\/api\.signet\.kaleidoswap\.com\)/)
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

const nodeMajor = Number(process.versions.node.split('.')[0])

test('submarine swap tools read the /v2 maker and never fund an unknown swap', { skip: nodeMajor < 22 && '@kaleidorg/swap-sdk needs Node >= 22' }, async () => {
  const { createServer } = await import('node:http')
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const card = {
    hash: 'ab'.repeat(32), rate: 0.0000116,
    limits: { minimal: 1000000000, maximal: 87427704073, maximalZeroConf: 0 },
    fees: { percentage: 0.5, minerFees: 1000 },
    fromAssetId: '5a'.repeat(32), feeAssetId: '14'.repeat(32),
  }
  const seen = []
  const maker = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    res.writeHead(req.url === '/v2/swap/submarine' ? 200 : 404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(req.url === '/v2/swap/submarine' ? { 'L-USDT': { BTC: card } } : { error: 'not found' }))
  })
  await new Promise(r => maker.listen(0, '127.0.0.1', r))
  const env = {
    KALEIDO_NETWORK: 'signet',
    KALEIDOSWAP_MAKER_URL: `http://127.0.0.1:${maker.address().port}/v2`,
    KALEIDOSWAP_SWAP_DIR: await mkdtemp(join(tmpdir(), 'kmcp-swaps-')),
  }

  try {
    await withClient({ cwd, env }, async client => {
      const call = async (name, args) => {
        const res = await client.callTool({ name, arguments: args })
        return { isError: res.isError === true, body: JSON.parse(res.content[0].text) }
      }

      const pairs = await call('kaleidoswap_submarine_pairs', {})
      assert.equal(pairs.isError, false)
      assert.deepEqual(pairs.body.pairs.map(p => [p.from, p.to, p.from_asset_id]), [['L-USDT', 'BTC', card.fromAssetId]])

      // No wallet mnemonic → no swap keys → nothing is created at the maker.
      const created = await call('kaleidoswap_submarine_create', { invoice: 'lntbs1000n1pexample' })
      assert.equal(created.isError, true)
      assert.match(created.body.error, /mnemonic/)

      // fund only accepts swaps this server created and persisted.
      const funded = await call('kaleidoswap_submarine_fund', { swap_id: 'not-ours' })
      assert.equal(funded.isError, true)
      assert.match(funded.body.error, /No submarine swap "not-ours"/)
    })
  } finally {
    maker.close()
  }
  assert.ok(!seen.some(r => r.startsWith('POST')), `no swap may be created: ${seen.join(', ')}`)
})

test('send and invoice tools accept a ticker in place of the asset_id', async () => {
  const { createServer } = await import('node:http')
  const bodies = []
  const assets = {
    nia: [
      { asset_id: 'rgb:usdt', ticker: 'USDT', name: 'Tether USD', precision: 6 },
      { asset_id: 'rgb:dup1', ticker: 'DUP', name: 'Dup One', precision: 0 },
      { asset_id: 'rgb:dup2', ticker: 'DUP', name: 'Dup Two', precision: 0 },
    ],
    uda: [],
    cfa: [{ asset_id: 'rgb:art', name: 'Artwork', precision: 0 }],
  }
  const rln = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      bodies.push({ url: req.url, body: raw ? JSON.parse(raw) : null })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(req.url === '/listassets'
        ? assets
        : req.url === '/sendrgb'
          ? { txid: 'tx1' }
          : { invoice: 'rgb:inv', recipient_id: 'utxob:test', expiration_timestamp: 1, batch_transfer_idx: 0 }))
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

      const sent = await call('wdk_send_asset', { asset_id: 'usdt', recipient_id: 'utxob:r', amount: 1.5 })
      assert.equal(sent.isError, false)
      assert.equal(sent.body.asset_id, 'rgb:usdt')
      assert.equal(sent.body.amount_raw, 1_500_000)

      const inv = await call('rln_create_rgb_invoice', { asset_id: 'Artwork' })
      assert.equal(inv.body.asset_id, 'rgb:art')

      const byId = await call('wdk_create_rgb_invoice', { asset_id: 'rgb:other' })
      assert.equal(byId.body.asset_id, 'rgb:other')

      const unknown = await call('wdk_send_asset', { asset_id: 'NOPE', recipient_id: 'utxob:r', amount: 1 })
      assert.equal(unknown.isError, true)
      assert.match(unknown.body.error, /ticker NOPE matches no asset/)

      const ambiguous = await call('wdk_create_rgb_invoice', { asset_id: 'dup' })
      assert.equal(ambiguous.isError, true)
      assert.match(ambiguous.body.error, /ticker dup matches 2 assets: rgb:dup1, rgb:dup2; pass the asset_id/)
    })
  } finally {
    rln.close()
  }

  const sends = bodies.filter(b => b.url === '/sendrgb')
  assert.equal(sends.length, 1)
  assert.deepEqual(Object.keys(sends[0].body.recipient_map), ['rgb:usdt'])
  const invoices = bodies.filter(b => b.url === '/rgbinvoice').map(b => b.body.asset_id)
  assert.deepEqual(invoices, ['rgb:art', 'rgb:other'])
})
