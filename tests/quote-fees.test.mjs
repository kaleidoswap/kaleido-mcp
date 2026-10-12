import test from 'node:test'
import assert from 'node:assert/strict'
import { registerKaleidoswapTools } from '../dist/tools/kaleidoswap-tools.js'

test('quotes expose the variable fee when the base fee is zero', async () => {
  const tools = new Map()
  const btc = { ticker: 'BTC', asset_id: 'BTC', precision: 11, protocol_ids: { BTC: 'BTC' } }
  const usdt = { ticker: 'USDT', asset_id: 'rgb:test', precision: 6, protocol_ids: { RGB: 'rgb:test' } }
  const fee = { base_fee: 0, variable_fee: 10101, final_fee: 10101, fee_rate: 0.01, fee_asset: 'rgb:test', fee_asset_precision: 6 }
  registerKaleidoswapTools({ tool(name, _description, _schema, handler) { tools.set(name, handler) } }, {
    async listAssets() { return { assets: [btc, usdt] } },
    async listPairs() { return { pairs: [] } },
    toRaw(amount, precision) { return Math.round(amount * 10 ** precision) },
    toDisplay(amount, precision) { return amount / 10 ** precision },
    async getQuote() { return { rfq_id: 'quote', from_asset: { ...btc, amount: 1231000, layer: 'BTC_LN' }, to_asset: { ...usdt, amount: 1000000, layer: 'RGB_LN' }, fee, expires_at: 1791835247 } }
  })
  const result = await tools.get('kaleidoswap_get_quote')({ from_asset_id: 'BTC', to_asset_id: 'USDT', to_amount: 1 })
  const quote = JSON.parse(result.content[0].text)
  assert.equal(quote.fee_base, 0)
  assert.equal(quote.fee_display, '0.010101 USDT')
  assert.deepEqual(quote.fee, fee)
  assert.equal(quote.from_asset.amount_raw, 1231000)
  assert.equal(quote.to_asset.amount_raw, 1000000)
})
