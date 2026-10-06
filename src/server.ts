/**
 * kaleido-mcp — Unified WDK MCP Server
 *
 * Assembles a single WdkMcpServer (from @tetherto/wdk-mcp-toolkit) that contains:
 *
 *  LAYER 1 — WDK built-in tools (via registerTools, only when WDK_SEED is set):
 *    • WALLET_TOOLS  — getAddress, getBalance, sendTransaction, transfer,
 *                      getTokenBalance, quoteSendTransaction, quoteTransfer,
 *                      getFeeRates, sign, verify  (all scoped to 'spark' chain)
 *    • PRICING_TOOLS — getCurrentPrice, getHistoricalPrice  (Bitfinex)
 *
 *  LAYER 2 — Custom Spark tools (only when WDK_SEED is set):
 *    spark_get_balance, spark_get_address, spark_create_lightning_invoice, spark_pay_lightning_invoice,
 *    spark_quote_lightning_payment, spark_get_deposit_address,
 *    spark_quote_withdraw, spark_withdraw, spark_get_transfers,
 *    spark_send_sats, spark_transfer_token, spark_mpp_pay, spark_get_token_balance,
 *    spark_create_sats_invoice, spark_create_tokens_invoice, spark_pay_invoice, spark_get_invoices
 *
 *  LAYER 2b — Liquid wallet tools (only when LIQUID_MNEMONIC or WDK_SEED is set):
 *    liquid_get_node_info, liquid_get_address, liquid_get_balance, liquid_get_asset_balance,
 *    liquid_list_assets, liquid_list_transactions, liquid_list_unspents,
 *    liquid_send_btc, liquid_send_asset, liquid_get_fee_rates
 *
 *  LAYER 3 — RLN (RGB Lightning Node) tools:
 *    wdk_get_node_info, wdk_get_balances, wdk_list_assets, wdk_get_asset_balance,
 *    wdk_get_address, wdk_create_rgb_invoice, wdk_create_ln_invoice,
 *    wdk_pay_invoice, wdk_send_btc, wdk_send_asset, wdk_list_channels,
 *    wdk_connect_peer, wdk_open_channel, wdk_close_channel, wdk_get_channel_id,
 *    wdk_list_payments, wdk_create_utxos, wdk_issue_asset, wdk_list_transfers,
 *    wdk_refresh_transfers, wdk_atomic_taker, wdk_list_swaps,
 *    wdk_get_swap, wdk_mpp_pay
 *
 *  LAYER 4 — KaleidoSwap DEX tools:
 *    kaleidoswap_get_assets, kaleidoswap_get_pairs, kaleidoswap_get_quote,
 *    kaleidoswap_get_spreads,
 *    kaleidoswap_atomic_init, kaleidoswap_atomic_execute, kaleidoswap_atomic_status,
 *    kaleidoswap_lsp_get_info, kaleidoswap_lsp_estimate_fees,
 *    kaleidoswap_lsp_create_order, kaleidoswap_lsp_get_order,
 *    kaleidoswap_lsp_quote_asset_channel, kaleidoswap_lsp_create_asset_channel
 *
 *  LAYER 5 — MPP / L402 / 402index.io:
 *    mpp_request_challenge, mpp_submit_credential, mpp_parse_challenge_header,
 *    l402_request_challenge, l402_fetch_resource, search_paid_apis
 *
 *  LAYER 6 — Market data (CoinGecko / alternative.me):
 *    l402_get_price, l402_get_market_data, l402_get_ohlcv, l402_get_sentiment
 *
 *  LAYER 7 — Node lifecycle (local Docker RLN environments, via `kaleido` CLI):
 *    kaleido_node_list, kaleido_node_up, kaleido_node_stop, kaleido_node_down, kaleido_node_ps,
 *    kaleido_node_status, kaleido_node_info, kaleido_node_use, kaleido_node_init,
 *    kaleido_node_unlock, kaleido_node_lock
 *
 * Legacy aliases are retained temporarily for older `rln_*` and generic `get_*` callers.
 * The Spark and Liquid wallet modules are imported lazily so seedless startups skip them.
 */

