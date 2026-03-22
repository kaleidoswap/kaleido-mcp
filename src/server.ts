/**
 * kaleido-mcp — Unified WDK MCP Server
 *
 * Assembles a single WdkMcpServer (from @tetherto/wdk-mcp-toolkit) that contains:
 *
 *  LAYER 1 — WDK built-in tools (via registerTools):
 *    • WALLET_TOOLS  — getAddress, getBalance, sendTransaction, transfer,
 *                      getTokenBalance, quoteSendTransaction, quoteTransfer,
 *                      getFeeRates, sign, verify  (all scoped to 'spark' chain)
 *    • PRICING_TOOLS — getCurrentPrice, getHistoricalPrice  (Bitfinex)
 *
 *  LAYER 2 — Custom Spark tools (Lightning invoices, BTC bridge, fee-free transfers):
 *    spark_get_balance, spark_get_address, spark_create_lightning_invoice, spark_pay_lightning_invoice,
 *    spark_quote_lightning_payment, spark_get_deposit_address,
 *    spark_quote_withdraw, spark_withdraw, spark_get_transfers,
 *    spark_send_sats, spark_transfer_token, spark_mpp_pay, spark_get_token_balance
 *
 *  LAYER 3 — RLN (RGB Lightning Node) tools:
 *    wdk_get_node_info, wdk_get_balances, wdk_list_assets, wdk_get_asset_balance,
 *    wdk_get_address, wdk_create_rgb_invoice, wdk_create_ln_invoice,
 *    wdk_pay_invoice, wdk_send_btc, wdk_send_asset, wdk_list_channels,
 *    wdk_connect_peer, wdk_open_channel, wdk_list_payments,
 *    wdk_refresh_transfers, wdk_atomic_taker, wdk_list_swaps,
 *    wdk_get_swap, wdk_mpp_pay
 *
 *  LAYER 4 — KaleidoSwap DEX tools:
 *    kaleidoswap_get_assets, kaleidoswap_get_pairs, kaleidoswap_get_quote,
 *    kaleidoswap_get_spreads, kaleidoswap_place_order, kaleidoswap_get_order_status,
 *    kaleidoswap_get_open_orders, kaleidoswap_cancel_order, kaleidoswap_get_position,
 *    kaleidoswap_atomic_init, kaleidoswap_atomic_execute, kaleidoswap_atomic_status,
 *    kaleidoswap_lsp_get_info, kaleidoswap_lsp_estimate_fees,
 *    kaleidoswap_lsp_create_order, kaleidoswap_lsp_get_order
 *
 *  LAYER 5 — MPP / L402 / 402index.io:
 *    mpp_request_challenge, mpp_submit_credential, mpp_parse_challenge_header,
 *    l402_request_challenge, l402_fetch_resource, search_paid_apis
 *
 *  LAYER 6 — Market data (CoinGecko / alternative.me):
 *    l402_get_price, l402_get_market_data, l402_get_ohlcv, l402_get_sentiment
 *
 * Legacy aliases are retained temporarily for older `rln_*` and generic `get_*` callers.
 */

import { WdkMcpServer, WALLET_TOOLS, PRICING_TOOLS } from '@tetherto/wdk-mcp-toolkit'
// @ts-ignore — ESM/CJS compat
import WalletManagerSpark from '@tetherto/wdk-wallet-spark'
import { KaleidoClient } from 'kaleido-sdk'
import { registerRlnTools } from './tools/rln-tools.js'
import { registerSparkTools } from './tools/spark-tools.js'
import { registerKaleidoswapTools } from './tools/kaleidoswap-tools.js'
import { registerMppTools } from './tools/mpp-tools.js'
import { registerMarketTools } from './tools/market-tools.js'

export interface KaleidoMcpConfig {
  /** BIP-39 seed phrase for WDK Spark wallet */
  wdkSeed: string
  /** Spark network (default: MAINNET) */
  sparkNetwork: 'MAINNET' | 'REGTEST'
  /** SparkScan API key (optional, for enhanced queries) */
  sparkScanApiKey?: string
  /** Spark USDT token identifier (btkn1...) */
  sparkUsdtToken?: string
  /** RLN node HTTP URL (e.g. http://localhost:3001) */
  rlnNodeUrl: string
  /** KaleidoSwap API base URL */
  kaleidoswapApiUrl: string
}

export function createServer(config: KaleidoMcpConfig): WdkMcpServer {
  // -------------------------------------------------------------------------
  // 1. Bootstrap WdkMcpServer — Spark tools only if WDK_SEED is provided
  // -------------------------------------------------------------------------
  const server = new WdkMcpServer('kaleido-mcp', '1.0.0')

  if (config.wdkSeed) {
    try {
      server
        .useWdk({ seed: config.wdkSeed })
        .registerWallet('spark', WalletManagerSpark, {
          network: config.sparkNetwork,
          ...(config.sparkScanApiKey ? { sparkScanApiKey: config.sparkScanApiKey } : {}),
        })
        .usePricing()
        .registerTools([
          // Built-in WDK wallet tools (scoped to 'spark' chain automatically via getChains())
          ...WALLET_TOOLS,
          // Bitfinex pricing: getCurrentPrice, getHistoricalPrice
          ...PRICING_TOOLS,
        ])

      // -----------------------------------------------------------------------
      // 2. Spark-specific custom tools (Lightning invoices, BTC bridge, MPP)
      // -----------------------------------------------------------------------
      registerSparkTools(server, config.sparkUsdtToken)
    } catch (error) {
      process.stderr.write(`[kaleido-mcp] Spark tools disabled (invalid WDK_SEED): ${error}\n`)
    }
  } else {
    process.stderr.write('[kaleido-mcp] Spark tools disabled (WDK_SEED not set)\n')
  }

  const sdk = KaleidoClient.create({
    baseUrl: config.kaleidoswapApiUrl,
    nodeUrl: config.rlnNodeUrl,
  })

  // -------------------------------------------------------------------------
  // 3. RLN tools (RGB assets, Lightning channels, atomic swaps)
  // -------------------------------------------------------------------------
  registerRlnTools(server, sdk.rln)

  // -------------------------------------------------------------------------
  // 4. KaleidoSwap DEX tools (quotes, orders, atomic, LSP)
  // -------------------------------------------------------------------------
  registerKaleidoswapTools(server, sdk.maker)

  // -------------------------------------------------------------------------
  // 5. MPP / L402 / 402index.io discovery
  // -------------------------------------------------------------------------
  registerMppTools(server)

  // -------------------------------------------------------------------------
  // 6. Market data (CoinGecko + Fear & Greed)
  // -------------------------------------------------------------------------
  registerMarketTools(server)

  return server
}
