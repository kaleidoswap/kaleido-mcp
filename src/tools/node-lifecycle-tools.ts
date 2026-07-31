/**
 * Node lifecycle tools — local Docker signet/regtest environment management.
 *
 * Ported from kaleido-node-mcp (retired, superseded elsewhere by this server's
 * SDK-backed wallet/asset/channel/payment tools). This is the one slice of
 * kaleido-node-mcp that had no equivalent here: spinning Docker containers for
 * a named `kaleido` CLI environment up/down and managing wallet unlock state.
 * Shells out to the `kaleido` CLI (--json --agent) rather than the SDK, since
 * container lifecycle isn't something the SDK models.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import type { WdkMcpServer } from '@tetherto/wdk-mcp-toolkit'

const execFileAsync = promisify(execFile)

function findKaleido(): string {
  const fromEnv = process.env.KALEIDO_BIN
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const candidates = [
    `${process.env.HOME}/.local/bin/kaleido`,
    '/usr/local/bin/kaleido',
    '/opt/homebrew/bin/kaleido',
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }

  return 'kaleido' // fall back to PATH
}

const KALEIDO = findKaleido()
const NODE_URL = process.env.KALEIDO_NODE_URL
const API_URL = process.env.KALEIDO_API_URL
const ENV_NAME = process.env.KALEIDO_ENV_NAME

async function run(args: string[]): Promise<string> {
  const baseArgs = ['--json', '--agent']
  if (NODE_URL) baseArgs.push('--node-url', NODE_URL)
  if (API_URL) baseArgs.push('--api-url', API_URL)

  const fullArgs = [...baseArgs, ...args]

  try {
    const { stdout, stderr } = await execFileAsync(KALEIDO, fullArgs, {
      timeout: 30_000,
      env: { ...process.env, PATH: process.env.PATH ?? '' },
    })
    const out = stdout.trim()
    const err = stderr.trim()

    if (out) {
      try {
        JSON.parse(out)
        return out
      } catch {
        // not JSON — fall through
      }
    }

    return [out, err].filter(Boolean).join('\n')
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string }
    const detail = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n')
    throw new Error(`kaleido ${args.join(' ')}: ${detail}`)
  }
}

const t = (content: string) => ({ content: [{ type: 'text' as const, text: content }] })

export function registerNodeLifecycleTools(server: WdkMcpServer): void {
  server.tool('kaleido_node_list',
    'List all kaleido node environments and their node URLs. Shows which node is currently active.',
    {},
    async () => t(await run(['node', 'list'])))

  server.tool('kaleido_node_up',
    'Start Docker containers for a named node environment (docker compose up -d).',
    { name: z.string().optional().describe('Environment name. Omit to auto-detect if only one exists.') },
    async ({ name }: { name?: string }) => {
      const envName = name ?? ENV_NAME
      return t(await run(['node', 'up', ...(envName ? [envName] : [])]))
    })

  server.tool('kaleido_node_stop',
    'Stop running containers for a named environment (data is preserved).',
    { name: z.string().optional().describe('Environment name.') },
    async ({ name }: { name?: string }) => {
      const envName = name ?? ENV_NAME
      return t(await run(['node', 'stop', ...(envName ? [envName] : [])]))
    })

  server.tool('kaleido_node_down',
    'Stop and remove containers and networks for a named environment (volumes preserved).',
    { name: z.string().optional().describe('Environment name.') },
    async ({ name }: { name?: string }) => {
      const envName = name ?? ENV_NAME
      return t(await run(['node', 'down', ...(envName ? [envName] : [])]))
    })

  server.tool('kaleido_node_ps',
    'Show Docker container status for a named environment.',
    { name: z.string().optional().describe('Environment name.') },
    async ({ name }: { name?: string }) => {
      const envName = name ?? ENV_NAME
      return t(await run(['node', 'ps', ...(envName ? [envName] : [])]))
    })

  server.tool('kaleido_node_status',
    'Check RGB Lightning Node health — confirms the node is reachable and returns basic info.',
    {},
    async () => t(await run(['node', 'status'])))

  server.tool('kaleido_node_info',
    'Get detailed node and network information from the active RLN node.',
    {},
    async () => t(await run(['node', 'info'])))

  server.tool('kaleido_node_use',
    'Set the active node URL in kaleido config to point at a specific node in an environment.',
    {
      name: z.string().describe('Environment name.'),
      node: z.number().optional().describe('1-based node index (default: 1).'),
    },
    async ({ name, node }: { name: string; node?: number }) => {
      const args = ['node', 'use', name]
      if (node) args.push('--node', String(node))
      return t(await run(args))
    })

  server.tool('kaleido_node_init',
    'Initialize the RLN node wallet for the first time. Run once after first container start.',
    {
      password: z.string().describe('Wallet password to set.'),
      mnemonic: z.string().optional().describe('Optional BIP39 mnemonic to restore from.'),
    },
    async ({ password, mnemonic }: { password: string; mnemonic?: string }) => {
      const args = ['node', 'init', '--password', password]
      if (mnemonic) args.push('--mnemonic', mnemonic)
      return t(await run(args))
    })

  server.tool('kaleido_node_unlock',
    'Unlock the RLN node wallet after a restart. Uses default rgbtools.org signet services.',
    {
      password: z.string().describe('Wallet password.'),
      announce_alias: z.string().optional().describe('Optional Lightning peer alias to announce.'),
      announce_address: z.string().optional().describe('Optional public address for peer discovery (host:port).'),
    },
    async ({ password, announce_alias, announce_address }: { password: string; announce_alias?: string; announce_address?: string }) => {
      const args = ['node', 'unlock', '--password', password]
      if (announce_alias) args.push('--announce-alias', announce_alias)
      if (announce_address) args.push('--announce-address', announce_address)
      return t(await run(args))
    })

  server.tool('kaleido_node_lock',
    'Lock the RLN node wallet.',
    {},
    async () => t(await run(['node', 'lock'])))
}
