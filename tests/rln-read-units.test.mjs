import test from 'node:test'
import assert from 'node:assert/strict'
import { registerRlnTools } from '../dist/tools/rln-tools.js'
const definitions = new Map()
registerRlnTools({ tool(name, description, schema, handler) { definitions.set(name, { schema, handler }) } }, {
  async listAssets(schemas) { assert.equal(schemas.length, 3); return { nia: [] } },
  async listChannels() { return { channels: [{ is_usable: true, outbound_balance_msat: 15500000, inbound_balance_msat: 81840000 }] } }
})
test('RGB schemas accept supported case variants but reject unknown types', async () => {
  const { schema, handler } = definitions.get('rln_list_assets')
  const schemas = schema.schemas.parse(['NIA', 'uda', 'Cfa'])
  assert.deepEqual(schemas, ['Nia', 'Uda', 'Cfa'])
  assert.equal(schema.schemas.safeParse(['wrong']).success, false)
  await handler({ schemas })
})
test('channel tools provide explicit satoshi totals', async () => {
  const result = await definitions.get('rln_list_channels').handler({})
  const data = JSON.parse(result.content[0].text)
  assert.equal(data.total_outbound_sat, 15500)
  assert.equal(data.total_inbound_sat, 81840)
})

test('swap status always supplies the required taker flag, preserving explicit maker queries', async () => {
  const calls = []
  const defs = new Map()
  registerRlnTools({ tool(name, _description, _schema, handler) { defs.set(name, handler) } }, {
    async getSwap(request) { calls.push(request); return { swap: { status: 'Succeeded' } } }
  })
  await defs.get('rln_get_swap')({ payment_hash: 'test-hash' })
  await defs.get('wdk_get_swap')({ payment_hash: 'test-hash', taker: false })
  assert.deepEqual(calls, [{ payment_hash: 'test-hash', taker: true }, { payment_hash: 'test-hash', taker: false }])
})