import { createRequire } from 'node:module'
import { WdkMcpServer, WALLET_TOOLS, PRICING_TOOLS } from '@tetherto/wdk-mcp-toolkit'
import { KaleidoClient } from 'kaleido-sdk'
import { registerRlnTools } from './tools/rln-tools.js'
import { registerKaleidoswapTools } from './tools/kaleidoswap-tools.js'
import { registerMppTools } from './tools/mpp-tools.js'
import { registerMarketTools } from './tools/market-tools.js'
import { registerNodeLifecycleTools } from './tools/node-lifecycle-tools.js'

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
  /** Default RGB proxy advertised on RGB invoices */
  rgbProxyEndpoint?: string
  /** BIP-39 mnemonic for the Liquid wallet; enables the liquid_* tools */
  liquidMnemonic?: string
  /** Liquid network (default: mainnet) */
  liquidNetwork?: 'mainnet' | 'testnet' | 'regtest'
  /** Liquid Esplora API base URL (default: the network's built-in client) */
  liquidEsploraUrl?: string
}

function optionalPeerMissing(error: unknown, pkg: string): boolean {
  const e = error as { code?: string, message?: string }
  return (e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND') && !!e.message?.includes(pkg)
}

function installHint(pkg: string): string {
  return `${pkg} is not installed. Install it next to kaleido-mcp (npm i ${pkg}), or run: npx -y -p kaleido-mcp -p ${pkg} kaleido-mcp`
}

export const VERSION: string = createRequire(import.meta.url)('../package.json').version

export async function createServer(config: KaleidoMcpConfig): Promise<WdkMcpServer> {
  // -------------------------------------------------------------------------
  // 1. Bootstrap WdkMcpServer — Spark tools only if WDK_SEED is provided
  // -------------------------------------------------------------------------
  const server = new WdkMcpServer('kaleido-mcp', VERSION)

  if (config.wdkSeed) {
    try {
      // @ts-ignore — ESM/CJS compat
      const { default: WalletManagerSpark } = await import('@tetherto/wdk-wallet-spark')
      const { registerSparkTools } = await import('./tools/spark-tools.js')
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
      const reason = optionalPeerMissing(error, '@tetherto/wdk-wallet-spark') ? installHint('@tetherto/wdk-wallet-spark') : `failed to initialise: ${error}`
      process.stderr.write(`[kaleido-mcp] Spark tools disabled (${reason})\n`)
    }
  } else {
    process.stderr.write('[kaleido-mcp] Spark tools disabled (WDK_SEED not set)\n')
  }

  if (config.liquidMnemonic) {
    try {
      const { LiquidAccount } = await import('@kaleidorg/wdk-wallet-liquid')
      const { registerLiquidTools } = await import('./tools/liquid-tools.js')
      registerLiquidTools(server, new LiquidAccount({
        mnemonic: config.liquidMnemonic,
        network: config.liquidNetwork ?? 'mainnet',
        ...(config.liquidEsploraUrl ? { esploraUrl: config.liquidEsploraUrl } : {}),
      }))
    } catch (error) {
      const reason = optionalPeerMissing(error, '@kaleidorg/wdk-wallet-liquid') ? installHint('@kaleidorg/wdk-wallet-liquid') : `failed to initialise: ${error}`
      process.stderr.write(`[kaleido-mcp] Liquid tools disabled (${reason})\n`)
    }
  } else {
    process.stderr.write('[kaleido-mcp] Liquid tools disabled (LIQUID_MNEMONIC / WDK_SEED not set)\n')
  }

  const sdk = KaleidoClient.create({
    baseUrl: config.kaleidoswapApiUrl,
    nodeUrl: config.rlnNodeUrl,
  })

  // -------------------------------------------------------------------------
  // 3. RLN tools (RGB assets, Lightning channels, atomic swaps)
  // -------------------------------------------------------------------------
  registerRlnTools(server, sdk.rln, config.rgbProxyEndpoint ? [config.rgbProxyEndpoint] : [])

  // -------------------------------------------------------------------------
  // 4. KaleidoSwap DEX tools (quotes, atomic, LSP)
  // -------------------------------------------------------------------------
  registerKaleidoswapTools(server, sdk.maker, sdk.rln)

  // -------------------------------------------------------------------------
  // 5. MPP / L402 / 402index.io discovery
  // -------------------------------------------------------------------------
  registerMppTools(server)

  // -------------------------------------------------------------------------
  // 6. Market data (CoinGecko + Fear & Greed)
  // -------------------------------------------------------------------------
  registerMarketTools(server)

  // -------------------------------------------------------------------------
  // 7. Node lifecycle (local Docker RLN environments via CLI)
  // -------------------------------------------------------------------------
  registerNodeLifecycleTools(server)

  return server
}
