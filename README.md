# kaleido-mcp

Unified MCP server for the Kaleidoswap stack.

This repo is the **composition layer** that exposes the focused MCP domains through one connection:

- Spark wallet tools
- RLN wallet tools
- KaleidoSwap DEX tools
- MPP / L402 payment-gated API tools
- market data tools
- node lifecycle tools (local Docker signet/regtest env management)

The canonical tool contracts mirror the focused servers:

- `kaleidoswap_*`
- `wdk_*`
- `spark_*`
- `mpp_*`
- `l402_*`
- `kaleido_node_*`

Legacy `rln_*` and generic `get_*` market aliases are still present for compatibility during migration.

## Node lifecycle tools

`kaleido_node_list/up/stop/down/ps/status/info/use/init/unlock/lock` shell out to a local `kaleido`
CLI binary to spin Docker containers for a signet/regtest environment up and down, and manage RLN
wallet unlock state. These were ported from the now-retired `kaleido-node-mcp` repo — everything else
in that repo (wallet/asset/channel/payment/market/swap tools) duplicated the SDK-backed tools above
and was dropped rather than ported.

| Env var | Required | Description |
| --- | --- | --- |
| `KALEIDO_BIN` | no | Path to the `kaleido` CLI binary (default: auto-detect in common install paths, else `PATH`) |
| `KALEIDO_NODE_URL` | no | RLN node URL override passed to the CLI |
| `KALEIDO_API_URL` | no | KaleidoSwap API URL override passed to the CLI |
| `KALEIDO_ENV_NAME` | no | Default environment name for `up`/`stop`/`down`/`ps` when not passed explicitly |

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
