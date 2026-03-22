/**
 * KaleidoSwap DEX tools — quotes, REST orders, atomic HTLC swaps, LSPS1 channels.
 * Ported from kaleidoswap-mcp/src/server.ts and updated for the unified server.
 */
import { z } from 'zod'
import type { WdkMcpServer } from '@tetherto/wdk-mcp-toolkit'
import type { MakerClient } from 'kaleido-sdk'

interface TrackedOrder {
  orderId: string; fromAssetId: string; toAssetId: string
  fromLayer: string; toLayer: string; fromAmount: number; toAmount: number
  depositAddress: string | null; depositAddressFormat: string | null
  receiverAddress: string; status: string; placedAt: string
}

// In-memory store — persists for process lifetime
const orderStore = new Map<string, TrackedOrder>()

export function registerKaleidoswapTools(server: WdkMcpServer, maker: MakerClient): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function findAsset(assets: any[], id: string) {
    return assets.find(a =>
      (a.protocol_ids && Object.values(a.protocol_ids as Record<string, string>).includes(id)) || a.ticker === id
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function resolveAsset(id: string, assets: any[], pairs?: any[]) {
    const found = findAsset(assets, id)
    if (found) return found
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ps: any[] = pairs ?? (await maker.listPairs()).pairs ?? []
    for (const p of ps) {
      if (p.base.ticker === id || p.base.ticker === id.toUpperCase()) return { ticker: p.base.ticker, name: p.base.name, precision: p.base.precision }
      if (p.quote.ticker === id || p.quote.ticker === id.toUpperCase()) return { ticker: p.quote.ticker, name: p.quote.name, precision: p.quote.precision }
    }
    return undefined
  }

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_get_assets',
    'List all assets tradeable on KaleidoSwap. Returns ticker, name, precision, and RGB protocol ID for each asset.',
    {},
    async () => {
      const { assets } = await maker.listAssets()
      return t(JSON.stringify(assets.map(a => ({
        ticker: a.ticker, name: a.name, precision: a.precision,
        asset_id: a.protocol_ids ? Object.values(a.protocol_ids as Record<string, string>)[0] : a.ticker,
        protocol_ids: a.protocol_ids ?? {},
      })), null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_get_pairs',
    'List all tradeable asset pairs with available layer routes (BTC_LN→RGB_LN, BTC_SPARK→SPARK, etc.).',
    {},
    async () => {
      const { pairs } = await maker.listPairs()
      return t(JSON.stringify(pairs.map(p => ({
        base: { ticker: p.base.ticker, name: p.base.name, precision: p.base.precision },
        quote: { ticker: p.quote.ticker, name: p.quote.name, precision: p.quote.precision },
        routes: p.routes ?? [],
      })), null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_get_quote',
    'Get a price quote for a swap. Returns expected output amount, price, fee, and rfq_id (use in kaleidoswap_place_order or kaleidoswap_atomic_init). Quote expires in ~60s.',
    {
      from_asset_id: z.string().describe("Asset to sell — ticker ('BTC') or RGB protocol ID ('rgb:...')"),
      to_asset_id: z.string().describe('Asset to buy'),
      from_layer: z.string().describe("Source layer: 'BTC_LN', 'BTC_SPARK', 'RGB_LN'"),
      to_layer: z.string().describe("Destination layer: 'RGB_LN', 'BTC_SPARK', 'BTC_LN'"),
      from_amount: z.number().positive().describe('Amount to sell in display units (e.g. 0.001 BTC, 100.0 USDT)'),
    },
    async ({ from_asset_id, to_asset_id, from_layer, to_layer, from_amount }) => {
      const [{ assets }, { pairs }] = await Promise.all([maker.listAssets(), maker.listPairs()])
      const fromAsset = await resolveAsset(from_asset_id, assets, pairs)
      if (!fromAsset) throw new Error(`Unknown asset: ${from_asset_id}`)
      const rawAmount = maker.toRaw(from_amount, fromAsset.precision)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const quote = await maker.getQuote({ from_asset: { asset_id: from_asset_id, layer: from_layer as any, amount: rawAmount }, to_asset: { asset_id: to_asset_id, layer: to_layer as any } })
      const toAsset = await resolveAsset(to_asset_id, assets, pairs)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toPrecision = toAsset?.precision ?? (quote.to_asset as any).precision
      return t(JSON.stringify({
        rfq_id: quote.rfq_id,
        from_asset: { asset_id: from_asset_id, ticker: quote.from_asset.ticker, layer: quote.from_asset.layer, amount_raw: quote.from_asset.amount, amount_display: maker.toDisplay(quote.from_asset.amount, fromAsset.precision) },
        to_asset: { asset_id: to_asset_id, ticker: quote.to_asset.ticker, layer: quote.to_asset.layer, amount_raw: quote.to_asset.amount, amount_display: maker.toDisplay(quote.to_asset.amount, toPrecision) },
        price: quote.price,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fee_base: (quote as any).fee?.base_fee ?? 0,
        expires_at: new Date(quote.expires_at * 1000).toISOString(),
      }, null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_get_spreads',
    'Get quotes across all available routes for a pair. Detects cross-protocol arbitrage. A spread > 0.5% between routes is actionable.',
    {
      from_asset_id: z.string(), to_asset_id: z.string(),
      from_amount: z.number().positive().describe('Amount to sell in display units'),
    },
    async ({ from_asset_id, to_asset_id, from_amount }) => {
      const [{ assets }, { pairs }] = await Promise.all([maker.listAssets(), maker.listPairs()])
      const fromAsset = await resolveAsset(from_asset_id, assets, pairs)
      const toAsset = await resolveAsset(to_asset_id, assets, pairs)
      if (!fromAsset) throw new Error(`Unknown asset: ${from_asset_id}`)
      const toPrecision = toAsset?.precision ?? 8
      const rawAmount = maker.toRaw(from_amount, fromAsset.precision)
      const routes: { from_layer: string; to_layer: string }[] = []
      for (const p of pairs) {
        const bId = p.base.protocol_ids ? Object.values(p.base.protocol_ids as Record<string, string>)[0] : p.base.ticker
        const qId = p.quote.protocol_ids ? Object.values(p.quote.protocol_ids as Record<string, string>)[0] : p.quote.ticker
        if ((bId === from_asset_id || p.base.ticker === from_asset_id) && (qId === to_asset_id || p.quote.ticker === to_asset_id) && p.routes) routes.push(...p.routes)
      }
      if (routes.length === 0) return t(`No routes found for ${from_asset_id} → ${to_asset_id}`)
      const results = await Promise.allSettled(routes.map(async r => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const q = await maker.getQuote({ from_asset: { asset_id: from_asset_id, layer: r.from_layer as any, amount: rawAmount }, to_asset: { asset_id: to_asset_id, layer: r.to_layer as any } })
        return { route: `${r.from_layer}→${r.to_layer}`, price: q.price, to_amount_display: maker.toDisplay(q.to_asset.amount, toPrecision), expires_at: new Date(q.expires_at * 1000).toISOString() }
      }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const quotes = results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled').map(r => r.value).sort((a, b) => b.to_amount_display - a.to_amount_display)
      if (quotes.length < 2) return t(JSON.stringify({ quotes, arb_opportunity: false }, null, 2))
      const spreadPct = ((quotes[0].to_amount_display - quotes[quotes.length - 1].to_amount_display) / quotes[quotes.length - 1].to_amount_display) * 100
      return t(JSON.stringify({ quotes, best_route: quotes[0].route, spread_pct: spreadPct.toFixed(4), arb_opportunity: spreadPct >= 0.5 }, null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_place_order',
    'Place a REST swap order on KaleidoSwap. Returns a deposit_address — send the exact from_amount to it to complete the swap.',
    {
      from_asset_id: z.string(), to_asset_id: z.string(),
      from_layer: z.string().describe("Source layer: 'BTC_LN', 'BTC_SPARK', 'RGB_LN'"),
      to_layer: z.string().describe("Destination layer: 'RGB_LN', 'BTC_LN', 'BTC_SPARK'"),
      from_amount: z.number().positive().describe('Amount to sell in display units'),
      receiver_address: z.string().describe('Address where output asset is delivered (RGB invoice, BOLT11, Spark address, etc.)'),
      receiver_address_format: z.string().describe("'RGB_INVOICE', 'BOLT11', 'BTC_ADDRESS', 'SPARK_ADDRESS'"),
    },
    async ({ from_asset_id, to_asset_id, from_layer, to_layer, from_amount, receiver_address, receiver_address_format }) => {
      const { assets } = await maker.listAssets()
      const fromAsset = findAsset(assets, from_asset_id)
      const toAsset = findAsset(assets, to_asset_id)
      if (!fromAsset) throw new Error(`Unknown asset: ${from_asset_id}`)
      if (!toAsset) throw new Error(`Unknown asset: ${to_asset_id}`)
      const rawAmount = maker.toRaw(from_amount, fromAsset.precision)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const quote = await maker.getQuote({ from_asset: { asset_id: from_asset_id, layer: from_layer as any, amount: rawAmount }, to_asset: { asset_id: to_asset_id, layer: to_layer as any } })
      const order = await maker.createSwapOrder({
        rfq_id: quote.rfq_id,
        from_asset: { asset_id: quote.from_asset.asset_id, name: quote.from_asset.name, ticker: quote.from_asset.ticker, layer: quote.from_asset.layer, amount: quote.from_asset.amount, precision: fromAsset.precision },
        to_asset: { asset_id: quote.to_asset.asset_id, name: quote.to_asset.name, ticker: quote.to_asset.ticker, layer: quote.to_asset.layer, amount: quote.to_asset.amount, precision: toAsset.precision },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        receiver_address: { address: receiver_address, format: receiver_address_format as any },
        min_onchain_conf: 1,
      })
      const fromDisplay = maker.toDisplay(quote.from_asset.amount, fromAsset.precision)
      const toDisplay = maker.toDisplay(quote.to_asset.amount, toAsset.precision)
      const tracked: TrackedOrder = { orderId: order.id, fromAssetId: from_asset_id, toAssetId: to_asset_id, fromLayer: from_layer, toLayer: to_layer, fromAmount: fromDisplay, toAmount: toDisplay, depositAddress: order.deposit_address?.address ?? null, depositAddressFormat: order.deposit_address?.format ?? null, receiverAddress: receiver_address, status: order.status, placedAt: new Date().toISOString() }
      orderStore.set(order.id, tracked)
      return t(JSON.stringify({ order_id: order.id, status: order.status, deposit_address: order.deposit_address?.address ?? null, deposit_address_format: order.deposit_address?.format ?? null, from_amount: fromDisplay, to_amount: toDisplay, from_ticker: fromAsset.ticker, to_ticker: toAsset.ticker, instruction: `Send ${fromDisplay} ${fromAsset.ticker} to deposit_address to complete swap` }, null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_get_order_status',
    'Check current status of a swap order. Status: PENDING → PROCESSING → FILLED | FAILED | EXPIRED | CANCELLED.',
    { order_id: z.string() },
    async ({ order_id }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { order } = await maker.getSwapOrderStatus({ order_id } as any)
      const tracked = orderStore.get(order_id)
      if (tracked && order) { tracked.status = order.status; orderStore.set(order_id, tracked) }
      return t(JSON.stringify({ order_id: order?.id, status: order?.status, from_asset: order?.from_asset ? { ticker: order.from_asset.ticker, layer: order.from_asset.layer, amount_display: order.from_asset.amount / Math.pow(10, order.from_asset.precision) } : null, to_asset: order?.to_asset ? { ticker: order.to_asset.ticker, layer: order.to_asset.layer, amount_display: order.to_asset.amount / Math.pow(10, order.to_asset.precision) } : null, deposit_address: order?.deposit_address?.address ?? null }, null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_get_open_orders',
    'List swap orders placed in this session with last known status.',
    { status_filter: z.enum(['all', 'pending', 'active', 'completed']).optional().describe("'pending'=active, 'completed'=terminal, 'all'=default") },
    async ({ status_filter = 'all' }) => {
      let orders = Array.from(orderStore.values())
      if (status_filter === 'pending' || status_filter === 'active') orders = orders.filter(o => ['PENDING', 'PROCESSING'].includes(o.status))
      else if (status_filter === 'completed') orders = orders.filter(o => ['FILLED', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(o.status))
      return t(JSON.stringify(orders, null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_cancel_order',
    'Mark an order as cancelled in the local session tracker. Orders without a deposit expire automatically on the server.',
    { order_id: z.string() },
    async ({ order_id }) => {
      const tracked = orderStore.get(order_id)
      if (!tracked) return t(JSON.stringify({ error: `Order ${order_id} not found in session` }))
      tracked.status = 'CANCELLED'; orderStore.set(order_id, tracked)
      return t(JSON.stringify({ order_id, cancelled: true, status: 'CANCELLED' }, null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_get_position',
    'Session trading stats: total orders, fill rate, volume by asset.',
    {},
    async () => {
      const orders = Array.from(orderStore.values())
      if (orders.length === 0) return t(JSON.stringify({ message: 'No orders in session', orders: 0 }))
      const byAsset: Record<string, { sold: number; bought: number; ticker: string }> = {}
      for (const o of orders) {
        if (o.status === 'FILLED') {
          if (!byAsset[o.fromAssetId]) byAsset[o.fromAssetId] = { sold: 0, bought: 0, ticker: o.fromAssetId }
          if (!byAsset[o.toAssetId]) byAsset[o.toAssetId] = { sold: 0, bought: 0, ticker: o.toAssetId }
          byAsset[o.fromAssetId].sold += o.fromAmount; byAsset[o.toAssetId].bought += o.toAmount
        }
      }
      const total = orders.length, filled = orders.filter(o => o.status === 'FILLED').length
      const pending = orders.filter(o => ['PENDING', 'PROCESSING'].includes(o.status)).length
      const failed = orders.filter(o => ['FAILED', 'EXPIRED', 'CANCELLED'].includes(o.status)).length
      return t(JSON.stringify({ session_summary: { total_orders: total, filled, pending, failed, fill_rate_pct: total > 0 ? ((filled / total) * 100).toFixed(1) : '0.0' }, volume_by_asset: Object.values(byAsset), orders: orders.slice(-10) }, null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_atomic_init',
    'Step 1 of atomic HTLC swap: initiate on KaleidoSwap. Returns swapstring and payment_hash. Use raw integer amounts from quote.from_asset.amount_raw / quote.to_asset.amount_raw.',
    {
      rfq_id: z.string(), from_asset_id: z.string(),
      from_amount_raw: z.number().int().positive().describe('Raw integer units from quote'),
      to_asset_id: z.string(),
      to_amount_raw: z.number().int().positive().describe('Raw integer units from quote'),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ rfq_id, from_asset_id, from_amount_raw, to_asset_id, to_amount_raw }) => t(JSON.stringify(await maker.initSwap({ rfq_id, from_asset: from_asset_id, from_amount: from_amount_raw, to_asset: to_asset_id, to_amount: to_amount_raw } as any), null, 2)))

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_atomic_execute',
    'Step 3 of atomic swap: confirm execution after rln_atomic_taker has whitelisted the HTLC. Provide swapstring, payment_hash from kaleidoswap_atomic_init, plus taker_pubkey from rln_get_node_info.',
    { swapstring: z.string(), taker_pubkey: z.string().describe('Node pubkey from rln_get_node_info'), payment_hash: z.string() },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ swapstring, taker_pubkey, payment_hash }) => t(JSON.stringify(await maker.executeSwap({ swapstring, taker_pubkey, payment_hash } as any), null, 2)))

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_atomic_status',
    'Poll atomic swap status by payment_hash. Status: Waiting → Pending → Succeeded | Expired | Failed.',
    { payment_hash: z.string() },
    async ({ payment_hash }) => t(JSON.stringify(await maker.getAtomicSwapStatus({ payment_hash }), null, 2)))

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_lsp_get_info',
    'Get LSP peer connection info and channel capacity limits. Call first to get lsp_connection_url for rln_connect_peer.',
    {},
    async () => {
      const info = await maker.getLspInfo()
      return t(JSON.stringify({ lsp_connection_url: info.lsp_connection_url, options: { min_channel_balance_sat: info.options.min_channel_balance_sat, max_channel_balance_sat: info.options.max_channel_balance_sat, max_channel_expiry_blocks: info.options.max_channel_expiry_blocks }, assets: info.assets.map(a => ({ ticker: a.ticker, asset_id: a.asset_id })), instruction: 'Use lsp_connection_url with rln_connect_peer before kaleidoswap_lsp_create_order' }, null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_lsp_estimate_fees',
    'Estimate LSPS1 channel opening fees (setup, capacity, duration, total). Call before kaleidoswap_lsp_create_order.',
    {
      client_pubkey: z.string(), lsp_balance_sat: z.number().int().positive(),
      client_balance_sat: z.number().int().min(0), channel_expiry_blocks: z.number().int().positive(),
      required_channel_confirmations: z.number().int().min(0).optional(),
      funding_confirms_within_blocks: z.number().int().positive().optional(),
      asset_id: z.string().optional(), lsp_asset_amount: z.number().optional(), rfq_id: z.string().optional(),
    },
    async ({ client_pubkey, lsp_balance_sat, client_balance_sat, channel_expiry_blocks, required_channel_confirmations, funding_confirms_within_blocks, asset_id, lsp_asset_amount, rfq_id }) => {
      const body: Record<string, unknown> = { client_pubkey, lsp_balance_sat, client_balance_sat, channel_expiry_blocks, required_channel_confirmations: required_channel_confirmations ?? 0, funding_confirms_within_blocks: funding_confirms_within_blocks ?? 6 }
      if (asset_id) body.asset_id = asset_id; if (lsp_asset_amount !== undefined) body.lsp_asset_amount = lsp_asset_amount; if (rfq_id) body.rfq_id = rfq_id
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return t(JSON.stringify(await maker.estimateLspFees(body as any), null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_lsp_create_order',
    'Request a new Lightning channel from KaleidoSwap LSP (LSPS1). Returns order_id and bolt11_invoice to pay. Poll kaleidoswap_lsp_get_order until COMPLETED.',
    {
      client_pubkey: z.string(), lsp_balance_sat: z.number().int().positive(),
      client_balance_sat: z.number().int().min(0),
      required_channel_confirmations: z.number().int().min(0).describe('0 for zero-conf'),
      funding_confirms_within_blocks: z.number().int().positive(),
      channel_expiry_blocks: z.number().int().positive(),
      announce_channel: z.boolean(),
      asset_id: z.string().optional(), lsp_asset_amount: z.number().optional(),
      client_asset_amount: z.number().optional(), rfq_id: z.string().optional(),
    },
    async ({ client_pubkey, lsp_balance_sat, client_balance_sat, required_channel_confirmations, funding_confirms_within_blocks, channel_expiry_blocks, announce_channel, asset_id, lsp_asset_amount, client_asset_amount, rfq_id }) => {
      const body: Record<string, unknown> = { client_pubkey, lsp_balance_sat, client_balance_sat, required_channel_confirmations, funding_confirms_within_blocks, channel_expiry_blocks, announce_channel }
      if (asset_id) body.asset_id = asset_id; if (lsp_asset_amount !== undefined) body.lsp_asset_amount = lsp_asset_amount; if (client_asset_amount !== undefined) body.client_asset_amount = client_asset_amount; if (rfq_id) body.rfq_id = rfq_id
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = await maker.createLspOrder(body as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payment: any = order.payment
      const bolt11 = payment?.bolt11?.invoice ?? payment?.bolt11_invoice ?? null
      const onchain_address = payment?.onchain?.address ?? payment?.onchain_address ?? null
      const onchain_amount_sat = payment?.onchain?.fee_total_sat ?? payment?.onchain?.order_total_sat ?? null
      return t(JSON.stringify({ order_id: order.order_id, order_state: order.order_state, bolt11_invoice: bolt11, onchain_address, onchain_amount_sat, fee_total_sat: payment?.bolt11?.fee_total_sat ?? payment?.fee_total_sat ?? null, order_total_sat: payment?.bolt11?.order_total_sat ?? payment?.order_total_sat ?? null, instruction: 'Pay via rln_pay_invoice (Lightning). If Lightning fails (no channels), use rln_send_btc with onchain_address. Never use spark_pay_lightning_invoice for LSP orders. Poll with kaleidoswap_lsp_get_order.' }, null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_lsp_get_order',
    'Poll LSPS1 channel order status. States: CREATED → PENDING_RATE_DECISION → CHANNEL_OPENING → COMPLETED | FAILED.',
    { order_id: z.string() },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ order_id }) => t(JSON.stringify(await maker.getLspOrder({ order_id } as any), null, 2)))
}

const t = (content: string) => ({ content: [{ type: 'text' as const, text: content }] })
