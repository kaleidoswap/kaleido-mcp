/**
 * Channel-capacity preflight for BTC_LN <-> RGB_LN atomic swaps.
 *
 * Mirrors the routes the maker builds in RLN `maker_execute`, seen from the taker:
 * - leg 1, maker -> taker: the asset bought (RGB) or qty_to + HTLC_MIN (BTC); an RGB leg also carries HTLC_MIN msat.
 * - leg 2, taker -> maker: qty_from + HTLC_MIN msat when selling BTC; HTLC_MIN msat plus the asset when selling RGB.
 */

export const DEFAULT_RGB_HTLC_MIN_MSAT = 3_000_000

/** One swap seen from the taker. Asset null = BTC; BTC quantities in msat, RGB in raw units. */
export interface SwapSides {
  fromAsset: string | null
  toAsset: string | null
  fromQty: number
  toQty: number
  /** Display labels for RGB assets: asset id -> { ticker, precision }. */
  labels?: Record<string, { ticker: string; precision: number }>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Channel = any

export interface PreflightNode {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNodeInfo(): Promise<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listChannels(): Promise<any>
}

export type PreflightResult =
  | { ok: true; skipped?: string; warning?: string }
  | { ok: false; message: string; shortfalls: string[] }

const fmtSat = (msat: number) => {
  const sat = msat / 1000
  return Number.isInteger(sat) ? sat.toLocaleString('en-US') : sat.toLocaleString('en-US', { maximumFractionDigits: 3 })
}

/** Swapstring: qty_from/from_asset/qty_to/to_asset/expiry/payment_hash; "btc" = BTC (msat). */
export function parseSwapstring(swapstring: string): SwapSides | null {
  const parts = swapstring.trim().split('/')
  if (parts.length !== 6) return null
  const [qf, fa, qt, ta] = parts
  const fromQty = Number(qf)
  const toQty = Number(qt)
  if (!Number.isSafeInteger(fromQty) || !Number.isSafeInteger(toQty)) return null
  const asset = (a: string) => (a === 'btc' ? null : a)
  return { fromAsset: asset(fa), toAsset: asset(ta), fromQty, toQty }
}

const outboundMsat = (c: Channel): number => c.next_outbound_htlc_limit_msat ?? c.outbound_balance_msat ?? 0
const inboundMsat = (c: Channel): number => c.inbound_balance_msat ?? 0

/** Pure capacity check against a channel list. Considers usable channels only. */
export function checkSwapCapacity(sides: SwapSides, channels: Channel[], htlcMinMsat = DEFAULT_RGB_HTLC_MIN_MSAT): PreflightResult {
  const { fromAsset, toAsset, fromQty, toQty } = sides
  if ((fromAsset === null) === (toAsset === null)) return { ok: true, skipped: 'not a BTC <-> RGB swap' }
  const usable = channels.filter(c => c.is_usable ?? c.ready ?? false)
  const minSat = fmtSat(htlcMinMsat)
  const label = (id: string) => sides.labels?.[id]
  const fmtNum = (id: string, raw: number) => {
    const l = label(id)
    return l ? (raw / 10 ** l.precision).toLocaleString('en-US', { maximumFractionDigits: l.precision }) : raw.toLocaleString('en-US')
  }
  const tickerOf = (id: string) => label(id)?.ticker ?? `raw units of ${id}`
  const fmtAsset = (id: string, raw: number) => `${fmtNum(id, raw)} ${tickerOf(id)}`
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0)
  const shortfalls: string[] = []

