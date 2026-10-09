import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicWrite, reserveFunding } from '../dist/tools/swap-storage.js'

test('only one concurrent funding attempt succeeds, including after reopening storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-funding-'))
  const marker = join(dir, 'swap.json.funding')
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => reserveFunding(marker)))
    assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1)
    assert.equal(attempts.filter(a => a.status === 'rejected').length, 9)
    assert.ok(JSON.parse(await readFile(marker, 'utf8')).startedAt)
    await assert.rejects(reserveFunding(marker), /previous broadcast may have succeeded/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('atomic writes publish complete records and leave no temporary files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-record-'))
  try {
    const path = join(dir, 'swap.json')
    await atomicWrite(path, JSON.stringify({ funded: false }))
    await atomicWrite(path, JSON.stringify({ funded: true, txid: 'abc' }))
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { funded: true, txid: 'abc' })
    assert.deepEqual(await readdir(dir), ['swap.json'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
