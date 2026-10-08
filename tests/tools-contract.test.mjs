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

test('LSP tools: get_order sends the access_token, orders expose amount_due_sat, quotes are in sats', async () => {
  const { createServer } = await import('node:http')
  const USDT = 'rgb:usdt'
  const calls = []
  const order = (extra = {}) => ({
    order_id: 'ord-1', order_state: 'CREATED', access_token: 'tok-1', token: '',
    client_pubkey: '02ab', lsp_balance_sat: 50_000, client_balance_sat: 4_000,
    required_channel_confirmations: 0, funding_confirms_within_blocks: 6, channel_expiry_blocks: 13_140, announce_channel: false,
    payment: {
      bolt11: { state: 'EXPECT_PAYMENT', expires_at: '2026-10-07T12:00:00Z', fee_total_sat: 2_972, order_total_sat: 6_972, invoice: 'lntbs1invoice' },
      onchain: { state: 'EXPECT_PAYMENT', expires_at: '2026-10-07T12:00:00Z', fee_total_sat: 2_972, order_total_sat: 6_972, address: 'tb1qpay', min_fee_for_0conf: 2, min_onchain_payment_confirmations: 1 },
    },
    ...extra,
  })
  const routes = {
    '/api/v1/lsps1/get_info': () => ({ lsp_connection_url: '02lsp@host:9735', options: { min_channel_balance_sat: 50_000, max_channel_balance_sat: 1_000_000, max_channel_expiry_blocks: 30_160, min_required_channel_confirmations: 0, min_funding_confirms_within_blocks: 0 }, assets: [{ ticker: 'USDT', asset_id: USDT, precision: 6 }] }),
    '/api/v1/market/assets': () => ({ assets: [{ ticker: 'USDT', asset_id: USDT, precision: 6, protocol_ids: { RGB: USDT } }] }),
    '/api/v1/market/quote': () => ({ rfq_id: 'rfq-1', from_asset: { asset_id: 'BTC', layer: 'BTC_LN', amount: 1_223_000, precision: 11 }, to_asset: { asset_id: USDT, layer: 'RGB_LN', amount: 1_000_000, precision: 6 }, expires_at: 1_791_405_649 }),
    '/api/v1/lsps1/estimate_fees': () => ({ setup_fee: 1_000, capacity_fee: 500, duration_fee: 1_314, total_fee: 7_826 }),
    '/api/v1/lsps1/create_order': body => order(body.rfq_id ? { client_balance_sat: 0, asset_id: USDT, lsp_asset_amount: 1_000_000, client_asset_amount: 1_000_000, rfq_id: body.rfq_id, asset_price_sat: 1_223, payment: { bolt11: { state: 'EXPECT_PAYMENT', expires_at: 'x', fee_total_sat: 7_826, order_total_sat: 9_049, invoice: 'lntbs1asset' }, onchain: { state: 'EXPECT_PAYMENT', expires_at: 'x', fee_total_sat: 7_826, order_total_sat: 9_049, address: 'tb1qasset', min_fee_for_0conf: 2, min_onchain_payment_confirmations: 1 } } } : {}),
    '/api/v1/lsps1/get_order': () => order({ order_state: 'COMPLETED', channel: { channel_id: 'ch-1' } }),
    '/nodeinfo': () => ({ pubkey: '02client' }),
    '/address': () => ({ address: 'tb1qrefund' }),
  }
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      calls.push({ url: req.url, body })
      const route = routes[req.url]
      res.writeHead(route ? 200 : 404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(route ? route(body) : { detail: 'not found' }))
    })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}`

  try {
    await withClient({ cwd, env: { KALEIDO_NETWORK: 'signet', KALEIDOSWAP_API_URL: url, RLN_NODE_URL: url } }, async client => {
      const tools = (await client.listTools()).tools
      const getOrder = tools.find(t => t.name === 'kaleidoswap_lsp_get_order')
      assert.deepEqual(getOrder.inputSchema.required?.sort(), ['access_token', 'order_id'])
      const call = async (name, args) => {
        const res = await client.callTool({ name, arguments: args })
        assert.notEqual(res.isError, true, res.content[0].text)
        return JSON.parse(res.content[0].text)
      }

      const created = await call('kaleidoswap_lsp_create_order', { client_pubkey: '02ab', lsp_balance_sat: 50_000, client_balance_sat: 4_000, channel_expiry_blocks: 13_140 })
      assert.equal(created.access_token, 'tok-1')
      assert.equal(created.amount_due_sat, 6_972)
      assert.equal(created.fee_sat, 2_972)
      assert.equal(created.payment.onchain.amount_sat, 6_972)
      assert.equal(created.payment.onchain.address, 'tb1qpay')
      assert.equal(created.payment.bolt11.amount_sat, 6_972)
      assert.equal(created.payment.bolt11.invoice, 'lntbs1invoice')
      for (const k of ['onchain_amount_sat', 'order_total_sat', 'fee_total_sat', 'bolt11_invoice', 'onchain_address', 'token']) assert.equal(k in created, false, k)
      assert.equal('fee_total_sat' in created.payment.onchain, false)
      assert.match(created.instruction, /amount_due_sat/)

      const polled = await call('kaleidoswap_lsp_get_order', { order_id: 'ord-1', access_token: 'tok-1' })
      assert.equal(polled.order_state, 'COMPLETED')
      assert.equal(polled.amount_due_sat, 6_972)
      assert.deepEqual(calls.find(c => c.url === '/api/v1/lsps1/get_order').body, { order_id: 'ord-1', access_token: 'tok-1' })

      const quote = await call('kaleidoswap_lsp_quote_asset_channel', { asset: 'USDT', asset_amount: 1 })
      assert.equal(quote.btc_amount_sat, 1_223)
      assert.equal(quote.channel_fee_sat, 7_826)
      assert.equal(quote.total_sat, 9_049)
      assert.deepEqual(quote.fee_breakdown, { setup_fee_sat: 1_000, capacity_fee_sat: 500, duration_fee_sat: 1_314, other_fee_sat: 5_012 })
      const est = calls.find(c => c.url === '/api/v1/lsps1/estimate_fees').body
      assert.equal(est.client_asset_amount, 1_000_000)
      assert.equal(est.rfq_id, 'rfq-1')

      const asset = await call('kaleidoswap_lsp_create_asset_channel', { asset: 'USDT', asset_amount: 1, rfq_id: 'rfq-1' })
      assert.equal(asset.amount_due_sat, 9_049)
      assert.equal(asset.fee_sat, 7_826)
      assert.equal(asset.asset_price_sat, 1_223)
      assert.equal(asset.access_token, 'tok-1')
      assert.equal(asset.payment.onchain.amount_sat, 9_049)
      assert.equal(quote.total_sat, asset.amount_due_sat)
    })
  } finally {
    srv.close()
  }
})

test('atomic swap preflight blocks a swap the channels cannot carry before the maker is contacted', async () => {
  const { createServer } = await import('node:http')
  const USDT = 'rgb:usdt'
  const calls = []
  // The smallest LSP channel: 54,000 sat, 4,000 sat client balance -> 3,000 sat outbound, 10 USDT inbound.
  const small = { channel_id: 'c1', is_usable: true, ready: true, capacity_sat: 54_000, local_balance_sat: 4_000, outbound_balance_msat: 3_000_000, inbound_balance_msat: 48_340_000, next_outbound_htlc_limit_msat: 3_000_000, next_outbound_htlc_minimum_msat: 3_000_000, asset_id: USDT, asset_local_amount: 0, asset_remote_amount: 10_000_000 }
  let channels = [small]
  let channelsFail = false
  const routes = {
    '/api/v1/market/assets': () => ({ assets: [{ ticker: 'BTC', precision: 11, protocol_ids: { BTC: 'BTC' } }, { ticker: 'USDT', precision: 6, protocol_ids: { RGB: USDT } }] }),
    '/api/v1/swaps/init': () => ({ swapstring: 's', payment_hash: 'h', access_token: 'tok' }),
    '/api/v1/swaps/execute': () => ({ status: 200, message: 'ok' }),
    '/nodeinfo': () => ({ pubkey: '02client', rgb_htlc_min_msat: 3_000_000 }),
    '/taker': () => ({}),
  }
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      calls.push(req.url)
      if (req.url === '/listchannels') {
        res.writeHead(channelsFail ? 500 : 200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(channelsFail ? { error: 'boom', code: 500 } : { channels }))
      }
      const route = routes[req.url]
      res.writeHead(route ? 200 : 404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(route ? route() : { detail: 'not found' }))
    })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}`
  const HASH = 'a'.repeat(64)

  try {
    await withClient({ cwd, env: { KALEIDO_NETWORK: 'signet', KALEIDOSWAP_API_URL: url, RLN_NODE_URL: url } }, async client => {
      const call = (name, args) => client.callTool({ name, arguments: args })
      const buy = { rfq_id: 'rfq', from_asset_id: 'BTC', from_amount_raw: 2_500_000, to_asset_id: 'USDT', to_amount_raw: 2_000_000 }

      let res = await call('kaleidoswap_atomic_init', buy)
      assert.equal(res.isError, true)
      assert.match(res.content[0].text, /Need 2,500 more sat outbound \(have 3,000, swap 2,500 \+ 3,000 sat RGB HTLC minimum\)\. Receive sats over Lightning or buy a channel with a larger client balance\./)
      assert.ok(!calls.includes('/api/v1/swaps/init'), 'maker init must not be called')

      const swapstring = `2500000/btc/2000000/${USDT}/1999999999/${HASH}`
      res = await call('kaleidoswap_atomic_execute', { swapstring, taker_pubkey: '02client', payment_hash: HASH })
      assert.equal(res.isError, true)
      assert.ok(!calls.includes('/api/v1/swaps/execute'), 'maker execute must not be called')
      res = await call('wdk_atomic_taker', { swapstring })
      assert.equal(res.isError, true)
      assert.ok(!calls.includes('/taker'), 'taker whitelist must not be called')

      // Too much USDT for the 10 USDT inbound.
      channels = [{ ...small, next_outbound_htlc_limit_msat: 50_000_000 }]
      res = await call('kaleidoswap_atomic_init', { ...buy, to_amount_raw: 12_000_000 })
      assert.equal(res.isError, true)
      assert.match(res.content[0].text, /Need 2 more USDT inbound \(have 10 USDT, swap 12 USDT\)/)

      // Enough outbound and asset inbound: the maker is called.
      res = await call('kaleidoswap_atomic_init', buy)
      assert.notEqual(res.isError, true, res.content[0].text)
      assert.equal(JSON.parse(res.content[0].text).access_token, 'tok')
      assert.equal(JSON.parse(res.content[0].text).preflight_warning, undefined)

      // Selling USDT: needs asset outbound and BTC inbound >= amount + 3,000 sat.
      channels = [{ ...small, asset_local_amount: 5_000_000, inbound_balance_msat: 10_000_000 }]
      res = await call('kaleidoswap_atomic_init', { rfq_id: 'rfq', from_asset_id: USDT, from_amount_raw: 6_000_000, to_asset_id: 'BTC', to_amount_raw: 8_000_000 })
      assert.equal(res.isError, true)
      assert.match(res.content[0].text, /Need 1 more USDT outbound \(have 5 USDT, swap 6 USDT\)/)
      assert.match(res.content[0].text, /Need 1,000 more sat inbound \(have 10,000, swap 8,000 \+ 3,000 sat RGB HTLC minimum\)/)

      // Channels unreadable: warn, do not block.
      channelsFail = true
      res = await call('kaleidoswap_atomic_init', buy)
      assert.notEqual(res.isError, true, res.content[0].text)
      assert.match(JSON.parse(res.content[0].text).preflight_warning, /Channel capacity not checked/)
    })
  } finally {
    srv.close()
  }
})

