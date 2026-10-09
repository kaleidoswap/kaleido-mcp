import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Persist before broadcasting, with a complete file visible to readers. */
export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(content); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export async function syncDirectory(path: string): Promise<void> {
  // Directory handles are not supported on Windows. File fsync still applies.
  if (process.platform === 'win32') return
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

/** An attempt remains reserved even after an ambiguous error or process crash.
 * Never automatically delete it: the broadcast may already have succeeded. */
export async function reserveFunding(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  let file
  try { file = await open(path, 'wx', 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Funding was already attempted. Reconcile the wallet and maker before retrying; the previous broadcast may have succeeded.')
    }
    throw error
  }
  try { await file.writeFile(JSON.stringify({ startedAt: new Date().toISOString() })); await file.sync() }
  finally { await file.close() }
  await syncDirectory(dirname(path))
}
