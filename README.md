# kaleido-mcp

[![npm](https://img.shields.io/npm/v/kaleido-mcp)](https://www.npmjs.com/package/kaleido-mcp)
[![CI](https://github.com/kaleidoswap/kaleido-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/kaleidoswap/kaleido-mcp/actions/workflows/ci.yml)

One MCP server that gives an AI agent the whole KaleidoSwap stack over a single connection:

- **KaleidoSwap DEX** — assets, pairs, quotes, atomic BTC ↔ RGB swaps, LSP channel purchases
- **RGB Lightning Node (RLN)** — on-chain BTC, RGB assets, Lightning channels and payments
- **Spark wallet** (optional, via WDK) — fee-free L2 transfers, Lightning pay/receive, BTC bridge
- **Liquid wallet** (optional) — L-BTC and Liquid assets such as USDt from an in-process LWK wallet
- **MPP / L402** — pay for and consume payment-gated APIs, discover them on 402index.io
- **Market data** — spot prices, OHLCV, Fear & Greed index
- **Node lifecycle** — start, stop, init and unlock a local RLN through the `kaleido` CLI

See [docs/TOOLS.md](docs/TOOLS.md) for every tool and its parameters.

kaleido-mcp supersedes the standalone `wdk-wallet-mcp` (RLN), `wdk-wallet-spark-mcp` and
`wdk-wallet-liquid-mcp` servers: their tools are included here under the same names.

> **Beta software.** Start on signet. Mainnet use is at your own risk.

## Quickstart (signet)

Requires Node.js 20 or newer.

```bash
npx -y kaleido-mcp
```

The server speaks MCP over stdio, logs to stderr and defaults to signet. With no other configuration
you get the KaleidoSwap market tools (assets, pairs, quotes), MPP/L402 and market data tools straight
away. Wallet and swap tools need an RGB Lightning Node (see [Running a signet node](#running-a-signet-rgb-lightning-node)).

The Spark and Liquid wallets are optional add-ons: they need a `WDK_SEED` (or `LIQUID_MNEMONIC`) **and**
their wallet package, which is not installed by default to keep `npx` fast:

```bash
# Spark
WDK_SEED="word1 ... word12" npx -y -p kaleido-mcp -p @tetherto/wdk-wallet-spark kaleido-mcp
# Liquid
LIQUID_MNEMONIC="word1 ... word12" npx -y -p kaleido-mcp -p @kaleidorg/wdk-wallet-liquid kaleido-mcp
```

If a seed is set but the package is missing, the server starts without those tools and says which
package to install on stderr.

### Claude Code

```bash
claude mcp add kaleido -- npx -y kaleido-mcp
```

or in a project `.mcp.json`:

```json
{
  "mcpServers": {
    "kaleido": {
      "command": "npx",
      "args": ["-y", "kaleido-mcp"],
      "env": {
        "KALEIDO_NETWORK": "signet",
        "RLN_NODE_URL": "http://localhost:3001"
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "kaleido-signet": {
      "command": "npx",
      "args": ["-y", "kaleido-mcp"],
      "env": {
        "KALEIDO_NETWORK": "signet",
        "RLN_NODE_URL": "http://localhost:3001"
      }
    }
  }
}
```

Mainnet has no public KaleidoSwap API yet, so `KALEIDO_NETWORK=mainnet` requires the API URL of the
maker you trade with; the server refuses to start without it:

```json
{
  "mcpServers": {
    "kaleido": {
      "command": "npx",
      "args": ["-y", "-p", "kaleido-mcp", "-p", "@tetherto/wdk-wallet-spark", "kaleido-mcp"],
      "env": {
        "KALEIDO_NETWORK": "mainnet",
        "KALEIDOSWAP_API_URL": "https://maker.example.com",
        "RLN_NODE_URL": "http://localhost:3001",
        "WDK_SEED": "word1 word2 ... word12"
      }
    }
  }
}
```

Any other MCP client works the same way: run `npx -y kaleido-mcp` as a stdio server, or set `PORT`
for Streamable HTTP.

### Try it

Once connected, ask the agent something like:

- "List the assets and pairs on KaleidoSwap."
- "Quote 0.002 BTC to USDT."
- "What is my RLN node's pubkey and BTC balance?"
- "Create an RGB invoice to receive 10 USDT."

## Networks

`KALEIDO_NETWORK` picks a preset. Any variable you set explicitly overrides the preset.

| `KALEIDO_NETWORK` | KaleidoSwap API | `SPARK_NETWORK` | `LIQUID_NETWORK` | RGB proxy | RLN node |
| --- | --- | --- | --- | --- | --- |
| `signet` (default) | `https://api.signet.kaleidoswap.com` | `REGTEST` | `testnet` | `rpcs://proxy.iriswallet.com/0.2/json-rpc` | `http://localhost:3001` |
| `mainnet` | none — `KALEIDOSWAP_API_URL` is required | `MAINNET` | `mainnet` | none | `http://localhost:3001` |

The KaleidoSwap signet deployment runs on Mutinynet, the same network a `kaleido setup` node joins.
Spark has no signet; its public test network is `REGTEST`, which is what the signet preset selects.
Liquid has no signet either; the signet preset uses Liquid `testnet`.
The active network is printed to stderr at startup.

## Environment variables

All variables are optional. Empty values are treated as unset.

| Variable | Default | Description |
| --- | --- | --- |
| `KALEIDO_NETWORK` | `signet` | `signet` or `mainnet`; sets the defaults in the table above |
| `KALEIDOSWAP_API_URL` | per network | KaleidoSwap API base URL (no path suffix); required on mainnet |
| `KALEIDO_API_URL` | — | Alias for `KALEIDOSWAP_API_URL`; also passed to the `kaleido` CLI as `--api-url` |
| `RLN_NODE_URL` | `http://localhost:3001` | RGB Lightning Node HTTP API used by the `wdk_*` and swap tools |
| `RGB_PROXY_ENDPOINT` | per network | RGB proxy used by `wdk_create_rgb_invoice` / `wdk_send_asset` when no `transport_endpoints` are passed |
| `WDK_SEED` | — | BIP-39 mnemonic. Enables the Spark and WDK wallet tools (needs `@tetherto/wdk-wallet-spark` installed); without it they are not loaded at all |
| `SPARK_NETWORK` | per network | `MAINNET` or `REGTEST` |
| `LIQUID_MNEMONIC` | `WDK_SEED` | BIP-39 mnemonic for the Liquid wallet. Enables the `liquid_*` tools (needs `@kaleidorg/wdk-wallet-liquid` installed); without it (and without `WDK_SEED`) the Liquid modules are not loaded |
| `LIQUID_NETWORK` | per network | `mainnet`, `testnet` or `regtest` |
| `LIQUID_ESPLORA_URL` | network default | Esplora API base URL for the Liquid wallet |
| `SPARK_SCAN_API_KEY` | — | SparkScan API key |
| `SPARK_USDT_TOKEN` | — | Default Spark token identifier (`btkn1...`) for token tools |
| `KALEIDO_BIN` | auto-detect | Path to the `kaleido` CLI used by `kaleido_node_*` tools |
| `KALEIDO_NODE_URL` | — | Passed to the `kaleido` CLI as `--node-url` |
| `KALEIDO_ENV_NAME` | — | Default environment for `kaleido_node_up/stop/down/ps` |
| `KALEIDOSWAP_MAKER_URL` | signet maker | Boltz `/v2` maker for the `kaleidoswap_submarine_*` tools (default `https://maker.signet.kaleidoswap.com/v2`; no default on mainnet) |
| `KALEIDOSWAP_SWAP_DIR` | `~/.kaleido-mcp/swaps` | Where submarine swap records are kept. They hold what a refund needs besides the mnemonic: keep this directory |
| `PORT` | — | Serve Streamable HTTP on this port instead of stdio (`GET /health` for probes) |
| `MCP_AUTH_TOKEN` | — | Require `Authorization: Bearer <token>` in HTTP mode |

## Tools

62 tools (plus 28 legacy aliases) are always available; `WDK_SEED` adds 30 Spark and WDK wallet
tools and 10 Liquid wallet tools (the Liquid ones also come with `LIQUID_MNEMONIC` alone), provided their optional wallet packages are installed. The full, generated list with parameters is in [docs/TOOLS.md](docs/TOOLS.md) (regenerate with `npm run docs:tools`).

| Group | Prefix | Highlights |
| --- | --- | --- |
| KaleidoSwap DEX | `kaleidoswap_` | `get_assets`, `get_pairs`, `get_quote`, `atomic_init/execute/status`, `lsp_*` |
| KaleidoSwap submarine swaps | `kaleidoswap_submarine_` | pay a Lightning invoice from L-USDT/L-BTC: `pairs`, `create`, `fund`, `status` (needs `@kaleidorg/swap-sdk`, Node ≥ 22) |
| RGB Lightning Node | `wdk_` | balances, RGB issuance, assets and invoices, channels, payments, `atomic_taker` |
| Spark wallet | `spark_` | balance, Lightning and Spark invoices, deposits/withdrawals, token transfers (needs `WDK_SEED`) |
| Liquid wallet | `liquid_` | address, L-BTC and asset balances, UTXOs, history, L-BTC and asset sends (needs `LIQUID_MNEMONIC` or `WDK_SEED`) |
| WDK built-ins | camelCase | `getAddress`, `getBalance`, `transfer`, `sign`, `getCurrentPrice`, ... (needs `WDK_SEED`) |
| Node lifecycle | `kaleido_node_` | `up`, `stop`, `down`, `init`, `unlock`, `lock`, `status`, ... |
| Paid APIs | `mpp_`, `l402_`, `search_paid_apis` | challenge, pay, submit credential, discover |
| Market data | `l402_get_` | `price`, `market_data`, `ohlcv`, `sentiment` |

`rln_*` and bare `get_*` names are legacy aliases of the `wdk_*` and `l402_get_*` tools.

### Atomic swap flow

1. `kaleidoswap_get_quote` — returns an `rfq_id` valid for about a minute
2. `kaleidoswap_atomic_init` — returns `swapstring`, `payment_hash` and an `access_token`
3. `wdk_atomic_taker` — whitelists the swap HTLC on your node
4. `kaleidoswap_atomic_execute` — with your node pubkey from `wdk_get_node_info`
5. `kaleidoswap_atomic_status` — poll until `Succeeded`

The swap needs a Lightning channel with the KaleidoSwap node that can carry the asset you receive.
`kaleidoswap_lsp_quote_asset_channel` and `kaleidoswap_lsp_create_asset_channel` buy one.

Every RGB Lightning HTLC also carries 3,000 sat (the node's `rgb_htlc_min_msat`), so a BTC→asset swap of X sat needs
X + 3,000 sat of outbound and inbound for the asset bought; an asset→BTC swap of X sat needs the asset as outbound
and X + 3,000 sat of inbound. `kaleidoswap_atomic_init`, `wdk_atomic_taker` and `kaleidoswap_atomic_execute` check
this against your channels first and return the shortfall as an error instead of contacting the maker.

### Submarine swap flow (pay Lightning from Liquid)

These use the new Boltz `/v2`-shaped maker ([kaleidoswap-maker-rs](https://github.com/kaleidoswap/kaleidoswap-maker-rs))
through [`@kaleidorg/swap-sdk`](https://www.npmjs.com/package/@kaleidorg/swap-sdk), an optional peer that needs Node ≥ 22
(`npm i @kaleidorg/swap-sdk`). Only signet has a public maker today.

1. `kaleidoswap_submarine_pairs` — what can pay a Lightning invoice (live: `L-USDT → BTC`), limits and fees
2. `kaleidoswap_submarine_create { invoice, from_asset }` — opens the swap; returns the exact amount to lock. No funds move
3. `kaleidoswap_submarine_fund { swap_id }` — **spend**: locks that amount from the Liquid wallet. Takes only the swap id;
   amount, asset and address come from the stored swap
4. `kaleidoswap_submarine_status { swap_id }` — `transaction.claimed` means the invoice was paid

The per-swap refund key is derived from the wallet mnemonic and never leaves the server. Each swap's record is written
to `KALEIDOSWAP_SWAP_DIR` before it can be funded. If a funded swap fails, the funds stay in the lockup until refunded;
an L-USDT refund is built with swap-sdk from the mnemonic and that record (not yet exposed as a tool).

## RGB

RGB assets (such as USDT and XAUT) live on the RGB Lightning Node, so every RGB operation goes
through the `wdk_*` tools and needs `RLN_NODE_URL` to point at an unlocked node:

| Operation | Tool |
| --- | --- |
| Create free colored UTXOs | `wdk_create_utxos` |
| Issue your own asset (NIA token, CFA collectible, UDA/NFT) | `wdk_issue_asset` |
| List RGB assets held (NIA, UDA, CFA) | `wdk_list_assets` |
| Balance of one asset (settled, future, spendable, off-chain) | `wdk_get_asset_balance` |
| Receive an asset on-chain | `wdk_create_rgb_invoice` |
| Send an asset on-chain | `wdk_send_asset` |
| Sync pending transfers | `wdk_refresh_transfers` |
| Transfer history and status for one asset | `wdk_list_transfers` |
| Open a channel that carries an asset | `wdk_open_channel` with `asset_id` and `asset_amount` |
| See asset allocations per channel | `wdk_list_channels` |
| Swap BTC ↔ RGB over Lightning | atomic flow above (`RGB_LN` layer) |
| Buy a channel pre-loaded with an asset | `kaleidoswap_lsp_quote_asset_channel`, `kaleidoswap_lsp_create_asset_channel` |

`wdk_create_rgb_invoice` and `wdk_send_asset` use the network's RGB proxy (the same one the
`kaleido` CLI uses) unless you pass `transport_endpoints` or set `RGB_PROXY_ENDPOINT`. On mainnet there
is no default, so set one.

Issuing or receiving RGB on-chain needs free colored UTXOs on the node: fund it via `wdk_get_address`,
then call `wdk_create_utxos` (or run `kaleido wallet create-utxos`).

## Running a signet RGB Lightning Node

The [`kaleido` CLI](https://github.com/kaleidoswap/kaleido-cli) runs a Docker-based node on the
KaleidoSwap signet (Mutinynet) and listens on `http://localhost:3001` by default, which matches
`RLN_NODE_URL`'s default:

```bash
curl -fsSL https://raw.githubusercontent.com/kaleidoswap/kaleido-cli/master/install.sh | sh
kaleido setup          # creates and starts one node
kaleido node init      # once, sets the wallet password
kaleido node unlock    # after every restart
```

Get test coins from the faucet at <https://faucet.mutinynet.kaleidoswap.com>.

Once the CLI is installed, the agent can manage the node itself through the `kaleido_node_*` tools
(`kaleido_node_up`, `kaleido_node_unlock`, `kaleido_node_status`, ...).

## Development

```bash
npm ci
npm run build
npm test             # contract tests, no network or secrets needed
npm run docs:tools   # regenerate docs/TOOLS.md
npm run dev          # run from source with tsx
```

`kaleido-mcp` is a thin composition layer: domain logic belongs in
[`kaleido-sdk`](https://github.com/kaleidoswap/kaleido-sdk) and the WDK packages, not here.

## License

Apache-2.0
