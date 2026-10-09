/**
 * KaleidoSwap submarine swaps on the Boltz /v2-shaped maker (kaleidoswap-maker-rs),
 * through @kaleidorg/swap-sdk: pay a Lightning invoice from Liquid funds.
 *
 *   kaleidoswap_submarine_pairs   — what can be swapped into a Lightning payment, limits, fees
 *   kaleidoswap_submarine_create  — open a swap for an invoice; no funds move yet
 *   kaleidoswap_submarine_fund    — SPEND: lock the exact amount the maker asked for
 *   kaleidoswap_submarine_status  — follow the swap until the invoice is paid
 *
 * The model never sees a key: the per-swap refund key is derived from the wallet
 * mnemonic (BIP85, swap-sdk `SwapMasterKey`) and the swap record — index, maker URL,
 * create response — is persisted before anything can be funded, so a refund stays
 * possible from the mnemonic plus that file. `fund` reads amount, asset and address
 * from the persisted record only; the model passes nothing but the swap id.
 *
 * @kaleidorg/swap-sdk is an optional peer (it needs Node >= 22): it is imported on
 * first use, so the tools register on any runtime and report how to install it.
 */
import { mkdir, readFile, readdir, open, access } from 'node:fs/promises'
import { atomicWrite, reserveFunding, syncDirectory } from './swap-storage.js'
import { join } from 'node:path'
import { z } from 'zod'
import type { WdkMcpServer } from '@tetherto/wdk-mcp-toolkit'
import type { LiquidAccount } from '@kaleidorg/wdk-wallet-liquid'

export interface SubmarineToolsConfig {
  /** swap-sdk network: the maker's chain. Only signet and regtest have a maker today. */
  network: 'signet' | 'regtest' | 'mainnet'
  /** Maker /v2 base URL override (default: the SDK's preset for `network`). */
  makerUrl?: string
  /** Wallet mnemonic the swap keys are derived from. */
  mnemonic?: string
  /** Directory where swap records are persisted. */
  stateDir: string
  /** Liquid wallet that funds L-USDT / L-BTC lockups. */
  liquid?: LiquidAccount
}

/** Assets a submarine swap can be paid from, as the maker names them on the wire. */
const FROM_ASSETS = ['L-USDT', 'L-BTC', 'BTC'] as const
type FromAsset = typeof FROM_ASSETS[number]

/** Statuses after which a swap will not progress; the lockup may need a refund. */
const FAILED = new Set(['invoice.failedToPay', 'transaction.lockupFailed', 'swap.expired', 'transaction.failed'])