  if (fromAsset === null) {
    // BTC_LN -> RGB_LN
    const asset = toAsset as string
    const haveOut = max(usable.map(outboundMsat))
    const needOut = fromQty + htlcMinMsat
    if (haveOut < needOut) {
      shortfalls.push(`Need ${fmtSat(needOut - haveOut)} more sat outbound (have ${fmtSat(haveOut)}, swap ${fmtSat(fromQty)} + ${minSat} sat RGB HTLC minimum). Receive sats over Lightning or buy a channel with a larger client balance.`)
    }
    const assetChans = usable.filter(c => c.asset_id === asset)
    const haveIn = max(assetChans.map(c => c.asset_remote_amount ?? 0))
    if (haveIn < toQty) {
      shortfalls.push(`Need ${fmtNum(asset, toQty - haveIn)} more ${tickerOf(asset)} inbound (have ${fmtAsset(asset, haveIn)}, swap ${fmtAsset(asset, toQty)}). Buy an asset channel with more LSP-side asset, or swap less.`)
    } else {
      const haveBtcIn = max(assetChans.filter(c => (c.asset_remote_amount ?? 0) >= toQty).map(inboundMsat))
      if (haveBtcIn < htlcMinMsat) {
        shortfalls.push(`Need ${fmtSat(htlcMinMsat - haveBtcIn)} more sat inbound on the asset channel (have ${fmtSat(haveBtcIn)}; the asset HTLC carries the ${minSat} sat RGB HTLC minimum).`)
      }
    }
  } else {
    // RGB_LN -> BTC_LN
    const asset = fromAsset
    const assetChans = usable.filter(c => c.asset_id === asset)
    const haveAssetOut = max(assetChans.map(c => c.asset_local_amount ?? 0))
    if (haveAssetOut < fromQty) {
      shortfalls.push(`Need ${fmtNum(asset, fromQty - haveAssetOut)} more ${tickerOf(asset)} outbound (have ${fmtAsset(asset, haveAssetOut)}, swap ${fmtAsset(asset, fromQty)}). Receive the asset over Lightning or swap less.`)
    } else {
      const haveBtcOut = max(assetChans.filter(c => (c.asset_local_amount ?? 0) >= fromQty).map(outboundMsat))
      if (haveBtcOut < htlcMinMsat) {
        shortfalls.push(`Need ${fmtSat(htlcMinMsat - haveBtcOut)} more sat outbound on the asset channel (have ${fmtSat(haveBtcOut)}; the asset HTLC carries the ${minSat} sat RGB HTLC minimum). Receive sats over Lightning.`)
      }
    }
    const haveIn = max(usable.map(inboundMsat))
    const needIn = toQty + htlcMinMsat
    if (haveIn < needIn) {
      shortfalls.push(`Need ${fmtSat(needIn - haveIn)} more sat inbound (have ${fmtSat(haveIn)}, swap ${fmtSat(toQty)} + ${minSat} sat RGB HTLC minimum). Spend sats over Lightning or buy a channel with a larger LSP balance.`)
    }
  }

  if (!shortfalls.length) return { ok: true }
  return { ok: false, shortfalls, message: `Swap blocked before anything was created: your channels cannot carry it.\n${shortfalls.join('\n')}` }
}

/** Reads the node and runs the check. Never blocks when the node cannot be read. */
export async function preflightSwapCapacity(node: PreflightNode | undefined, sides: SwapSides): Promise<PreflightResult> {
  if ((sides.fromAsset === null) === (sides.toAsset === null)) return { ok: true, skipped: 'not a BTC <-> RGB swap' }
  if (!node) return { ok: true, warning: 'Channel capacity not checked: no node client.' }
  let channels: Channel[]
  try {
    channels = (await node.listChannels())?.channels ?? []
  } catch (e) {
    return { ok: true, warning: `Channel capacity not checked: could not list channels (${e instanceof Error ? e.message : String(e)}).` }
  }
  let htlcMin = DEFAULT_RGB_HTLC_MIN_MSAT
  try {
    const info = await node.getNodeInfo()
    if (typeof info?.rgb_htlc_min_msat === 'number' && info.rgb_htlc_min_msat > 0) htlcMin = info.rgb_htlc_min_msat
  } catch {
    // RLN's constant is the fallback.
  }
  return checkSwapCapacity(sides, channels, htlcMin)
}

export const preflightError = (r: { message: string }) => ({ content: [{ type: 'text' as const, text: r.message }], isError: true })