test('LSP order tools state that client_balance_sat is the swap outbound', async () => {
  await withClient({ cwd, env: {} }, async client => {
    const tools = (await client.listTools()).tools
    for (const name of ['kaleidoswap_lsp_estimate_fees', 'kaleidoswap_lsp_create_order']) {
      const d = tools.find(t => t.name === name).description
      assert.match(d, /client_balance_sat is your outbound/)
      assert.match(d, /X \+ 3,000 sat/)
    }
    const stale = tools.filter(t => !t.name.startsWith('rln_') && /\brln_[a-z_]+/.test(t.description))
    assert.deepEqual(stale.map(t => t.name), [])
  })
})

test('kaleidoswap_get_quote checks amounts against pair limits and reports them in display units', async () => {
  const { createServer } = await import('node:http')
  const USDT = 'rgb:usdt'
  const calls = []
  let quoteError
  let initError
  const btc = { ticker: 'BTC', asset_id: 'BTC', precision: 11, protocol_ids: { BTC: 'BTC' }, endpoints: [{ layer: 'BTC_LN', min_amount: 100_000, max_amount: 1_000_000_000, is_active: true }] }
  const usdt = { ticker: 'USDT', asset_id: USDT, precision: 6, protocol_ids: { RGB: USDT }, endpoints: [{ layer: 'RGB_LN', min_amount: 500_000, max_amount: 1_000_000_000, is_active: true }] }
  const routes = {
    '/api/v1/market/assets': () => [200, { assets: [btc, usdt] }],
    '/api/v1/market/pairs': () => [200, { pairs: [{ base: btc, quote: usdt, routes: [{ from_layer: 'BTC_LN', to_layer: 'RGB_LN' }] }] }],
    '/api/v1/market/quote': body => quoteError ? [400, { error_code: 'VALIDATION_ERROR', message: quoteError }] : [200, { rfq_id: 'rfq-1', from_asset: { asset_id: 'BTC', ticker: 'BTC', layer: 'BTC_LN', amount: body.from_asset.amount ?? 2_500_000 }, to_asset: { asset_id: USDT, ticker: 'USDT', layer: 'RGB_LN', amount: body.to_asset.amount ?? 1_000_000 }, price: 1, expires_at: 1_791_405_649 }],
    '/api/v1/swaps/init': () => [400, { error_code: 'VALIDATION_ERROR', message: initError }],
  }
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      calls.push({ url: req.url, body })
      const [status, out] = routes[req.url]?.(body) ?? [404, { detail: 'not found' }]
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}`
  const quoteCalls = () => calls.filter(c => c.url === '/api/v1/market/quote')

  try {
    // RLN_NODE_URL points at the mock: channels are unreadable, so the init preflight only warns.
    await withClient({ cwd, env: { KALEIDO_NETWORK: 'signet', KALEIDOSWAP_API_URL: url, RLN_NODE_URL: url } }, async client => {
      const desc = (await client.listTools()).tools.find(t => t.name === 'kaleidoswap_get_quote').description
      assert.match(desc, /BTC \(not sats\)/)
      assert.match(desc, /from_asset_id BTC, from_amount 0\.000025/)
      const quote = args => client.callTool({ name: 'kaleidoswap_get_quote', arguments: args })

      // 2,500 put on the USDT leg: rejected locally, in USDT, with the sats hint.
      let res = await quote({ from_asset_id: 'BTC', to_asset_id: 'USDT', to_amount: 2500 })
      assert.equal(res.isError, true)
      assert.match(res.content[0].text, /USDT amount must be between 0\.5 USDT and 1,000 USDT \(you asked to receive 2,500 USDT\)/)
      assert.match(res.content[0].text, /set from_asset_id BTC and from_amount in BTC \(2,500 sats = 0\.000025\)/)
      assert.equal(quoteCalls().length, 0, 'maker quote must not be called')

      // Sats on the BTC leg.
      res = await quote({ from_asset_id: 'BTC', to_asset_id: 'USDT', from_amount: 2500 })
      assert.equal(res.isError, true)
      assert.match(res.content[0].text, /BTC amount must be between 0\.000001 BTC \(100 sats\) and 0\.01 BTC \(1,000,000 sats\)/)
      assert.match(res.content[0].text, /Amounts are in BTC, not sats: 2,500 sats = 0\.000025 BTC/)

      // Too small when selling USDT.
      res = await quote({ from_asset_id: 'USDT', to_asset_id: 'BTC', from_amount: 0.1 })
      assert.equal(res.isError, true)
      assert.match(res.content[0].text, /you asked to sell 0\.1 USDT/)
      assert.equal(quoteCalls().length, 0)

      // from_amount_sat converts to raw BTC units.
      res = await quote({ from_asset_id: 'BTC', to_asset_id: 'USDT', from_amount_sat: 2500 })
      assert.notEqual(res.isError, true, res.content[0].text)
      assert.equal(quoteCalls()[0].body.from_asset.amount, 2_500_000)
      assert.equal(JSON.parse(res.content[0].text).from_asset.amount_display, 0.000025)

      res = await quote({ from_asset_id: 'BTC', to_asset_id: 'USDT', to_amount_sat: 2500 })
      assert.equal(res.isError, true)
      assert.match(res.content[0].text, /to_amount_sat is only for a BTC leg/)
      res = await quote({ from_asset_id: 'BTC', to_asset_id: 'USDT', from_amount: 0.001, from_amount_sat: 2500 })
      assert.equal(res.isError, true)
      assert.match(res.content[0].text, /exactly one of/)

      // Maker range errors on the priced leg are rewritten in that leg's units.
      quoteError = 'For pair BTC/USDT, the to_amount must be between 500000 and 1000000000 but got 2500000000'
      res = await quote({ from_asset_id: 'BTC', to_asset_id: 'USDT', from_amount: 0.0001 })
      assert.equal(res.isError, true)
      assert.match(res.content[0].text, /USDT amount must be between 0\.5 USDT and 1,000 USDT \(you asked to receive 2,500 USDT\)/)
      assert.doesNotMatch(res.content[0].text, /500000 and 1000000000/)

      assert.equal(calls.filter(c => c.url === '/api/v1/market/pairs').length, 1, 'pairs are cached')

      // atomic_init: raw-unit maker limits come back in display units.
      initError = 'For pair BTC/USDT, the from_amount must be between 100000 and 1000000000 but got 2500'
      res = await client.callTool({ name: 'kaleidoswap_atomic_init', arguments: { rfq_id: 'rfq-1', from_asset_id: 'BTC', from_amount_raw: 2500, to_asset_id: 'USDT', to_amount_raw: 1_000_000 } })
      assert.equal(res.isError, true)
      assert.match(res.content[0].text, /BTC amount must be between 0\.000001 BTC \(100 sats\) and 0\.01 BTC \(1,000,000 sats\) \(you asked to sell 0\.000000025 BTC \(2\.5 sats\)\)/)
      assert.match(res.content[0].text, /pass its amount_raw values unchanged/)
    })
  } finally {
    srv.close()
  }
})
