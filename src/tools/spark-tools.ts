/**
 * Spark L2 wallet tools — Lightning pay/receive, fee-free transfers, BTC bridge.
 * These extend the WDK built-in WALLET_TOOLS (which handle generic wallet access)
 * with the canonical `spark_*` contract exposed by `wdk-wallet-spark-mcp`.
 */
import { z } from 'zod'
import type { WdkMcpServer } from '@tetherto/wdk-mcp-toolkit'

// Use 'any' for the Spark account — the WDK getAccount() returns a generic
// wallet account interface but at runtime it is a Spark account with extra
// Lightning and bridge methods.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SparkAccount = any

export function registerSparkTools(server: WdkMcpServer, usdtToken?: string): void {
  const getAccount = async (): Promise<SparkAccount> => {
    const wdk = server.wdk
    if (!wdk) throw new Error('WDK not initialized — call useWdk() first')
    return wdk.getAccount('spark', 0)
  }

  // -----------------------------------------------------------------------
  server.tool(
    'spark_get_balance',
    'Get the Spark L2 wallet balance in satoshis. Spark transactions are fee-free. Use this to check available BTC on Spark before making payments or swaps via Lightning.',
    {},
    async () => {
      const account = await getAccount()
      const balanceSats = await account.getBalance()
      return t(JSON.stringify({
        balance_sats: Number(balanceSats),
        balance_btc: Number(balanceSats) / 1e8,
        note: 'Spark L2 balance — fee-free transfers on Spark network',
      }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  server.tool(
    'spark_get_address',
    'Get the Spark L2 address for this wallet. Use this to receive sats or tokens directly on Spark from another Spark wallet (fee-free).',
    {},
    async () => {
      const account = await getAccount()
      const address = await account.getAddress()
      return t(JSON.stringify({ spark_address: address }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  server.tool(
    'spark_get_token_balance',
    'Get the balance of a Spark token (e.g. USDT) by its token identifier. Returns balance as a bigint string. Use SPARK_USDT_TOKEN env var or pass the token address directly.',
    {
      token: z
        .string()
        .optional()
        .describe('Spark token identifier (e.g. btkn1...). Omit to use the configured USDT token.'),
    },
    async ({ token }: { token?: string }) => {
      const tokenAddr = token ?? usdtToken
      if (!tokenAddr) {
        return t(JSON.stringify({
          error: 'No token provided. Pass a token identifier or set SPARK_USDT_TOKEN env var.',
        }, null, 2))
      }
      const account = await getAccount()
      const balance = await account.getTokenBalance(tokenAddr)
      return t(JSON.stringify({ token: tokenAddr, balance: balance.toString() }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  server.tool(
    'spark_get_deposit_address',
    'Generate a Bitcoin L1 address to bridge BTC into the Spark L2 wallet. Funds sent on-chain are bridged to Spark automatically.',
    { reusable: z.boolean().optional().describe('Return a static reusable address (default: false = single-use)') },
    async ({ reusable = false }: { reusable?: boolean }) => {
      const account = await getAccount()
      const address = reusable
        ? await account.getStaticDepositAddress()
        : await account.getSingleUseDepositAddress()
      return t(JSON.stringify({
        btc_l1_deposit_address: address,
        type: reusable ? 'static_reusable' : 'single_use',
        note: 'Send BTC on-chain to this address — it bridges to your Spark L2 wallet',
      }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  server.tool(
    'spark_create_lightning_invoice',
    'Create a BOLT11 Lightning invoice to receive BTC into the Spark L2 wallet via Lightning Network. BTC received lands in Spark balance instantly. Use this to receive KaleidoSwap BTC payouts directly into Spark.',
    {
      amount_sats: z.number().int().positive().optional().describe('Amount in satoshis to receive. Omit for any-amount invoice.'),
      memo: z.string().optional().describe('Invoice description'),
    },
    async ({ amount_sats, memo }: { amount_sats?: number; memo?: string }) => {
      const account = await getAccount()
      const req = await account.createLightningInvoice({
        ...(amount_sats !== undefined ? { amountSats: amount_sats } : {}),
        ...(memo ? { memo } : {}),
      })
      const encodedInvoice = req?.invoice?.encodedInvoice ?? req?.invoice ?? null
      return t(JSON.stringify({
        invoice: encodedInvoice,
        id: req.id,
        amount_sats: req.amountSats ?? amount_sats ?? null,
        memo: memo ?? null,
        note: 'Pay this BOLT11 from any Lightning wallet to receive into Spark L2',
      }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  server.tool(
    'spark_pay_lightning_invoice',
    'Pay a BOLT11 Lightning invoice from the Spark L2 wallet. Use this to pay KaleidoSwap deposit invoices when RLN channels are low or unavailable. No Lightning channels needed on the Spark side.',
    {
      invoice: z.string().describe('BOLT11 invoice (lnbc... or lntb...)'),
      max_fee_sats: z.number().int().positive().optional().describe('Maximum fee in satoshis'),
    },
    async ({ invoice, max_fee_sats }: { invoice: string; max_fee_sats?: number }) => {
      const account = await getAccount()
      const req = await account.payLightningInvoice({
        encodedInvoice: invoice,
        ...(max_fee_sats !== undefined ? { maxFeeSats: max_fee_sats } : {}),
      })
      return t(JSON.stringify({
        id: req.id,
        invoice: req.invoice,
        status: req.status,
        max_fee_sats: req.maxFeeSats ?? null,
        note: 'Lightning payment initiated from Spark L2',
      }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  server.tool(
    'spark_quote_lightning_payment',
    'Estimate the Lightning routing fee for paying a BOLT11 invoice from Spark.',
    { invoice: z.string().describe('BOLT11 invoice to quote') },
    async ({ invoice }: { invoice: string }) => {
      const account = await getAccount()
      const fee = await account.quotePayLightningInvoice({ encodedInvoice: invoice })
      return t(JSON.stringify({ estimated_fee_sats: Number(fee), invoice }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  server.tool(
    'spark_send_sats',
    'Send satoshis to another Spark L2 address. Spark transfers are completely fee-free. Use this for direct Spark-to-Spark sats movement.',
    {
      to: z.string().describe('Destination Spark address (spark1...)'),
      amount_sats: z.number().int().positive().describe('Amount in satoshis to send'),
    },
    async ({ to, amount_sats }: { to: string; amount_sats: number }) => {
      const account = await getAccount()
      const result = await account.sendTransaction({ to, value: amount_sats })
      return t(JSON.stringify({
        hash: result.hash,
        fee_sats: Number(result.fee),
        sent_sats: amount_sats,
        to,
        note: 'Spark L2 transfer — fee-free',
      }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  server.tool(
    'spark_transfer_token',
    'Transfer a Spark token (e.g. USDT) to another Spark address. Fee-free. Use this to send USDT on Spark L2 without transaction fees.',
    {
      to: z.string().describe('Destination Spark address (spark1...)'),
      amount: z
        .string()
        .describe('Amount to send as a string integer in base units, e.g. "1000000" for 1 USDT with 6 decimals'),
      token: z
        .string()
        .optional()
        .describe('Spark token identifier. Omit to use the configured USDT token (SPARK_USDT_TOKEN).'),
    },
    async ({ to, amount, token }: { to: string; amount: string; token?: string }) => {
      const tokenAddr = token ?? usdtToken
      if (!tokenAddr) {
        return t(JSON.stringify({
          error: 'No token provided. Pass token or set SPARK_USDT_TOKEN env var.',
        }, null, 2))
      }
      const account = await getAccount()
      const result = await account.transfer({
        token: tokenAddr,
        amount: BigInt(amount),
        recipient: to,
      })
      return t(JSON.stringify({
        hash: result.hash,
        fee: result.fee.toString(),
        token: tokenAddr,
        amount,
        to,
        note: 'Spark token transfer — fee-free',
      }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  server.tool(
    'spark_quote_withdraw',
    'Get a fee quote for withdrawing BTC from Spark L2 back to Bitcoin L1 (cooperative exit). Call before spark_withdraw.',
    {
      onchain_address: z.string().describe('Destination Bitcoin L1 address'),
      amount_sats: z.number().int().positive().describe('Amount in satoshis to withdraw'),
    },
    async ({ onchain_address, amount_sats }: { onchain_address: string; amount_sats: number }) => {
      const account = await getAccount()
      const quote = await account.quoteWithdraw({
        withdrawalAddress: onchain_address,
        amountSats: amount_sats,
      })
      return t(JSON.stringify({ ...quote, onchain_address, amount_sats }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  server.tool(
    'spark_withdraw',
    'Withdraw BTC from Spark L2 to a Bitcoin L1 address (cooperative exit). Use spark_quote_withdraw first to check fees. exitSpeed: FAST | MEDIUM | SLOW',
    {
      onchain_address: z.string().describe('Destination Bitcoin L1 address'),
      amount_sats: z.number().int().positive().optional().describe('Amount in satoshis (omit to withdraw all)'),
      exit_speed: z.enum(['FAST', 'MEDIUM', 'SLOW']).optional().describe('Exit speed (default: MEDIUM)'),
    },
    async ({
      onchain_address,
      amount_sats,
      exit_speed = 'MEDIUM',
    }: {
      onchain_address: string
      amount_sats?: number
      exit_speed?: 'FAST' | 'MEDIUM' | 'SLOW'
    }) => {
      const account = await getAccount()
      const result = await account.withdraw({
        onchainAddress: onchain_address,
        exitSpeed: exit_speed,
        ...(amount_sats !== undefined ? { amountSats: amount_sats } : {}),
      })
      return t(JSON.stringify({
        ...result,
        amount_sats: amount_sats ?? null,
        onchain_address,
        note: 'Cooperative exit to Bitcoin L1 initiated',
      }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  server.tool(
    'spark_get_transfers',
    'List recent Spark L2 transfer history (Lightning payments, token transfers, BTC bridge events).',
    {
      direction: z.enum(['all', 'incoming', 'outgoing']).optional().describe("Direction filter (default: 'all')"),
      limit: z.number().int().positive().optional().describe('Max results (default: 20)'),
    },
    async ({ direction = 'all', limit = 20 }: { direction?: 'all' | 'incoming' | 'outgoing'; limit?: number }) => {
      const account = await getAccount()
      const transfers = await account.getTransfers({ direction, limit, skip: 0 })
      return t(JSON.stringify({ count: transfers.length, transfers }, null, 2))
    },
  )

  // -----------------------------------------------------------------------
  server.tool(
    'spark_mpp_pay',
    'Pay an MPP (Machine Payments Protocol) Lightning challenge from the Spark wallet. Use to access 402index.io or other payment-gated APIs when RLN has low outbound liquidity.',
    {
      invoice: z.string().describe('BOLT11 invoice from mpp_request_challenge'),
      challenge_id: z.string().optional().describe('MPP challenge_id'),
      macaroon: z.string().optional().describe('Macaroon for L402-compatible servers'),
      max_fee_sats: z.number().int().positive().optional(),
    },
    async ({
      invoice,
      challenge_id,
      macaroon,
      max_fee_sats,
    }: {
      invoice: string
      challenge_id?: string
      macaroon?: string
      max_fee_sats?: number
    }) => {
      const account = await getAccount()
      const req = await account.payLightningInvoice({
        encodedInvoice: invoice,
        ...(max_fee_sats !== undefined ? { maxFeeSats: max_fee_sats } : {}),
      })
      const cred: Record<string, string> = { method: 'lightning' }
      if (challenge_id) cred.challenge_id = challenge_id
      if (req?.id) cred.payment_id = req.id
      if (macaroon) cred.macaroon = macaroon
      return t(JSON.stringify({
        paid: true,
        payment_id: req?.id,
        status: req?.status,
        credential: JSON.stringify(cred),
        note: 'Credential ready — pass to mpp_submit_credential',
      }, null, 2))
    },
  )
}

const t = (content: string) => ({ content: [{ type: 'text' as const, text: content }] })
