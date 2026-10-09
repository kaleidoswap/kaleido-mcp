import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerSubmarineTools } from '../dist/tools/submarine-tools.js'

const supported = Number(process.versions.node.split('.')[0]) >= 22
for (const ambiguous of [false, true]) {
  test(`submarine funding is exclusive and persistent (ambiguous=${ambiguous})`, { skip: !supported }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-fund-test-'))
    const maker = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'swap.created' }))
    })
    await new Promise(resolve => maker.listen(0, '127.0.0.1', resolve))
    const makerUrl = `http://127.0.0.1:${maker.address().port}/v2`
    let sends = 0
    const config = { network: 'signet', makerUrl, stateDir: dir, liquid: {
      async transfer() {
        sends++
        if (ambiguous) throw new Error('broadcast timed out')
        return { hash: 'test-txid', fee: 1n }
      },
    } }
    const makeHandlers = () => {
      const handlers = new Map()
      registerSubmarineTools({ tool(name, ...args) { handlers.set(name, args.at(-1)) } }, config)
      return handlers
    }
    const parse = r => JSON.parse(r.content[0].text)
    try {
      await writeFile(join(dir, 'test.json'), JSON.stringify({ id: 'test', index: '0', from: 'L-BTC', invoice: 'test', network: 'signet', makerUrl, response: { expectedAmount: '100', address: 'test-address' } }))
      const handlers = makeHandlers()
      const results = await Promise.all(Array.from({ length: 5 }, () => handlers.get('kaleidoswap_submarine_fund')({ swap_id: 'test' })))
      assert.equal(sends, 1, JSON.stringify(results))
      assert.equal(results.filter(r => !r.isError).length, ambiguous ? 0 : 1)
      const reopened = makeHandlers()
      const repeated = await reopened.get('kaleidoswap_submarine_fund')({ swap_id: 'test' })
      assert.equal(repeated.isError, true)
      assert.equal(sends, 1)
      const status = parse(await reopened.get('kaleidoswap_submarine_status')({ swap_id: 'test' }))
      assert.equal(status.funded, ambiguous ? null : true)
      assert.equal(status.recovery_required, ambiguous)
      if (!ambiguous) assert.equal(JSON.parse(await readFile(join(dir, 'test.json'), 'utf8')).fundingTxid, 'test-txid')
    } finally {
      await new Promise(resolve => maker.close(resolve))
      await rm(dir, { recursive: true, force: true })
    }
  })
}
