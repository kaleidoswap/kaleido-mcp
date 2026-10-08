/**
 * Swap amount limits in display units. The maker validates raw integer amounts and
 * echoes raw-unit limits; these helpers check a leg against the pair's endpoint limits
 * and rewrite maker range errors in the asset's own units.
 */

export interface LegLimit { ticker: string; precision: number; min: number; max: number }

interface LegInfo { ticker: string; precision: number }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pair = any

const SAT_DECIMALS = 8

function matches(side: Pair, id: string): boolean {
  if (!side) return false
  const up = id.toUpperCase()
  if (side.ticker === id || String(side.ticker).toUpperCase() === up || side.asset_id === id) return true
  return !!side.protocol_ids && Object.values(side.protocol_ids as Record<string, string>).includes(id)
}

/** Raw min/max for `assetId` on `layer` within the pair that trades it against `otherId`. */
export function findLegLimit(pairs: Pair[], assetId: string, otherId: string, layer: string): LegLimit | undefined {
  for (const p of pairs ?? []) {
    const side = matches(p.base, assetId) && matches(p.quote, otherId) ? p.base
      : matches(p.quote, assetId) && matches(p.base, otherId) ? p.quote : undefined
    if (!side) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ep = (side.endpoints ?? []).find((e: any) => e.layer === layer)
    if (!ep || ep.min_amount == null || ep.max_amount == null) return undefined
    return { ticker: side.ticker, precision: side.precision ?? 0, min: Number(ep.min_amount), max: Number(ep.max_amount) }
  }
  return undefined
}

export function isBtc(ticker: string | undefined): boolean {
  return String(ticker ?? '').toUpperCase() === 'BTC'
}

function fmt(n: number, maxDecimals: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: Math.min(maxDecimals, 20) })
}

/** Raw integer units → display string, with the sat equivalent for BTC. */
export function formatAmount(raw: number, leg: LegInfo): string {
  const display = raw / 10 ** leg.precision
  const s = `${fmt(display, leg.precision)} ${leg.ticker}`
  if (!isBtc(leg.ticker)) return s
  const sats = raw / 10 ** (leg.precision - SAT_DECIMALS)
  return `${s} (${fmt(sats, 3)} sats)`
}

function satsToBtc(sats: number): string {
  return fmt(sats / 10 ** SAT_DECIMALS, SAT_DECIMALS)
}

/**
 * Sat-confusion hint for a rejected amount: the agent often passes a sat count where a
 * display amount is expected, or puts the sats on the wrong leg.
 */
function satsHint(side: 'from' | 'to', asked: number, leg: LegInfo, other: LegInfo): string {
  const n = Math.round(asked)
  if (!Number.isFinite(asked) || n < 1 || Math.abs(asked - n) > 1e-9) return ''
  const sats = fmt(n, 0)
  if (isBtc(leg.ticker)) {
    return ` Amounts are in BTC, not sats: ${sats} sats = ${satsToBtc(n)} BTC (or pass ${side}_amount_sat ${n}).`
  }
  if (isBtc(other.ticker)) {
    const otherSide = side === 'from' ? 'to' : 'from'
    const verb = otherSide === 'from' ? 'sell' : 'receive'
    return ` If you meant ${sats} sats: to ${verb} sats, set ${otherSide}_asset_id BTC and ${otherSide}_amount in BTC (${sats} sats = ${satsToBtc(n)}), or pass ${otherSide}_amount_sat ${n}.`
  }
  return ''
}

/** Message for an amount outside [min, max], all in display units. */
export function rangeMessage(side: 'from' | 'to', askedRaw: number, limit: LegLimit, other: LegInfo, withSatsHint = true): string {
  const leg = { ticker: limit.ticker, precision: limit.precision }
  const verb = side === 'from' ? 'sell' : 'receive'
  const asked = askedRaw / 10 ** limit.precision
  return `${limit.ticker} amount must be between ${formatAmount(limit.min, leg)} and ${formatAmount(limit.max, leg)} (you asked to ${verb} ${formatAmount(askedRaw, leg)}).` +
    (withSatsHint ? satsHint(side, asked, leg, other) : '')
}

/** Local check of the leg that carries the amount; returns an error message or undefined. */
export function checkLegAmount(side: 'from' | 'to', askedRaw: number, limit: LegLimit | undefined, other: LegInfo): string | undefined {
  if (!limit) return undefined
  if (askedRaw >= limit.min && askedRaw <= limit.max) return undefined
  return rangeMessage(side, askedRaw, limit, other)
}

const MAKER_RANGE = /\b(from|to)_amount must be between (\d+) and (\d+) but got (\d+)/

/**
 * Rewrite a maker "X_amount must be between <raw> and <raw> but got <raw>" error in display
 * units of the leg it names. Returns undefined when the message is not a range error.
 */
export function translateMakerRangeError(message: string, legs: { from: LegInfo; to: LegInfo }, withSatsHint = true): string | undefined {
  const m = MAKER_RANGE.exec(message)
  if (!m) return undefined
  const side = m[1] as 'from' | 'to'
  const leg = legs[side]
  const other = side === 'from' ? legs.to : legs.from
  return rangeMessage(side, Number(m[4]), { ...leg, min: Number(m[2]), max: Number(m[3]) }, other, withSatsHint)
}
