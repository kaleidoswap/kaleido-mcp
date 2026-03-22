/**
 * Market data tools — CoinGecko prices, OHLCV, Fear & Greed sentiment.
 * Note: WDK PRICING_TOOLS (Bitfinex) are registered separately via registerTools().
 * These are additional CoinGecko-sourced tools with extra metadata.
 */
import { z } from 'zod'
import type { WdkMcpServer } from '@tetherto/wdk-mcp-toolkit'
import { MarketClient } from '../clients/market-client.js'

export function registerMarketTools(server: WdkMcpServer): void {
  const market = new MarketClient()
  const registerAliases = (
    names: string[],
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: any,
  ) => {
    for (const name of names) server.tool(name, description, schema, handler)
  }

  // -----------------------------------------------------------------------
  registerAliases(['l402_get_price', 'get_price'],
    'Get current spot price and 24h stats for an asset (BTC, USDT, XAUT, ETH) in USD or other currency. Use before placing swaps to know the market rate.',
    {
      asset: z.enum(['BTC', 'USDT', 'XAUT', 'ETH']),
      vs_currency: z.enum(['usd', 'eur', 'btc', 'sats']).optional().describe('Quote currency (default: usd)'),
    },
    async ({ asset, vs_currency = 'usd' }: { asset: 'BTC' | 'USDT' | 'XAUT' | 'ETH'; vs_currency?: 'usd' | 'eur' | 'btc' | 'sats' }) => {
      const queryCurrency = vs_currency === 'sats' ? 'btc' : vs_currency
      const result = await market.getPrice(asset, queryCurrency)
      if (vs_currency === 'sats' && result.price) { result.price = Math.round(result.price * 1e8); result.vs_currency = 'SATS' }
      return t(JSON.stringify(result, null, 2))
    })

  // -----------------------------------------------------------------------
  registerAliases(['l402_get_market_data', 'get_market_data'],
    'Get spot prices and 24h stats for multiple assets in one call.',
    { assets: z.array(z.enum(['BTC', 'USDT', 'XAUT', 'ETH'])).min(1).max(4) },
    async ({ assets }: { assets: Array<'BTC' | 'USDT' | 'XAUT' | 'ETH'> }) => t(JSON.stringify(await market.getMarketData(assets), null, 2)))

  // -----------------------------------------------------------------------
  registerAliases(['l402_get_ohlcv', 'get_ohlcv'],
    'Get OHLCV candle data for an asset over the last N days. Use to detect price trends.',
    {
      asset: z.enum(['BTC', 'USDT', 'XAUT', 'ETH']),
      days: z.number().int().min(1).max(90).optional().describe('Days of candles (default: 1, max: 90)'),
    },
    async ({ asset, days = 1 }: { asset: 'BTC' | 'USDT' | 'XAUT' | 'ETH'; days?: number }) => {
      const candles = await market.getOhlcv(asset, days)
      const latest = candles[candles.length - 1], oldest = candles[0]
      const pctChange = oldest && latest ? (((latest.close - oldest.open) / oldest.open) * 100).toFixed(2) : null
      return t(JSON.stringify({ asset, days, candle_count: candles.length, period_change_pct: pctChange ? parseFloat(pctChange) : null, latest_close: latest?.close ?? null, candles: candles.slice(-20) }, null, 2))
    })

  // -----------------------------------------------------------------------
  registerAliases(['l402_get_sentiment', 'get_sentiment'],
    'Get the Crypto Fear & Greed Index (0–100). Below 25 = extreme fear (buy signal). Above 75 = extreme greed (sell signal). Use as directional signal when deciding swap direction.',
    {},
    async () => {
      const sentiment = await market.getFearGreedIndex()
      const signal = sentiment.index_value < 25 ? 'STRONG_BUY' : sentiment.index_value < 40 ? 'BUY' : sentiment.index_value > 75 ? 'STRONG_SELL' : sentiment.index_value > 60 ? 'SELL' : 'NEUTRAL'
      return t(JSON.stringify({ ...sentiment, trading_signal: signal }, null, 2))
    })
}

const t = (content: string) => ({ content: [{ type: 'text' as const, text: content }] })
