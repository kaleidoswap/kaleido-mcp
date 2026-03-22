/**
 * Market data client — CoinGecko free tier + alternative.me Fear&Greed.
 * Ported from mpp-gateway-mcp/src/market-client.ts.
 */

const COINGECKO = 'https://api.coingecko.com/api/v3'
const COIN_IDS: Record<string, string> = {
  BTC: 'bitcoin', USDT: 'tether', XAUT: 'tether-gold', ETH: 'ethereum',
}

export interface PriceResult {
  asset: string; vs_currency: string; price: number
  change_24h_pct: number | null; market_cap_usd: number | null
  volume_24h_usd: number | null; last_updated: string
}

export interface OhlcvCandle { timestamp: number; open: number; high: number; low: number; close: number }
export interface SentimentResult { index_value: number; classification: string; timestamp: string }

export class MarketClient {
  async getPrice(asset: string, vsCurrency = 'usd'): Promise<PriceResult> {
    const id = this.coinId(asset)
    const data = await this.fetch<Record<string, Record<string, number>>>(
      `${COINGECKO}/simple/price?ids=${id}&vs_currencies=${vsCurrency}&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true`
    )
    const e = data[id]
    if (!e) throw new Error(`No price data for ${asset}`)
    return {
      asset: asset.toUpperCase(), vs_currency: vsCurrency.toUpperCase(),
      price: e[vsCurrency] ?? 0,
      change_24h_pct: e[`${vsCurrency}_24h_change`] ?? null,
      market_cap_usd: e[`${vsCurrency}_market_cap`] ?? null,
      volume_24h_usd: e[`${vsCurrency}_24h_vol`] ?? null,
      last_updated: new Date((e['last_updated_at'] ?? 0) * 1000).toISOString(),
    }
  }

  async getMarketData(assets: string[]): Promise<PriceResult[]> {
    const ids = assets.map(a => this.coinId(a)).join(',')
    const data = await this.fetch<Record<string, Record<string, number>>>(
      `${COINGECKO}/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true`
    )
    return assets.map(asset => {
      const e = data[this.coinId(asset)] ?? {}
      return {
        asset: asset.toUpperCase(), vs_currency: 'USD',
        price: e['usd'] ?? 0,
        change_24h_pct: e['usd_24h_change'] ?? null,
        market_cap_usd: e['usd_market_cap'] ?? null,
        volume_24h_usd: e['usd_24h_vol'] ?? null,
        last_updated: new Date((e['last_updated_at'] ?? 0) * 1000).toISOString(),
      }
    })
  }

  async getOhlcv(asset: string, days: number): Promise<OhlcvCandle[]> {
    const id = this.coinId(asset)
    const raw = await this.fetch<number[][]>(`${COINGECKO}/coins/${id}/ohlc?vs_currency=usd&days=${days}`)
    return raw.map(([ts, o, h, l, c]) => ({ timestamp: ts, open: o, high: h, low: l, close: c }))
  }

  async getFearGreedIndex(): Promise<SentimentResult> {
    const data = await this.fetch<{ data: Array<{ value: string; value_classification: string; timestamp: string }> }>(
      'https://api.alternative.me/fng/?limit=1'
    )
    const e = data.data?.[0]
    if (!e) throw new Error('No fear/greed data')
    return {
      index_value: parseInt(e.value, 10),
      classification: e.value_classification,
      timestamp: new Date(parseInt(e.timestamp, 10) * 1000).toISOString(),
    }
  }

  private coinId(asset: string): string {
    const id = COIN_IDS[asset.toUpperCase()]
    if (!id) throw new Error(`Unknown asset: ${asset}. Supported: ${Object.keys(COIN_IDS).join(', ')}`)
    return id
  }

  private async fetch<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) {
      if (res.status === 429) throw new Error('Market data rate limit (HTTP 429). Wait 30s.')
      throw new Error(`Market data failed: HTTP ${res.status}`)
    }
    return res.json() as Promise<T>
  }
}
