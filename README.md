# kaleido-mcp

Unified MCP server for the Kaleidoswap stack.

This repo is the **composition layer** that exposes the focused MCP domains through one connection:

- Spark wallet tools
- RLN wallet tools
- KaleidoSwap DEX tools
- MPP / L402 payment-gated API tools
- market data tools

The canonical tool contracts mirror the focused servers:

- `kaleidoswap_*`
- `wdk_*`
- `spark_*`
- `mpp_*`
- `l402_*`

Legacy `rln_*` and generic `get_*` market aliases are still present for compatibility during migration.

## Required Environment

| Env var | Required | Description |
| --- | --- | --- |
| `WDK_SEED` | yes | BIP-39 mnemonic for the Spark wallet |
| `SPARK_NETWORK` | no | `MAINNET` or `REGTEST` |
| `SPARK_SCAN_API_KEY` | no | SparkScan API key |
| `SPARK_USDT_TOKEN` | no | Default Spark token identifier |
| `RLN_NODE_URL` | no | RLN daemon URL, default `http://localhost:3001` |
| `KALEIDOSWAP_API_URL` | no | KaleidoSwap API URL, default `https://api.kaleidoswap.com` |
| `PORT` | no | Enable Streamable HTTP transport |
| `MCP_AUTH_TOKEN` | no | Bearer token for HTTP mode |

## Installation

```bash
npm install
npm run build
```

## Usage

```bash
# stdio
WDK_SEED="word1 word2 ..." node dist/index.js

# HTTP
PORT=3010 WDK_SEED="word1 word2 ..." node dist/index.js
```

## Repo Role

`kaleido-mcp` is intended to stay thin. Domain logic should live in the focused MCP packages or shared libraries, not be reimplemented here.
