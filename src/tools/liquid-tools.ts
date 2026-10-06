/**
 * Liquid wallet tools — L-BTC and Liquid assets (e.g. USDt-Liquid) from an
 * in-process LWK wallet. Canonical `liquid_*` names mirror the focused
 * `wdk-wallet-liquid-mcp` server, which this module supersedes.
 */
import { z } from 'zod'
import type { WdkMcpServer } from '@tetherto/wdk-mcp-toolkit'
import type { LiquidAccount } from '@kaleidorg/wdk-wallet-liquid'

export function registerLiquidTools(server: WdkMcpServer, account: LiquidAccount): void {
  // -----------------------------------------------------------------------
  server.tool(
    'liquid_get_node_info',
    'Get the Liquid wallet network summary: network name, policy (L-BTC) asset id, current receive address, and the chain tip height. Call this first to confirm the wallet is reachable.',
    {},
    async () => t(JSON.stringify(await account.getNetworkInfo(), null, 2)),
  )

  // -----------------------------------------------------------------------
  server.tool(
    'liquid_get_address',
    'Get a Liquid confidential (CT) receive address for depositing L-BTC or Liquid assets.',
    {},
    async () => t(JSON.stringify({ address: await account.getAddress() }, null, 2)),
  )

  // -----------------------------------------------------------------------
  server.tool(
    'liquid_get_balance',
    'Get the spendable L-BTC balance of the Liquid wallet, in satoshis. Syncs with the chain before returning.',
    {},
    async () => t(JSON.stringify({ lbtc_balance_sats: (await account.getBalance()).toString() }, null, 2)),
  )

  // -----------------------------------------------------------------------
  server.tool(
    'liquid_get_asset_balance',
    'Get the balance of a specific Liquid asset (e.g. USDt-Liquid) by its asset id, in the asset smallest unit.',
    { asset_id: z.string().describe('Liquid asset id (64 hex characters)') },
    async ({ asset_id }: { asset_id: string }) =>
      t(JSON.stringify({ asset_id, balance: (await account.getTokenBalance(asset_id)).toString() }, null, 2)),
  )

  // -----------------------------------------------------------------------
  server.tool(
    'liquid_list_assets',
    'List every Liquid asset held by the wallet with its satoshi balance.',
    {},
    async () => t(JSON.stringify(await account.listAssets(), null, 2)),
  )

  // -----------------------------------------------------------------------
  server.tool(
    'liquid_list_transactions',
    'List the wallet transaction history (newest first): txid, type, fee, block height and timestamp.',
    {},
    async () => t(JSON.stringify(await account.listTransactions(), null, 2)),
  )

  // -----------------------------------------------------------------------
  server.tool(
    'liquid_list_unspents',
    'List the wallet unspent transaction outputs (UTXOs): txid, vout, asset id, value and confirmation height.',
    {},
    async () => t(JSON.stringify(await account.listUnspents(), null, 2)),
  )

  // -----------------------------------------------------------------------
  server.tool(
    'liquid_send_btc',
    'Send L-BTC on the Liquid network to a confidential address. Returns the broadcast txid and fee.',
    {
      recipient: z.string().describe('Liquid confidential (CT) destination address'),
      amount_sats: z.number().int().positive().describe('Amount to send, in satoshis'),
      fee_rate: z.number().positive().optional().describe('Fee rate in sat/vB (default: network minimum)'),
    },
    async ({ recipient, amount_sats, fee_rate }: { recipient: string; amount_sats: number; fee_rate?: number }) => {
      const result = await account.transfer({ recipient, amount: amount_sats, feeRate: fee_rate })
      return t(JSON.stringify({ txid: result.hash, fee_sats: result.fee.toString() }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  server.tool(
    'liquid_send_asset',
    'Send a non-L-BTC Liquid asset (e.g. USDt-Liquid) to a confidential address. Returns the broadcast txid and fee.',
    {
      asset_id: z.string().describe('Liquid asset id (64 hex characters)'),
      recipient: z.string().describe('Liquid confidential (CT) destination address'),
      amount: z.number().int().positive().describe('Amount to send, in the asset smallest unit'),
      fee_rate: z.number().positive().optional().describe('Fee rate in sat/vB (default: network minimum)'),
    },
    async ({ asset_id, recipient, amount, fee_rate }: { asset_id: string; recipient: string; amount: number; fee_rate?: number }) => {
      const result = await account.sendAsset({ assetId: asset_id, recipient, amount, feeRate: fee_rate })
      return t(JSON.stringify({ txid: result.hash, fee_sats: result.fee.toString() }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  server.tool(
    'liquid_get_fee_rates',
    'Get suggested Liquid fee rates in sat/vB. Liquid fees are low and stable — the network minimum is almost always sufficient.',
    {},
    async () => t(JSON.stringify({ normal_sat_vb: 1, fast_sat_vb: 1 }, null, 2)),
  )
}

const t = (content: string) => ({ content: [{ type: 'text' as const, text: content }] })
