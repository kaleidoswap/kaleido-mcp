/**
 * RLN (RGB Lightning Node) tools — Lightning channels, RGB assets, atomic swaps.
 * These are custom tools that go beyond what WDK built-in WALLET_TOOLS provide,
 * while using the SDK-backed RLN node client (not a WDK WalletManager).
 *
 * Canonical names mirror the focused `wdk-wallet-rln-mcp` server.
 * Legacy `rln_*` aliases are kept temporarily for compatibility.
 */
import { z } from 'zod'
import type { WdkMcpServer } from '@tetherto/wdk-mcp-toolkit'
import { AssetSchema, type RlnClient } from 'kaleido-sdk/rln'
import type { CloseChannelRequest } from 'kaleido-sdk/rln'

const toFungibleAssignment = (
  value: number,
): NonNullable<Parameters<RlnClient['createRgbInvoice']>[0]['assignment']> => (
  { type: 'Fungible' as never, value }
)

export function registerRlnTools(server: WdkMcpServer, rln: RlnClient): void {
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
  registerAliases(
    ['wdk_get_node_info', 'rln_get_node_info'],
    'Get RLN node identity: pubkey, channel count, Lightning balance, peers. Call first to confirm node is reachable.',
    {},
    async () => {
      const info = await rln.getNodeInfo()
      return t(JSON.stringify(info, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_get_balances', 'rln_get_balances'],
    'Get RLN wallet balances: BTC on-chain (vanilla/colored UTXOs) and Lightning balance. For RGB asset balances use wdk_get_asset_balance.',
    { skip_sync: z.boolean().optional().describe('Skip blockchain sync for faster response (default: false)') },
    async ({ skip_sync = false }: { skip_sync?: boolean }) => {
      const [btc, node] = await Promise.all([rln.getBtcBalance(skip_sync), rln.getNodeInfo()])
      return t(JSON.stringify({
        btc_onchain: {
          vanilla_spendable_sats: btc.vanilla?.spendable ?? 0,
          vanilla_settled_sats: btc.vanilla?.settled ?? 0,
          colored_spendable_sats: btc.colored?.spendable ?? 0,
          colored_settled_sats: btc.colored?.settled ?? 0,
        },
        lightning_balance_sat: node.local_balance_sat ?? 0,
      }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_get_asset_balance', 'rln_get_asset_balance'],
    'Get balance of a specific RGB asset (USDT, XAUT) by asset_id. Returns settled, future, spendable, and off-chain amounts.',
    { asset_id: z.string().describe("RGB asset ID e.g. 'rgb:2JEUOrsc-...'") },
    async ({ asset_id }: { asset_id: string }) =>
      t(JSON.stringify({ asset_id, ...(await rln.getAssetBalance({ asset_id })) }, null, 2)),
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_list_assets', 'rln_list_assets'],
    'List all RGB assets held by the RLN node (NIA, UDA, CFA schemas). Returns asset_id, ticker, name, precision.',
    { schemas: z.array(z.enum(['Nia', 'Uda', 'Cfa'])).optional() },
    async ({ schemas = [] }: { schemas?: Array<'Nia' | 'Uda' | 'Cfa'> }) => {
      const assets = await rln.listAssets(schemas.map(schema => AssetSchema[schema]))
      const all = [
        ...(assets.nia ?? []).map(a => ({ ...a, schema: 'Nia' })),
        ...(assets.uda ?? []).map(a => ({ ...a, schema: 'Uda' })),
        ...(assets.cfa ?? []).map(a => ({ ...a, schema: 'Cfa' })),
      ]
      return t(JSON.stringify(all, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_get_address', 'rln_get_address'],
    'Get RLN node on-chain BTC address for receiving Bitcoin deposits.',
    {},
    async () => t(JSON.stringify(await rln.getAddress(), null, 2)),
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_create_rgb_invoice', 'rln_create_rgb_invoice'],
    'Create an RGB invoice to receive an RGB asset (USDT, XAUT). Pass the invoice as receiver_address with format=RGB_INVOICE when calling kaleidoswap_place_order.',
    {
      asset_id: z.string().optional().describe('RGB asset ID. Omit for any asset.'),
      amount: z.number().positive().optional().describe('Expected amount in display units (e.g. 65.5 for 65.5 USDT)'),
      duration_seconds: z.number().int().positive().optional().describe('Invoice expiry (default: 86400 = 24h)'),
    },
    async ({ asset_id, amount, duration_seconds }: { asset_id?: string; amount?: number; duration_seconds?: number }) => {
      const invoice = await rln.createRgbInvoice({
        ...(asset_id ? { asset_id } : {}),
        ...(amount !== undefined ? { assignment: toFungibleAssignment(amount) } : {}),
        duration_seconds: duration_seconds ?? 86400,
        min_confirmations: 1,
        witness: false,
      })
      return t(JSON.stringify({
        invoice: invoice.invoice,
        recipient_id: invoice.recipient_id,
        expires_at: invoice.expiration_timestamp ? new Date(invoice.expiration_timestamp * 1000).toISOString() : null,
        usage: 'Pass invoice as receiver_address with receiver_address_format="RGB_INVOICE"',
      }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_create_ln_invoice', 'rln_create_ln_invoice'],
    'Create a BOLT11 Lightning invoice to receive BTC via Lightning Network into the RLN node.',
    {
      amount_msat: z.number().int().positive().optional().describe('Amount in millisatoshis. Omit for any-amount.'),
      description: z.string().optional(),
      expiry_sec: z.number().int().positive().optional().describe('Expiry in seconds (default: 3600)'),
    },
    async ({ amount_msat, description, expiry_sec }: { amount_msat?: number; description?: string; expiry_sec?: number }) =>
      t(JSON.stringify(await rln.createLNInvoice({
        amt_msat: amount_msat,
        expiry_sec: expiry_sec ?? 3600,
      }), null, 2)),
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_pay_invoice', 'rln_pay_invoice'],
    'Pay a BOLT11 Lightning invoice from the RLN node. Use to fund KaleidoSwap deposit after placing a REST swap order.',
    { invoice: z.string().describe('BOLT11 invoice string (lnbc... or lntb...)') },
    async ({ invoice }: { invoice: string }) => t(JSON.stringify(await rln.sendPayment({ invoice }), null, 2)),
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_send_btc', 'rln_send_btc'],
    'Send BTC on-chain from the RLN node.',
    {
      address: z.string().describe('Destination Bitcoin address'),
      amount_sat: z.number().int().positive().describe('Amount in satoshis'),
      fee_rate: z.number().positive().optional().describe('Fee rate in sat/vbyte (default: 3)'),
    },
    async ({ address, amount_sat, fee_rate = 3 }: { address: string; amount_sat: number; fee_rate?: number }) => {
      await rln.sendBtc({ address, amount: amount_sat, fee_rate, skip_sync: false })
      return t(JSON.stringify({ sent: true, address, amount_sat, fee_rate }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_send_asset', 'rln_send_asset'],
    'Send an RGB asset (USDT/XAUT) on-chain. Pass deposit_address.address from a KaleidoSwap RGB_INVOICE order as recipient_id.',
    {
      asset_id: z.string().describe('RGB asset ID'),
      recipient_id: z.string().describe('Recipient identifier from an RGB invoice'),
      amount: z.number().positive().describe('Amount in display units (e.g. 65.5 for USDT)'),
      transport_endpoints: z.array(z.string()).optional(),
      fee_rate: z.number().positive().optional(),
    },
    async ({
      asset_id,
      recipient_id,
      amount,
      transport_endpoints,
      fee_rate,
    }: {
      asset_id: string
      recipient_id: string
      amount: number
      transport_endpoints?: string[]
      fee_rate?: number
    }) => {
      const assets = await rln.listAssets([])
      const all = [...(assets.nia ?? []), ...(assets.uda ?? []), ...(assets.cfa ?? [])]
      const precision = all.find(a => a.asset_id === asset_id)?.precision ?? 0
      const rawAmount = Math.round(amount * Math.pow(10, precision))
      const result = await rln.sendRgb({
        donation: false,
        fee_rate: fee_rate ?? 3,
        min_confirmations: 1,
        recipient_map: {
          [asset_id]: [{
            recipient_id,
            assignment: toFungibleAssignment(rawAmount),
            transport_endpoints: transport_endpoints ?? [],
          }],
        },
        skip_sync: false,
      })
      return t(JSON.stringify({
        sent: true,
        asset_id,
        recipient_id,
        amount_display: amount,
        amount_raw: rawAmount,
        txid: result.txid ?? null,
      }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_list_channels', 'rln_list_channels'],
    'List all RLN Lightning channels: capacity, local balance, usability, RGB asset allocation.',
    { usable_only: z.boolean().optional().describe('Return only usable channels (default: false)') },
    async ({ usable_only = false }: { usable_only?: boolean }) => {
      const res = await rln.listChannels()
      const channels = usable_only ? (res.channels ?? []).filter(c => c.is_usable) : (res.channels ?? [])
      const totalOut = channels.reduce((s, c) => s + (c.outbound_balance_msat ?? 0), 0)
      const totalIn = channels.reduce((s, c) => s + (c.inbound_balance_msat ?? 0), 0)
      return t(JSON.stringify({
        channel_count: channels.length,
        total_outbound_msat: totalOut,
        total_inbound_msat: totalIn,
        channels,
      }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_connect_peer', 'rln_connect_peer'],
    'Connect the RLN node to a Lightning peer. Required before LSPS1 channel purchase. Format: pubkey@host:port.',
    { peer_pubkey_and_addr: z.string().describe('pubkey@host:port') },
    async ({ peer_pubkey_and_addr }: { peer_pubkey_and_addr: string }) => {
      await rln.connectPeer({ peer_pubkey_and_addr })
      return t(JSON.stringify({ success: true, connected_to: peer_pubkey_and_addr }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_open_channel', 'rln_open_channel'],
    'Open a Lightning channel from the RLN node. Optionally allocate an RGB asset to the channel.',
    {
      peer_pubkey_and_addr: z.string().describe('pubkey@host:port'),
      capacity_sat: z.number().int().positive().describe('Channel capacity in satoshis'),
      push_msat: z.number().int().optional().describe('Millisatoshis to push to remote (default: 0)'),
      asset_id: z.string().optional().describe('RGB asset ID to allocate'),
      asset_amount: z.number().positive().optional().describe('Amount of RGB asset to allocate'),
      is_public: z.boolean().optional().describe('Announce channel publicly (default: false)'),
    },
    async ({
      peer_pubkey_and_addr,
      capacity_sat,
      push_msat,
      asset_id,
      asset_amount,
      is_public,
    }: {
      peer_pubkey_and_addr: string
      capacity_sat: number
      push_msat?: number
      asset_id?: string
      asset_amount?: number
      is_public?: boolean
    }) => {
      const result = await rln.openChannel({
        peer_pubkey_and_opt_addr: peer_pubkey_and_addr,
        capacity_sat,
        push_msat: push_msat ?? 0,
        asset_id,
        asset_amount,
        public: is_public ?? false,
        with_anchors: false,
      })
      return t(JSON.stringify({ ...result, note: 'Use wdk_list_channels to monitor until status=Opened' }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_close_channel', 'rln_close_channel'],
    'Close a Lightning channel on the RLN node. Use force=true only for unresponsive peers. Get channel_id from wdk_list_channels.',
    {
      channel_id: z.string().describe('Channel ID from wdk_list_channels'),
      peer_pubkey: z.string().describe('Peer pubkey from wdk_list_channels'),
      force: z.boolean().optional().describe('Force close (unilateral). Default: false (cooperative close)'),
    },
    async ({
      channel_id,
      peer_pubkey,
      force = false,
    }: CloseChannelRequest) => {
      await rln.closeChannel({ channel_id, peer_pubkey, force })
      return t(JSON.stringify({ closed: true, channel_id, peer_pubkey, force }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_get_channel_id', 'rln_get_channel_id'],
    'Resolve a temporary_channel_id (from wdk_open_channel) to the permanent channel_id once the channel is established.',
    {
      temporary_channel_id: z.string().describe('Temporary channel ID from wdk_open_channel'),
    },
    async ({ temporary_channel_id }: { temporary_channel_id: string }) =>
      t(JSON.stringify(await rln.getChannelId({ temporary_channel_id }), null, 2)),
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_list_payments', 'rln_list_payments'],
    'List recent Lightning payments (sent and received) on the RLN node.',
    {
      limit: z.number().int().positive().optional().describe('Max payments to return (default: 20)'),
      inbound_only: z.boolean().optional(),
      outbound_only: z.boolean().optional(),
    },
    async ({
      limit = 20,
      inbound_only,
      outbound_only,
    }: {
      limit?: number
      inbound_only?: boolean
      outbound_only?: boolean
    }) => {
      let payments = (await rln.listPayments()).payments ?? []
      if (inbound_only) payments = payments.filter(p => p.inbound)
      if (outbound_only) payments = payments.filter(p => !p.inbound)
      return t(JSON.stringify(payments.slice(0, limit), null, 2))
    },
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_refresh_transfers', 'rln_refresh_transfers'],
    'Refresh pending RGB asset transfers on the RLN node. Call after a KaleidoSwap order is FILLED to sync balances.',
    { skip_sync: z.boolean().optional() },
    async ({ skip_sync = false }: { skip_sync?: boolean }) => {
      await rln.refreshTransfers({ skip_sync })
      return t(JSON.stringify({ refreshed: true }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_atomic_taker', 'rln_atomic_taker'],
    'Step 2 of atomic HTLC swap: whitelist the incoming HTLC on the RLN node. Call with the swapstring from kaleidoswap_atomic_init BEFORE calling kaleidoswap_atomic_execute.',
    { swapstring: z.string().describe('Swapstring from kaleidoswap_atomic_init') },
    async ({ swapstring }: { swapstring: string }) => {
      await rln.whitelistSwap({ swapstring })
      return t(JSON.stringify({
        success: true,
        note: 'HTLC whitelisted — now call wdk_get_node_info for pubkey, then kaleidoswap_atomic_execute',
      }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_list_swaps', 'rln_list_swaps'],
    'List all atomic swaps on the RLN node (maker and taker sides).',
    {},
    async () => {
      const res = await rln.listSwaps()
      return t(JSON.stringify({
        maker: res.maker ?? [],
        taker: res.taker ?? [],
        total: (res.maker?.length ?? 0) + (res.taker?.length ?? 0),
      }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_get_swap', 'rln_get_swap'],
    'Get atomic swap status by payment_hash from the RLN node.',
    {
      payment_hash: z.string().describe('Payment hash from kaleidoswap_atomic_init'),
      taker: z.boolean().optional().describe('Filter for taker-side swap'),
    },
    async ({ payment_hash, taker }: { payment_hash: string; taker?: boolean }) => {
      const request = { payment_hash, ...(taker !== undefined ? { taker } : {}) } as Parameters<RlnClient['getSwap']>[0]
      return t(JSON.stringify(await rln.getSwap(request), null, 2))
    },
  )

  // -----------------------------------------------------------------------
  registerAliases(
    ['wdk_mpp_pay', 'rln_mpp_pay'],
    'Pay an MPP (Machine Payments Protocol) Lightning challenge from the RLN node. Returns a credential JSON for mpp_submit_credential.',
    {
      invoice: z.string().describe('BOLT11 invoice from mpp_request_challenge'),
      challenge_id: z.string().optional().describe('MPP challenge_id'),
      macaroon: z.string().optional().describe('Macaroon for L402-compatible servers'),
    },
    async ({ invoice, challenge_id, macaroon }: { invoice: string; challenge_id?: string; macaroon?: string }) => {
      const result = await rln.sendPayment({ invoice })
      const preimage = (result as Record<string, unknown>).preimage as string | undefined
        ?? (result as Record<string, unknown>).payment_secret as string | undefined
      const cred: Record<string, string> = { method: 'lightning' }
      if (challenge_id) cred.challenge_id = challenge_id
      if (preimage) cred.preimage = preimage
      if (macaroon) cred.macaroon = macaroon
      return t(JSON.stringify({
        paid: true,
        payment_hash: result.payment_hash ?? null,
        preimage: preimage ?? null,
        credential: JSON.stringify(cred),
        note: preimage ? 'Credential ready — pass to mpp_submit_credential' : 'Payment sent but preimage not returned by node',
      }, null, 2))
    },
  )
}

const t = (content: string) => ({ content: [{ type: 'text' as const, text: content }] })
