#!/usr/bin/env node
/**
 * kaleido-mcp — Unified KaleidoSwap + WDK MCP Server
 *
 * Single MCP server for all KaleidoSwap agent operations:
 *   • WDK Spark L2 wallet  (fee-free transfers, Lightning pay/receive, BTC bridge)
 *   • RLN node             (RGB assets, Lightning channels, atomic HTLC swaps)
 *   • KaleidoSwap DEX      (quotes, REST orders, atomic swaps, LSPS1 channels)
 *   • MPP / L402           (payment-gated API access, challenge/credential flow)
 *   • 402index.io          (discover paid APIs by protocol/category)
 *   • Market data          (prices, OHLCV, Fear & Greed sentiment)
 *
 * ~60 tools, one process, one connection.
 *
 * Required env vars:
 *   WDK_SEED          — BIP-39 mnemonic for Spark wallet
 *
 * Optional env vars:
 *   SPARK_NETWORK           — MAINNET | REGTEST (default: MAINNET)
 *   SPARK_SCAN_API_KEY      — SparkScan API key
 *   SPARK_USDT_TOKEN        — Spark USDT token identifier (btkn1...)
 *   RLN_NODE_URL            — RLN daemon URL (default: http://localhost:3001)
 *   KALEIDOSWAP_API_URL     — KaleidoSwap API (default: https://api.kaleidoswap.com)
 *   PORT                    — Enable StreamableHTTP on this port (default: stdio)
 *   MCP_AUTH_TOKEN          — Bearer token for HTTP mode
 *
 * Usage:
 *   WDK_SEED="word1 ... word12" node dist/index.js
 *   PORT=3010 WDK_SEED="..." node dist/index.js
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './server.js'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'

const WDK_SEED    = process.env.WDK_SEED ?? ''
const SPARK_NET   = (process.env.SPARK_NETWORK ?? 'MAINNET') as 'MAINNET' | 'REGTEST'
const RLN_URL     = process.env.RLN_NODE_URL ?? 'http://localhost:3001'
const KALEIDO_URL = process.env.KALEIDOSWAP_API_URL ?? 'https://api.kaleidoswap.com'
const PORT        = process.env.PORT ? parseInt(process.env.PORT, 10) : null

if (!WDK_SEED) {
  process.stderr.write('[kaleido-mcp] WARNING: WDK_SEED not set — Spark wallet tools will be disabled\n')
  process.stderr.write('[kaleido-mcp] Set WDK_SEED="word1 word2 ... word12" to enable Spark features\n')
  // Continue without Spark — RLN, KaleidoSwap, MPP, and market tools still available
}

async function main() {
  const server = createServer({
    wdkSeed: WDK_SEED,
    sparkNetwork: SPARK_NET,
    sparkScanApiKey: process.env.SPARK_SCAN_API_KEY,
    sparkUsdtToken: process.env.SPARK_USDT_TOKEN,
    rlnNodeUrl: RLN_URL,
    kaleidoswapApiUrl: KALEIDO_URL,
  })

  const label = `Spark(${SPARK_NET}) + RLN(${RLN_URL}) + KaleidoSwap(${KALEIDO_URL})`

  if (PORT) {
    const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? null
    const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
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
