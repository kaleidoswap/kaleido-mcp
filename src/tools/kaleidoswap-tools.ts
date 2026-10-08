/**
 * KaleidoSwap DEX tools — quotes, atomic HTLC swaps, LSPS1 channels.
 * Ported from kaleidoswap-mcp/src/server.ts and updated for the unified server.
 */
import { z } from 'zod'
import type { WdkMcpServer } from '@tetherto/wdk-mcp-toolkit'
import type { MakerClient } from 'kaleido-sdk'
import { parseSwapstring, preflightError, preflightSwapCapacity, type SwapSides } from './swap-preflight.js'
import { checkLegAmount, findLegLimit, isBtc, translateMakerRangeError } from './quote-limits.js'

/** Minimal node-client surface this module needs (RlnClient is structurally compatible). */
interface NodeClientLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNodeInfo(): Promise<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAddress(): Promise<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listChannels(): Promise<any>
}

export function registerKaleidoswapTools(server: WdkMcpServer, maker: MakerClient, rln?: NodeClientLike): void {
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

  // Derive the settlement layer for an asset on the KaleidoSwap atomic venue
  // (BTC ↔ RGB): BTC settles on Lightning, RGB assets on RGB-over-Lightning.
  // Used when a caller (e.g. a deterministic recipe) omits the layer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function deriveLayer(id: string, asset?: any): string {
    const ticker = String(asset?.ticker ?? id).toUpperCase()
    return ticker === 'BTC' ? 'BTC_LN' : 'RGB_LN'
  }

  // /market/pairs carries the per-layer min/max used to pre-validate quote amounts.
  const PAIRS_TTL_MS = 60_000
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pairsCache: { at: number; pairs: any[] } | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function cachedPairs(): Promise<any[]> {
    if (pairsCache && Date.now() - pairsCache.at < PAIRS_TTL_MS) return pairsCache.pairs
    const pairs = (await maker.listPairs()).pairs ?? []
    pairsCache = { at: Date.now(), pairs }
    return pairs
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function legInfo(asset: any, id: string): { ticker: string; precision: number } {
    return { ticker: String(asset?.ticker ?? id), precision: asset?.precision ?? (isBtc(asset?.ticker ?? id) ? 11 : 0) }
  }

  /** Re-throw maker amount-range errors in display units of the leg they name. */
  async function withRangeErrors<T>(legs: { from: { ticker: string; precision: number }; to: { ticker: string; precision: number } }, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      const translated = translateMakerRangeError(e instanceof Error ? e.message : String(e), legs)
      if (translated) throw new Error(translated)
      throw e
    }
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
    'Get a price quote for a swap. Returns expected output amount, price, fee, and rfq_id (use in kaleidoswap_atomic_init). Quote expires in ~60s. Amounts are display units of the asset: BTC (not sats), USDT (not micro-units). Specify the amount on exactly one leg: from_amount to SELL a fixed input, or to_amount to BUY a fixed output (e.g. "buy 1 USDT" -> to_asset_id USDT, to_amount 1). Example: "sell 2,500 sats for USDT" -> from_asset_id BTC, from_amount 0.000025, to_asset_id USDT (or from_amount_sat 2500). A BTC leg also accepts the amount in sats via from_amount_sat / to_amount_sat. The amount is checked against the pair limits before the maker is called. Layers default to BTC_LN for BTC and RGB_LN for RGB assets when omitted.',
    {
      from_asset_id: z.string().describe("Asset to sell — ticker ('BTC') or RGB protocol ID ('rgb:...')"),
      to_asset_id: z.string().describe('Asset to buy'),
      from_layer: z.string().optional().describe("Source layer: 'BTC_LN', 'BTC_SPARK', 'RGB_LN'. Optional — derived from the asset when omitted."),
      to_layer: z.string().optional().describe("Destination layer: 'RGB_LN', 'BTC_SPARK', 'BTC_LN'. Optional — derived from the asset when omitted."),
      from_amount: z.number().positive().optional().describe('Amount to SELL in display units of from_asset (BTC, not sats: 2,500 sats = 0.000025). Provide exactly one of from_amount, to_amount, from_amount_sat, to_amount_sat.'),
      to_amount: z.number().positive().optional().describe('Amount to BUY/receive in display units of to_asset (e.g. 1.5 USDT; BTC, not sats). Provide exactly one amount field.'),
      from_amount_sat: z.number().int().positive().optional().describe('BTC to SELL, in sats. Only when from_asset_id is BTC; replaces from_amount.'),
      to_amount_sat: z.number().int().positive().optional().describe('BTC to BUY/receive, in sats. Only when to_asset_id is BTC; replaces to_amount.'),
    },
    async ({ from_asset_id, to_asset_id, from_layer, to_layer, from_amount, to_amount, from_amount_sat, to_amount_sat }) => {
      const given = [from_amount, to_amount, from_amount_sat, to_amount_sat].filter(v => v != null).length
      if (given !== 1) {
        throw new Error('Provide exactly one of from_amount (sell), to_amount (buy), from_amount_sat or to_amount_sat (BTC leg in sats).')
      }
      const [{ assets }, pairs] = await Promise.all([maker.listAssets(), cachedPairs()])
      const fromAsset = await resolveAsset(from_asset_id, assets, pairs)
      if (!fromAsset) throw new Error(`Unknown asset: ${from_asset_id}`)
      const toAsset = await resolveAsset(to_asset_id, assets, pairs)
      if (!toAsset) throw new Error(`Unknown asset: ${to_asset_id}`)
      const fLayer = from_layer ?? deriveLayer(from_asset_id, fromAsset)
      const tLayer = to_layer ?? deriveLayer(to_asset_id, toAsset)
      const legs = { from: legInfo(fromAsset, from_asset_id), to: legInfo(toAsset, to_asset_id) }
      const satsToRaw = (side: 'from' | 'to', sats: number) => {
        const leg = legs[side]
        if (!isBtc(leg.ticker)) throw new Error(`${side}_amount_sat is only for a BTC leg; ${side}_asset_id is ${leg.ticker}. Use ${side}_amount in ${leg.ticker}.`)
        return Math.round(sats * 10 ** (leg.precision - 8))
      }
      // The maker API takes the amount on exactly one leg (SwapLegInput.amount is
      // optional); the other leg is priced. from_amount → fixed sell, to_amount → fixed buy.
      const side: 'from' | 'to' = from_amount != null || from_amount_sat != null ? 'from' : 'to'
      const raw = from_amount != null ? maker.toRaw(from_amount, legs.from.precision)
        : to_amount != null ? maker.toRaw(to_amount, legs.to.precision)
        : satsToRaw(side, (from_amount_sat ?? to_amount_sat) as number)
      const limit = side === 'from'
        ? findLegLimit(pairs, from_asset_id, to_asset_id, fLayer)
        : findLegLimit(pairs, to_asset_id, from_asset_id, tLayer)
      const invalid = checkLegAmount(side, raw, limit, side === 'from' ? legs.to : legs.from)
      if (invalid) throw new Error(invalid)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fromLeg: any = { asset_id: from_asset_id, layer: fLayer }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toLeg: any = { asset_id: to_asset_id, layer: tLayer }
      if (side === 'from') fromLeg.amount = raw
      else toLeg.amount = raw
      const quote = await withRangeErrors(legs, () => maker.getQuote({ from_asset: fromLeg, to_asset: toLeg }))
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
  /**
   * Map init params to taker-side swap sides (BTC in msat, RGB in raw units). Null when an
   * asset cannot be resolved; the caller then skips the preflight with a warning.
   */
  async function initSides(fromId: string, fromRaw: number, toId: string, toRaw: number): Promise<SwapSides | null> {
    const { assets } = await maker.listAssets()
    const labels: NonNullable<SwapSides['labels']> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const side = (id: string, raw: number): { asset: string | null; qty: number } | null => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a: any = findAsset(assets as any[], id) ?? findAsset(assets as any[], id.toUpperCase())
      if (String(a?.ticker ?? id).toUpperCase() === 'BTC') return { asset: null, qty: raw * 10 ** (11 - (a?.precision ?? 11)) }
      const rgb: string | undefined = a?.protocol_ids?.RGB ?? (id.startsWith('rgb:') ? id : undefined)
      if (!rgb) return null
      if (a) labels[rgb] = { ticker: a.ticker, precision: a.precision ?? 0 }
      return { asset: rgb, qty: raw }
    }
    const f = side(fromId, fromRaw)
    const to = side(toId, toRaw)
    if (!f || !to) return null
    return { fromAsset: f.asset, fromQty: f.qty, toAsset: to.asset, toQty: to.qty, labels }
  }

  server.tool('kaleidoswap_atomic_init',
    'Step 1 of atomic HTLC swap: initiate on KaleidoSwap. Returns swapstring, payment_hash and access_token. Keep the access_token — it is returned only here and kaleidoswap_atomic_status needs it. Use raw integer amounts from quote.from_asset.amount_raw / quote.to_asset.amount_raw unchanged (not display amounts, not sats); a maker range error is reported in display units. Before contacting the maker it checks your channels: BTC→asset needs outbound (next_outbound_htlc_limit_msat) >= swap amount + the 3,000 sat RGB HTLC minimum and asset inbound >= the amount bought; asset→BTC needs asset outbound >= the amount sold and BTC inbound >= the amount bought + 3,000 sat. A shortfall returns an error with the numbers and nothing is created.',
    {
      rfq_id: z.string(), from_asset_id: z.string(),
      from_amount_raw: z.number().int().positive().describe('Raw integer units from quote'),
      to_asset_id: z.string(),
      to_amount_raw: z.number().int().positive().describe('Raw integer units from quote'),
    },
    async ({ rfq_id, from_asset_id, from_amount_raw, to_asset_id, to_amount_raw }) => {
      let warning: string | undefined
      let sides: SwapSides | null = null
      try {
        sides = await initSides(from_asset_id, from_amount_raw, to_asset_id, to_amount_raw)
        if (!sides) warning = 'Channel capacity not checked: could not resolve the swap assets.'
      } catch (e) {
        warning = `Channel capacity not checked: could not list maker assets (${e instanceof Error ? e.message : String(e)}).`
      }
      if (sides) {
        const pre = await preflightSwapCapacity(rln, sides)
        if (!pre.ok) return preflightError(pre)
        warning = pre.warning
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await maker.initSwap({ rfq_id, from_asset: from_asset_id, from_amount: from_amount_raw, to_asset: to_asset_id, to_amount: to_amount_raw } as any)
        .catch(async e => {
          const message = e instanceof Error ? e.message : String(e)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const assets: any[] = await maker.listAssets().then(r => r.assets ?? [], () => [])
          const leg = (id: string) => legInfo(findAsset(assets, id) ?? findAsset(assets, id.toUpperCase()), id)
          const translated = translateMakerRangeError(message, { from: leg(from_asset_id), to: leg(to_asset_id) }, false)
          throw translated ? new Error(`${translated} Get a new quote with kaleidoswap_get_quote and pass its amount_raw values unchanged.`) : e
        })
      return t(JSON.stringify(warning ? { ...res, preflight_warning: warning } : res, null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_atomic_execute',
    'Step 3 of atomic swap: confirm execution after wdk_atomic_taker has whitelisted the HTLC. Provide swapstring, payment_hash from kaleidoswap_atomic_init, plus taker_pubkey from wdk_get_node_info. Runs the same channel-capacity check as kaleidoswap_atomic_init on the swapstring first.',
    { swapstring: z.string(), taker_pubkey: z.string().describe('Node pubkey from wdk_get_node_info'), payment_hash: z.string() },
    async ({ swapstring, taker_pubkey, payment_hash }) => {
      const sides = parseSwapstring(swapstring)
      const pre = sides ? await preflightSwapCapacity(rln, sides) : { ok: true as const, warning: 'Channel capacity not checked: could not parse the swapstring.' }
      if (!pre.ok) return preflightError(pre)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await maker.executeSwap({ swapstring, taker_pubkey, payment_hash } as any)
      return t(JSON.stringify(pre.warning ? { ...res, preflight_warning: pre.warning } : res, null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_atomic_status',
    'Poll atomic swap status by payment_hash. Status: Waiting → Pending → Succeeded | Expired | Failed.',
    {
      payment_hash: z.string(),
      access_token: z.string().optional().describe('Per-swap token from kaleidoswap_atomic_init; required once the maker enforces it'),
    },
    async ({ payment_hash, access_token }) => t(JSON.stringify(await maker.getAtomicSwapStatus({ payment_hash, access_token: access_token ?? '' }), null, 2)))

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_lsp_get_info',
    'Get LSP peer connection info and channel capacity limits. Call first to get lsp_connection_url for wdk_connect_peer.',
    {},
    async () => {
      const info = await maker.getLspInfo()
      return t(JSON.stringify({ lsp_connection_url: info.lsp_connection_url, options: { min_channel_balance_sat: info.options.min_channel_balance_sat, max_channel_balance_sat: info.options.max_channel_balance_sat, max_channel_expiry_blocks: info.options.max_channel_expiry_blocks }, assets: info.assets.map(a => ({ ticker: a.ticker, asset_id: a.asset_id, precision: a.precision })), instruction: 'Use lsp_connection_url with wdk_connect_peer before kaleidoswap_lsp_create_order' }, null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_lsp_estimate_fees',
    'Estimate LSPS1 channel fees in sats: setup_fee + capacity_fee + duration_fee (+ asset fee) = total_fee. total_fee is the fee only; the order also charges client_balance_sat and, when buying an asset, its price. Call before kaleidoswap_lsp_create_order. client_balance_sat is your outbound liquidity, the sats you can spend or swap from the channel; lsp_balance_sat is your inbound. Usable outbound is client_balance_sat minus the channel reserve (at least 1,000 sat; 1% of capacity on larger channels). A BTC→asset swap of X sat sends X + 3,000 sat (the RGB HTLC minimum), so it needs client_balance_sat >= X + 3,000 sat + the reserve; client_balance_sat 4,000 leaves 3,000 sat outbound, which cannot carry any BTC→asset swap. An asset→BTC swap of X sat needs lsp_balance_sat >= X + 3,000 sat.',
    {
      // client_pubkey is optional — the maker prices a fee estimate from the
      // amounts/expiry alone, and recipes estimate BEFORE fetching the pubkey.
      client_pubkey: z.string().optional(),
      lsp_balance_sat: z.number().int().positive().describe('Inbound liquidity on the LSP side, in sats'),
      client_balance_sat: z.number().int().min(0).describe('Outbound liquidity pushed to you, in sats: your swap budget (BTC→asset swap needs >= swap + 3,000 sat + reserve)'),
      channel_expiry_blocks: z.number().int().positive(),
      required_channel_confirmations: z.number().int().min(0).optional(),
      funding_confirms_within_blocks: z.number().int().positive().optional(),
      asset_id: z.string().optional().describe('RGB asset id for an asset channel'),
      lsp_asset_amount: z.number().optional().describe('Asset on the LSP side, raw units'),
      client_asset_amount: z.number().optional().describe('Asset pushed to you, raw units; requires rfq_id'),
      rfq_id: z.string().optional().describe('Fresh rfq_id from kaleidoswap_get_quote when client_asset_amount > 0'),
    },
    async ({ client_pubkey, lsp_balance_sat, client_balance_sat, channel_expiry_blocks, required_channel_confirmations, funding_confirms_within_blocks, asset_id, lsp_asset_amount, client_asset_amount, rfq_id }) => {
      const body: Record<string, unknown> = { client_pubkey, lsp_balance_sat, client_balance_sat, channel_expiry_blocks, required_channel_confirmations: required_channel_confirmations ?? 0, funding_confirms_within_blocks: funding_confirms_within_blocks ?? 6 }
      if (asset_id) body.asset_id = asset_id; if (lsp_asset_amount !== undefined) body.lsp_asset_amount = lsp_asset_amount; if (client_asset_amount !== undefined) body.client_asset_amount = client_asset_amount; if (rfq_id) body.rfq_id = rfq_id
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return t(JSON.stringify(await maker.estimateLspFees(body as any), null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_lsp_create_order',
    'Request a new Lightning channel from KaleidoSwap LSP (LSPS1). SPEND. Returns order_id, access_token and payment instructions. The amount to pay is amount_due_sat (fee_sat + client_balance_sat), never fee_sat alone. Keep order_id + access_token: kaleidoswap_lsp_get_order needs both. Poll until COMPLETED. client_balance_sat is your outbound liquidity, the sats you can spend or swap from the channel; lsp_balance_sat is your inbound. Usable outbound is client_balance_sat minus the channel reserve (at least 1,000 sat; 1% of capacity on larger channels). A BTC→asset swap of X sat sends X + 3,000 sat (the RGB HTLC minimum), so it needs client_balance_sat >= X + 3,000 sat + the reserve; client_balance_sat 4,000 leaves 3,000 sat outbound, which cannot carry any BTC→asset swap. An asset→BTC swap of X sat needs lsp_balance_sat >= X + 3,000 sat.',
    {
      client_pubkey: z.string().describe('Your node pubkey (wdk_get_node_info)'),
      lsp_balance_sat: z.number().int().positive().describe('Inbound liquidity the LSP puts on its side, in sats'),
      client_balance_sat: z.number().int().min(0).describe('Outbound liquidity pushed to you, in sats; you pay for it on top of the fee. Your swap budget: a BTC→asset swap needs >= swap + 3,000 sat + reserve'),
      // These default server-side when omitted, so a deterministic recipe
      // doesn't have to supply LSPS1 plumbing it doesn't care about.
      required_channel_confirmations: z.number().int().min(0).optional().describe('0 for zero-conf (default 0)'),
      funding_confirms_within_blocks: z.number().int().positive().optional().describe('default 6'),
      channel_expiry_blocks: z.number().int().positive().describe('Channel lease in blocks (max: kaleidoswap_lsp_get_info options.max_channel_expiry_blocks)'),
      announce_channel: z.boolean().optional().describe('default false (private)'),
      refund_onchain_address: z.string().optional().describe('BTC address for refunds if the order fails after an on-chain payment'),
      asset_id: z.string().optional().describe('RGB asset id for an asset channel'),
      lsp_asset_amount: z.number().optional().describe('Asset on the LSP side, raw units (display amount x 10^precision)'),
      client_asset_amount: z.number().optional().describe('Asset pushed to you, raw units; requires rfq_id'),
      rfq_id: z.string().optional().describe('Fresh rfq_id from kaleidoswap_get_quote when client_asset_amount > 0'),
    },
    async ({ client_pubkey, lsp_balance_sat, client_balance_sat, required_channel_confirmations, funding_confirms_within_blocks, channel_expiry_blocks, announce_channel, refund_onchain_address, asset_id, lsp_asset_amount, client_asset_amount, rfq_id }) => {
      const body: Record<string, unknown> = { client_pubkey, lsp_balance_sat, client_balance_sat, required_channel_confirmations: required_channel_confirmations ?? 0, funding_confirms_within_blocks: funding_confirms_within_blocks ?? 6, channel_expiry_blocks, announce_channel: announce_channel ?? false }
      if (refund_onchain_address) body.refund_onchain_address = refund_onchain_address
      if (asset_id) body.asset_id = asset_id; if (lsp_asset_amount !== undefined) body.lsp_asset_amount = lsp_asset_amount; if (client_asset_amount !== undefined) body.client_asset_amount = client_asset_amount; if (rfq_id) body.rfq_id = rfq_id
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order = await maker.createLspOrder(body as any)
      return t(JSON.stringify({ ...formatLspOrder(order), instruction: PAY_INSTRUCTION }, null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_lsp_get_order',
    'Poll an LSPS1 channel order. Needs the access_token returned by the create call. States: CREATED → PENDING_RATE_DECISION → CHANNEL_OPENING → COMPLETED | FAILED. Same result shape as kaleidoswap_lsp_create_order.',
    {
      order_id: z.string(),
      access_token: z.string().describe('Per-order token from kaleidoswap_lsp_create_order / kaleidoswap_lsp_create_asset_channel'),
    },
    async ({ order_id, access_token }) => t(JSON.stringify(formatLspOrder(await maker.getLspOrder({ order_id, access_token })), null, 2)))

  // -----------------------------------------------------------------------
  // High-level "buy an asset channel" wrappers — the onboarding buy. They
  // resolve the asset, size the channel from LSP info, and (for create) fetch
  // the node pubkey + refund address, so the agent only supplies {asset,
  // asset_amount[, rfq_id]} instead of the full LSPS1 payload.
  // -----------------------------------------------------------------------

  /** Resolve a ticker/id to { ticker, asset_id (RGB protocol id), precision }. */
  async function resolveRgbAsset(input: string) {
    const { assets } = await maker.listAssets()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const found: any = findAsset(assets as any[], input) ?? findAsset(assets as any[], input.toUpperCase())
    if (!found) return null
    const asset_id: string = found.protocol_ids
      ? (Object.values(found.protocol_ids as Record<string, string>)[0] as string)
      : (found.asset_id ?? found.ticker)
    return { ticker: found.ticker as string, asset_id, precision: (found.precision as number) ?? 0 }
  }

  /** Size a BTC+asset channel for the onboarding buy from LSP options + sensible defaults. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function deriveChannelParams(info: any, rawAssetAmount: number) {
    const opts = info?.options ?? {}
    const lsp_balance_sat: number = opts.min_channel_balance_sat ?? opts.min_initial_lsp_balance_sat ?? 50_000
    const maxExpiry: number = opts.max_channel_expiry_blocks ?? 13_140
    return {
      lsp_balance_sat,
      client_balance_sat: 0,
      channel_expiry_blocks: Math.min(13_140, maxExpiry), // ~3 months, clamped to LSP max
      required_channel_confirmations: opts.min_required_channel_confirmations ?? 0, // 0-conf onboarding when allowed
      funding_confirms_within_blocks: opts.min_funding_confirms_within_blocks ?? 6,
      lsp_asset_amount: rawAssetAmount,
      client_asset_amount: rawAssetAmount, // pushed to the buyer = what they receive
    }
  }

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_lsp_quote_asset_channel',
    'Quote buying a NEW Lightning channel pre-loaded with an RGB asset (USDT, XAUT) from the KaleidoSwap LSP — the onboarding path for a user with on-chain BTC but no channel yet. Resolves the asset, prices it via RFQ and estimates the channel fee. All amounts are in sats: btc_amount_sat (asset price) + channel_fee_sat = total_sat, an estimate of what kaleidoswap_lsp_create_asset_channel will ask you to pay. Read-only.',
    {
      asset: z.string().describe('Asset ticker or id, e.g. "USDT" or "XAUT"'),
      asset_amount: z.number().positive().describe('Amount of the asset to load into the channel, in display units (e.g. 100)'),
    },
    async ({ asset, asset_amount }) => {
      const a = await resolveRgbAsset(asset)
      if (!a) return t(JSON.stringify({ error: `Unknown asset: ${asset}` }))
      const raw = maker.toRaw(asset_amount, a.precision)
      const info = await maker.getLspInfo()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const quote: any = await maker.getQuote({ from_asset: { asset_id: 'BTC', layer: 'BTC_LN' }, to_asset: { asset_id: a.asset_id, layer: 'RGB_LN', amount: raw } } as any)
      // BTC_LN amounts are msat (precision 11); the maker floors to sats the same way.
      const from = quote?.from_asset
      const btc_amount_sat: number | null = typeof from?.amount === 'number' ? Math.floor(from.amount / 10 ** ((from.precision ?? 11) - 8)) : null
      const params = deriveChannelParams(info, raw)
      // Best-effort fee estimate with the same body the create call sends; never block the quote on it.
      let channel_fee_sat: number | null = null
      let fee_breakdown: Record<string, number> | null = null
      let fee_error: string | undefined
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const est: any = await maker.estimateLspFees({ lsp_balance_sat: params.lsp_balance_sat, client_balance_sat: 0, channel_expiry_blocks: params.channel_expiry_blocks, required_channel_confirmations: params.required_channel_confirmations, funding_confirms_within_blocks: params.funding_confirms_within_blocks, asset_id: a.asset_id, lsp_asset_amount: params.lsp_asset_amount, client_asset_amount: params.client_asset_amount, rfq_id: quote.rfq_id } as any)
        if (typeof est?.total_fee === 'number') {
          channel_fee_sat = est.total_fee
          // other_fee_sat = asset/market-maker fee and any floor or discount, which the API does not itemise.
          fee_breakdown = { setup_fee_sat: est.setup_fee, capacity_fee_sat: est.capacity_fee, duration_fee_sat: est.duration_fee, other_fee_sat: est.total_fee - est.setup_fee - est.capacity_fee - est.duration_fee }
        }
      } catch (e) {
        fee_error = e instanceof Error ? e.message : String(e)
      }
      const total_sat = typeof btc_amount_sat === 'number' && typeof channel_fee_sat === 'number' ? btc_amount_sat + channel_fee_sat : null
      return t(JSON.stringify({
        rfq_id: quote.rfq_id,
        asset: a.ticker,
        asset_amount,
        asset_id: a.asset_id,
        btc_amount_sat,
        channel_fee_sat,
        fee_breakdown,
        total_sat,
        ...(fee_error ? { fee_error } : {}),
        lsp_balance_sat: params.lsp_balance_sat,
        channel_expiry_blocks: params.channel_expiry_blocks,
        expires_at: quote.expires_at,
        instruction: total_sat === null
          ? 'The channel fee could not be estimated; total_sat is unknown. The exact amount due comes back as amount_due_sat from kaleidoswap_lsp_create_asset_channel.'
          : 'Show total_sat to the user; on approval call kaleidoswap_lsp_create_asset_channel with this rfq_id, then pay its amount_due_sat.',
      }, null, 2))
    })

  // -----------------------------------------------------------------------
  server.tool('kaleidoswap_lsp_create_asset_channel',
    'Order a NEW Lightning channel pre-loaded with an RGB asset from the KaleidoSwap LSP, using a fresh rfq_id from kaleidoswap_lsp_quote_asset_channel. SPEND: confirmation-gated. Returns order_id, access_token and payment instructions; pay amount_due_sat (asset price + fee), never fee_sat alone. The channel (holding the asset) opens after the payment confirms. Poll kaleidoswap_lsp_get_order with order_id + access_token until COMPLETED.',
    {
      asset: z.string().describe('Asset ticker or id (must match the quote)'),
      asset_amount: z.number().positive().describe('Asset amount in display units (must match the quote)'),
      rfq_id: z.string().describe('The rfq_id from kaleidoswap_lsp_quote_asset_channel (must still be valid)'),
      // Display-only echoes from the quote so the host's confirm UI can show the
      // cost before approval; the handler ignores them. Nullable because the
      // quote may lack a fee estimate.
      total_sat: z.number().nullable().optional().describe('Internal: estimated total cost in sats (from the quote). Do not set.'),
      btc_amount_sat: z.number().nullable().optional().describe('Internal: asset price in sats (from the quote). Do not set.'),
      channel_fee_sat: z.number().nullable().optional().describe('Internal: channel fee in sats (from the quote). Do not set.'),
      expires_at: z.number().nullable().optional().describe('Internal: quote expiry unix seconds. Do not set.'),
    },
    async ({ asset, asset_amount, rfq_id }) => {
      if (!rln) return t(JSON.stringify({ error: 'Node client unavailable — cannot resolve the client pubkey to open a channel.' }))
      const a = await resolveRgbAsset(asset)
      if (!a) return t(JSON.stringify({ error: `Unknown asset: ${asset}` }))
      const raw = maker.toRaw(asset_amount, a.precision)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [info, node, addr]: [any, any, any] = await Promise.all([maker.getLspInfo(), rln.getNodeInfo(), rln.getAddress()])
      const params = deriveChannelParams(info, raw)
      const body: Record<string, unknown> = {
        client_pubkey: node.pubkey,
        lsp_balance_sat: params.lsp_balance_sat,
        client_balance_sat: 0,
        required_channel_confirmations: params.required_channel_confirmations,
        funding_confirms_within_blocks: params.funding_confirms_within_blocks,
        channel_expiry_blocks: params.channel_expiry_blocks,
        announce_channel: true,
        refund_onchain_address: addr.address,
        asset_id: a.asset_id,
        lsp_asset_amount: params.lsp_asset_amount,
        client_asset_amount: params.client_asset_amount,
        rfq_id,
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const order: any = await maker.createLspOrder(body as any)
      return t(JSON.stringify({ ...formatLspOrder(order), asset: a.ticker, asset_amount, instruction: PAY_INSTRUCTION }, null, 2))
    })
}

const PAY_INSTRUCTION = 'Pay amount_due_sat — never fee_sat alone, which excludes client_balance_sat and asset_price_sat. Lightning: wdk_pay_invoice with payment.bolt11.invoice (the amount is encoded). On-chain fallback: wdk_send_btc payment.onchain.amount_sat to payment.onchain.address. Never use spark_pay_lightning_invoice for LSP orders. Keep order_id + access_token and poll kaleidoswap_lsp_get_order until COMPLETED.'

/**
 * Normalise an LSPS1 order so the amount to pay is unambiguous: the raw
 * payment objects carry fee_total_sat next to order_total_sat, and paying the
 * fee alone underpays the order.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatLspOrder(order: any) {
  const b = order?.payment?.bolt11 ?? null
  const o = order?.payment?.onchain ?? null
  return {
    order_id: order?.order_id,
    order_state: order?.order_state,
    access_token: order?.access_token ?? null,
    amount_due_sat: b?.order_total_sat ?? o?.order_total_sat ?? null,
    fee_sat: b?.fee_total_sat ?? o?.fee_total_sat ?? null,
    client_balance_sat: order?.client_balance_sat,
    lsp_balance_sat: order?.lsp_balance_sat,
    asset_price_sat: order?.asset_price_sat ?? null,
    asset_id: order?.asset_id ?? null,
    lsp_asset_amount: order?.lsp_asset_amount ?? null,
    client_asset_amount: order?.client_asset_amount ?? null,
    rfq_id: order?.rfq_id ?? null,
    channel_expiry_blocks: order?.channel_expiry_blocks,
    announce_channel: order?.announce_channel,
    created_at: order?.created_at,
    payment: {
      bolt11: b ? { invoice: b.invoice, amount_sat: b.order_total_sat, state: b.state, expires_at: b.expires_at } : null,
      onchain: o
        ? {
            address: o.address, amount_sat: o.order_total_sat, state: o.state, expires_at: o.expires_at,
            min_fee_for_0conf: o.min_fee_for_0conf, min_onchain_payment_confirmations: o.min_onchain_payment_confirmations,
            refund_onchain_address: o.refund_onchain_address ?? null, payment_status: o.payment_status ?? null, payment_difference: o.payment_difference ?? null,
          }
        : null,
    },
    channel: order?.channel ?? null,
    failure_reason: order?.failure_reason ?? null,
  }
}

const t = (content: string) => ({ content: [{ type: 'text' as const, text: content }] })