interface SwapRecord {
  id: string
  index: string
  from: FromAsset
  invoice: string
  network: string
  makerUrl: string
  createdAt: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any
  fromAssetId?: string
  fundingTxid?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SwapSdk = any

export function registerSubmarineTools(server: WdkMcpServer, config: SubmarineToolsConfig): void {
  let sdkPromise: Promise<SwapSdk> | null = null

  async function sdk(): Promise<SwapSdk> {
    sdkPromise ??= (async () => {
      const mod = await import('@kaleidorg/swap-sdk')
      await mod.init()
      return mod
    })().catch(error => {
      sdkPromise = null
      const e = error as { code?: string, message?: string }
      if (e?.code === 'ERR_MODULE_NOT_FOUND' || e?.message?.includes('@kaleidorg/swap-sdk')) {
        throw new Error('@kaleidorg/swap-sdk is not installed (it needs Node >= 22). Install it next to kaleido-mcp: npm i @kaleidorg/swap-sdk')
      }
      throw error
    })
    return sdkPromise
  }

  async function client(): Promise<SwapSdk> {
    const m = await sdk()
    if (config.makerUrl) return new m.SwapClient(config.makerUrl)
    if (config.network === 'mainnet') {
      throw new Error('There is no KaleidoSwap /v2 maker on mainnet yet; set KALEIDOSWAP_MAKER_URL to use one.')
    }
    return m.SwapClient.forNetwork(config.network)
  }

  function makerUrl(): string {
    return config.makerUrl ?? (config.network === 'signet' ? 'https://maker.signet.kaleidoswap.com/v2' : 'http://localhost:9001/v2')
  }

  // ── persistence ───────────────────────────────────────────────────────
  const recordPath = (id: string) => join(config.stateDir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)

  async function save(record: SwapRecord): Promise<void> {
    const m = await sdk()
    // toJson, not JSON.stringify: the SDK response carries bigint amounts.
    await atomicWrite(recordPath(record.id), m.toJson(record, 2))
  }

  async function load(id: string): Promise<SwapRecord> {
    try {
      const record = JSON.parse(await readFile(recordPath(id), 'utf8')) as SwapRecord
      if (record.id !== id) throw new Error('Swap id mismatch')
      return record
    } catch {
      throw new Error(`No submarine swap "${id}" was created by this server (looked in ${config.stateDir}).`)
    }
  }

  /** Next unused key index: one past the highest persisted, so keys are never reused. */
  async function nextIndex(): Promise<bigint> {
    let max = -1n
    for (const file of await readdir(config.stateDir).catch(() => [] as string[])) {
      if (!file.endsWith('.json')) continue
      try {
        const rec = JSON.parse(await readFile(join(config.stateDir, file), 'utf8')) as SwapRecord
        if (BigInt(rec.index) > max) max = BigInt(rec.index)
      } catch { /* not a swap record */ }
    }
    // Exclusive reservations also cover in-flight creates and failed creates.
    // Keep them permanently so a restart cannot reuse a refund key.
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 })
    for (let index = max + 1n; ; index++) {
      try {
        const reservation = await open(join(config.stateDir, `key-${index}.reserved`), 'wx', 0o600)
        try { await reservation.sync() } finally { await reservation.close() }
        await syncDirectory(config.stateDir)
        return index
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
  }

  // ── tools ─────────────────────────────────────────────────────────────
  server.tool(
    'kaleidoswap_submarine_pairs',
    'List what can pay a Lightning invoice through a KaleidoSwap submarine swap (e.g. L-USDT on Liquid → BTC on Lightning): source asset, rate, min/max lock amount (source asset smallest unit) and fees. Read-only.',
    {},
    async () => {
      try {
        const pairs = await (await client()).submarinePairs()
        const m = await sdk()
        const rows = Object.entries(JSON.parse(m.toJson(pairs)) as Record<string, Record<string, Record<string, unknown>>>)
          .flatMap(([from, tos]) => Object.entries(tos).map(([to, card]) => ({
            from,
            to,
            rate: card.rate,
            limits: card.limits,
            fees: card.fees,
            ...(card.fromAssetId ? { from_asset_id: card.fromAssetId } : {}),
          })))
        return t(JSON.stringify({ maker: makerUrl(), pairs: rows }, null, 2))
      } catch (error) {
        return fail(String((error as Error).message ?? error))
      }
    },
  )

  server.tool(
    'kaleidoswap_submarine_create',
    'Open a submarine swap that pays a Lightning (BOLT11) invoice from Liquid funds. No funds move: it returns the exact amount to lock and the swap id. Then call kaleidoswap_submarine_fund with that id (needs user confirmation) and follow kaleidoswap_submarine_status.',
    {
      invoice: z.string().min(10).describe('BOLT11 Lightning invoice to pay (lnbc…/lntb…/lntbs…/lnbcrt…), with an amount'),
      from_asset: z.enum(FROM_ASSETS).optional().describe('Asset to pay with (default L-USDT)'),
    },
    async ({ invoice, from_asset = 'L-USDT' }: { invoice: string, from_asset?: FromAsset }) => {
      try {
        if (!config.mnemonic) return fail('No wallet mnemonic configured (LIQUID_MNEMONIC or WDK_SEED): swap keys cannot be derived.')
        const m = await sdk()
        const api = await client()
        const pairs = await api.submarinePairs()
        const card = pairs?.[from_asset]?.BTC
        if (!card) return fail(`The maker does not offer ${from_asset} → BTC (Lightning) submarine swaps.`)

        const index = await nextIndex()
        const key = m.SwapMasterKey.fromWalletMnemonic(config.mnemonic, config.network).deriveSwapKey(index)
        // createSubmarineSwap validates the response (invoice hash, refund key, lockup
        // tree, Liquid asset ids) against the pair card before returning it.
        const response = await api.createSubmarineSwap(config.network, {
          from: from_asset,
          to: 'BTC',
          invoice,
          refundPublicKey: key.publicKey,
          pairHash: card.hash,
        })
        // Re-derive the lockup against our own refund key: a tree we could not
        // refund must fail here, before anything is funded.
        m.SwapScript.fromSubmarine(from_asset === 'BTC' ? 'bitcoin' : 'liquid', config.network, response, key.publicKey)

        const record: SwapRecord = {
          id: response.id,
          index: index.toString(),
          from: from_asset,
          invoice,
          network: config.network,
          makerUrl: makerUrl(),
          createdAt: new Date().toISOString(),
          response,
          ...(card.fromAssetId ? { fromAssetId: card.fromAssetId } : {}),
        }
        await save(record)

        return t(JSON.stringify({
          swap_id: response.id,
          from_asset,
          ...(card.fromAssetId ? { asset_id: card.fromAssetId } : {}),
          expected_amount: String(response.expectedAmount),
          lockup_address: response.address,
          timeout_block_height: response.timeoutBlockHeight,
          fees: card.fees,
          next: 'Ask the user to confirm, then call kaleidoswap_submarine_fund with this swap_id.',
        }, null, 2))
      } catch (error) {
        return fail(String((error as Error).message ?? error))
      }
    },
  )

  server.tool(
    'kaleidoswap_submarine_fund',
    'SPEND (confirm with the user first): lock the funds for a submarine swap created by kaleidoswap_submarine_create, from the Liquid wallet. Amount, asset and lockup address come from the stored swap — only the swap id is accepted. The maker then pays the invoice.',
    { swap_id: z.string().min(1).describe('Swap id returned by kaleidoswap_submarine_create') },
    async ({ swap_id }: { swap_id: string }) => {
      try {
        const record = await load(swap_id)
        if (record.fundingTxid) return fail(`Swap ${swap_id} is already funded (txid ${record.fundingTxid}).`)
        if (record.from === 'BTC') return fail('On-chain BTC submarine swaps are not funded by this server (no on-chain BTC wallet); use L-USDT or L-BTC.')
        if (!config.liquid) return fail('No Liquid wallet configured (LIQUID_MNEMONIC or WDK_SEED): cannot fund the lockup.')

        if (record.network !== config.network || record.makerUrl !== makerUrl()) {
          return fail('Swap network or maker differs from this server configuration; restore the original configuration before funding.')
        }
        const { status } = await (await client()).swap(swap_id)
        if (status !== 'swap.created' && status !== 'invoice.set') {
          return fail(`Swap ${swap_id} is in status "${status}" and can no longer be funded.`)
        }

        const amount = BigInt(String(record.response.expectedAmount))
        const recipient = String(record.response.address)
        await reserveFunding(`${recordPath(swap_id)}.funding`)
        const result = record.from === 'L-USDT'
          ? await config.liquid.sendAsset({ assetId: String(record.fromAssetId), recipient, amount })
          : await config.liquid.transfer({ recipient, amount })

        record.fundingTxid = result.hash
        await save(record)
        return t(JSON.stringify({
          funded: true,
          swap_id,
          asset: record.from,
          amount: amount.toString(),
          txid: result.hash,
          fee_sats: result.fee.toString(),
          next: 'The maker pays the invoice once the lockup is seen; follow kaleidoswap_submarine_status.',
        }, null, 2))
      } catch (error) {
        return fail(String((error as Error).message ?? error))
      }
    },
  )

  server.tool(
    'kaleidoswap_submarine_status',
    'Status of a submarine swap: "transaction.claimed" means the invoice was paid and the swap is complete. A failed swap whose lockup was funded must be refunded with the stored swap record.',
    { swap_id: z.string().min(1).describe('Swap id returned by kaleidoswap_submarine_create') },
    async ({ swap_id }: { swap_id: string }) => {
      try {
        const record = await load(swap_id).catch(() => undefined)
        if (record && (record.network !== config.network || record.makerUrl !== makerUrl())) {
          return fail('Swap network or maker differs from this server configuration; restore the original configuration to query it.')
        }
        const attempted = record ? await access(`${recordPath(swap_id)}.funding`).then(() => true, () => false) : false
        const s = await (await client()).swap(swap_id)
        const status = String(s.status)
        const failed = FAILED.has(status)
        return t(JSON.stringify({
          swap_id,
          status,
          done: status === 'transaction.claimed',
          failed,
          ...(s.failureReason ? { failure_reason: s.failureReason } : {}),
          ...(record ? {
            funded: record.fundingTxid ? true : attempted ? null : false,
            funding_txid: record.fundingTxid ?? null,
            funding_attempted: attempted || !!record.fundingTxid,
            recovery_required: attempted && !record.fundingTxid,
            ...(attempted && !record.fundingTxid ? { recovery: 'A broadcast was attempted but its result is unknown. Reconcile wallet transactions and maker status before taking further action; do not retry funding automatically.' } : {}),
          } : {}),
          ...(failed && record?.fundingTxid
            ? { refund: `Funds are locked until refunded. The refund key derives from the wallet mnemonic at swap index ${record.index}; the swap record is ${recordPath(swap_id)}.` }
            : {}),
        }, null, 2))
      } catch (error) {
        return fail(String((error as Error).message ?? error))
      }
    },
  )
}

const t = (content: string) => ({ content: [{ type: 'text' as const, text: content }] })
const fail = (message: string) => ({ ...t(JSON.stringify({ error: message }, null, 2)), isError: true })
