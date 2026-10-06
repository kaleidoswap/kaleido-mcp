#!/usr/bin/env node
/**
 * kaleido-mcp — Unified KaleidoSwap + WDK MCP Server
 *
 * Single MCP server for all KaleidoSwap agent operations:
 *   • WDK Spark L2 wallet  (fee-free transfers, Lightning pay/receive, BTC bridge)
 *   • Liquid wallet        (L-BTC and Liquid assets via in-process LWK)
 *   • RLN node             (RGB assets, Lightning channels, atomic HTLC swaps)
 *   • KaleidoSwap DEX      (quotes, atomic swaps, LSPS1 channels)
 *   • MPP / L402           (payment-gated API access, challenge/credential flow)
 *   • 402index.io          (discover paid APIs by protocol/category)
 *   • Market data          (prices, OHLCV, Fear & Greed sentiment)
 *   • Node lifecycle       (local Docker RLN environments via the `kaleido` CLI)
 *
 * Env vars (all optional, see README.md for the full table):
 *   KALEIDO_NETWORK         — signet | mainnet (default: signet); sets the defaults below
 *   WDK_SEED                — BIP-39 mnemonic; enables the Spark wallet tools
 *   SPARK_NETWORK           — MAINNET | REGTEST (default: REGTEST on signet, MAINNET on mainnet)
 *   SPARK_SCAN_API_KEY      — SparkScan API key
 *   SPARK_USDT_TOKEN        — Spark USDT token identifier (btkn1...)
 *   LIQUID_MNEMONIC         — BIP-39 mnemonic for the Liquid wallet tools (default: WDK_SEED)
 *   LIQUID_NETWORK          — mainnet | testnet | regtest (default: testnet on signet, mainnet on mainnet)
 *   LIQUID_ESPLORA_URL      — Liquid Esplora API base URL
 *   RLN_NODE_URL            — RLN daemon URL (default: http://localhost:3001)
 *   RGB_PROXY_ENDPOINT      — default RGB proxy for RGB invoices (default: per KALEIDO_NETWORK)
 *   KALEIDOSWAP_API_URL     — KaleidoSwap API (default on signet; required on mainnet); KALEIDO_API_URL is also accepted
 *   PORT                    — Enable StreamableHTTP on this port (default: stdio)
 *   MCP_AUTH_TOKEN          — Bearer token for HTTP mode
 *
 * Usage:
 *   npx -y kaleido-mcp
 *   PORT=3010 WDK_SEED="..." node dist/index.js
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './server.js'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'

const NETWORK_PRESETS = {
  signet: { kaleidoswapApiUrl: 'https://api.signet.kaleidoswap.com', sparkNetwork: 'REGTEST', liquidNetwork: 'testnet', rgbProxyEndpoint: 'rpcs://proxy.iriswallet.com/0.2/json-rpc' },
  mainnet: { kaleidoswapApiUrl: undefined, sparkNetwork: 'MAINNET', liquidNetwork: 'mainnet', rgbProxyEndpoint: undefined },
} as const

type KaleidoNetwork = keyof typeof NETWORK_PRESETS

const NETWORK = (process.env.KALEIDO_NETWORK || 'signet').toLowerCase() as KaleidoNetwork
if (!(NETWORK in NETWORK_PRESETS)) {
  process.stderr.write(`[kaleido-mcp] Fatal: KALEIDO_NETWORK must be one of ${Object.keys(NETWORK_PRESETS).join(', ')} (got "${process.env.KALEIDO_NETWORK}")\n`)
  process.exit(1)
}
const preset = NETWORK_PRESETS[NETWORK]

const WDK_SEED    = process.env.WDK_SEED ?? ''
const SPARK_NET   = (process.env.SPARK_NETWORK || preset.sparkNetwork) as 'MAINNET' | 'REGTEST'
const LIQUID_MNEMONIC = process.env.LIQUID_MNEMONIC || WDK_SEED
const LIQUID_NET  = (process.env.LIQUID_NETWORK || preset.liquidNetwork).toLowerCase() as 'mainnet' | 'testnet' | 'regtest'
if (!['mainnet', 'testnet', 'regtest'].includes(LIQUID_NET)) {
  process.stderr.write(`[kaleido-mcp] Fatal: LIQUID_NETWORK must be one of mainnet, testnet, regtest (got "${process.env.LIQUID_NETWORK}")\n`)
  process.exit(1)
}
const RLN_URL     = process.env.RLN_NODE_URL || 'http://localhost:3001'
const KALEIDO_URL: string = process.env.KALEIDOSWAP_API_URL || process.env.KALEIDO_API_URL || preset.kaleidoswapApiUrl || (() => {
  process.stderr.write(`[kaleido-mcp] Fatal: KALEIDO_NETWORK=${NETWORK} has no default KaleidoSwap API; set KALEIDOSWAP_API_URL (or KALEIDO_API_URL) to your maker's API base URL\n`)
  process.exit(1)
})()
const RGB_PROXY   = process.env.RGB_PROXY_ENDPOINT || preset.rgbProxyEndpoint
const PORT        = process.env.PORT ? parseInt(process.env.PORT, 10) : null

process.stderr.write(`[kaleido-mcp] network: ${NETWORK}\n`)

if (!WDK_SEED) {
  process.stderr.write('[kaleido-mcp] WARNING: WDK_SEED not set — Spark wallet tools will be disabled\n')
  process.stderr.write('[kaleido-mcp] Set WDK_SEED="word1 word2 ... word12" to enable Spark features\n')
  // Continue without Spark — RLN, KaleidoSwap, MPP, and market tools still available
}

async function main() {
  const server = await createServer({
    wdkSeed: WDK_SEED,
    sparkNetwork: SPARK_NET,
    sparkScanApiKey: process.env.SPARK_SCAN_API_KEY,
    sparkUsdtToken: process.env.SPARK_USDT_TOKEN,
    rlnNodeUrl: RLN_URL,
    kaleidoswapApiUrl: KALEIDO_URL,
    rgbProxyEndpoint: RGB_PROXY,
    liquidMnemonic: LIQUID_MNEMONIC,
    liquidNetwork: LIQUID_NET,
    liquidEsploraUrl: process.env.LIQUID_ESPLORA_URL,
  })

  const label = `${NETWORK}: Spark(${WDK_SEED ? SPARK_NET : 'disabled'}) + Liquid(${LIQUID_MNEMONIC ? LIQUID_NET : 'disabled'}) + RLN(${RLN_URL}) + KaleidoSwap(${KALEIDO_URL})`

  if (PORT) {
    const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? null
    const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (AUTH_TOKEN && req.headers['authorization'] !== `Bearer ${AUTH_TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => transport.close().catch(() => {}))
      await server.connect(transport)
      await transport.handleRequest(req, res)
    })
    httpServer.listen(PORT, '0.0.0.0', () =>
      process.stderr.write(`[kaleido-mcp] HTTP on port ${PORT} — ${label}\n`))
  } else {
    const transport = new StdioServerTransport()
    await server.connect(transport)
    process.stderr.write(`[kaleido-mcp] stdio connected — ${label}\n`)
  }
}

main().catch(err => {
  process.stderr.write(`[kaleido-mcp] Fatal: ${err}\n`)
  process.exit(1)
})
