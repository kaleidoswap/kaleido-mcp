# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: minor bumps may break).

## [0.4.1] - 2026-10-07

### Changed

- `wdk_send_asset` / `rln_send_asset` and `wdk_create_rgb_invoice` / `rln_create_rgb_invoice` accept a ticker
  (e.g. `USDT`, case-insensitive) in `asset_id`, resolved against the node's assets; a CFA asset, which has no
  ticker, matches by name. A value starting with `rgb:` is used as the asset ID. No match, or more than one, returns
  an error listing the candidates. The invoice result now echoes the resolved `asset_id`.

## [0.4.0] - 2026-10-07

### Added

- Submarine swaps on the Boltz `/v2` maker (kaleidoswap-maker-rs): pay a Lightning invoice from L-USDT or L-BTC on
  Liquid. `kaleidoswap_submarine_pairs`, `kaleidoswap_submarine_create`, `kaleidoswap_submarine_fund` (spend; takes only
  the swap id) and `kaleidoswap_submarine_status`, through the optional peer `@kaleidorg/swap-sdk` (Node ≥ 22). Refund
  keys derive from the wallet mnemonic; swap records are persisted in `KALEIDOSWAP_SWAP_DIR` before funding. New
  settings: `KALEIDOSWAP_MAKER_URL`, `KALEIDOSWAP_SWAP_DIR`.

### Fixed

- `wdk_issue_asset` / `rln_issue_asset` no longer echo a `ticker` for CFA assets, which have none.
- `wdk_list_transfers` / `rln_list_transfers`: `amount_raw` was taken from the first assignment, which
  for a send can be our own change. It is now the requested amount, or the sum received/issued, and
  `null` for sends. A new `assignments_raw` field lists every assignment value.

## [0.3.1] - 2026-10-06

### Changed

- `KALEIDO_NETWORK` now defaults to `signet`, the only network with a public KaleidoSwap API.
  `npx -y kaleido-mcp` with no configuration talks to `https://api.signet.kaleidoswap.com`.
- `KALEIDO_NETWORK=mainnet` no longer has a default KaleidoSwap API URL: set `KALEIDOSWAP_API_URL`
  (or `KALEIDO_API_URL`) or the server exits at startup with an error naming the variable. Spark and
  Liquid mainnet presets are unchanged.
- `@tetherto/wdk-wallet-spark` and `@kaleidorg/wdk-wallet-liquid` are now optional peer dependencies
  and are no longer installed with kaleido-mcp. A clean install drops from about 620 MB / 337 packages
  to about 290 MB / 257 packages; most of the remainder is the WDK MCP toolkit's runtime. To use the Spark or Liquid tools, install the package next to
  kaleido-mcp, e.g. `npx -y -p kaleido-mcp -p @tetherto/wdk-wallet-spark kaleido-mcp`. When a seed is
  set but the package is missing, the server starts without those tools and logs which package to
  install. The Docker image still ships both.
- Dropped the unused direct dependency on `@tetherto/wdk`.
- The Docker image no longer sets `KALEIDOSWAP_API_URL`; it follows `KALEIDO_NETWORK` like the npm package.

## [0.3.0] - 2026-10-06

### Breaking

- Removed the order-based swap tools: `kaleidoswap_place_order`,
  `kaleidoswap_get_order_status`, `kaleidoswap_get_open_orders`,
  `kaleidoswap_cancel_order` and `kaleidoswap_get_position`. The REST swap-order
  surface is gone from `kaleido-sdk`; use the atomic HTLC flow
  (`kaleidoswap_get_quote` → `kaleidoswap_atomic_init` → `wdk_atomic_taker` →
  `kaleidoswap_atomic_execute` → `kaleidoswap_atomic_status`).

### Added

- Consolidated the standalone wallet MCP servers into kaleido-mcp, which now supersedes
  `wdk-wallet-mcp` (RLN), `wdk-wallet-spark-mcp` and `wdk-wallet-liquid-mcp`; tool names are unchanged.
- RGB issuance tools `wdk_issue_asset` (NIA, CFA or UDA; the display amount is scaled by
  `precision`, invalid arguments return an `isError` result), `wdk_create_utxos` and
  `wdk_list_transfers`, each with an `rln_*` alias.
- Liquid wallet tools (`liquid_get_node_info`, `liquid_get_address`, `liquid_get_balance`,
  `liquid_get_asset_balance`, `liquid_list_assets`, `liquid_list_transactions`,
  `liquid_list_unspents`, `liquid_send_btc`, `liquid_send_asset`, `liquid_get_fee_rates`) backed
  by an in-process LWK wallet (`@kaleidorg/wdk-wallet-liquid`, adds about 10 MB of WebAssembly to
  the install). Enabled by `LIQUID_MNEMONIC` or, failing that, `WDK_SEED`; the modules are only
  loaded when one is set. `LIQUID_NETWORK` follows `KALEIDO_NETWORK` (`mainnet`, or `testnet` on
  signet) and `LIQUID_ESPLORA_URL` overrides the Esplora endpoint.
- `KALEIDO_NETWORK` preset (`mainnet` default, or `signet`). `signet` points the
  KaleidoSwap tools at `https://api.signet.kaleidoswap.com` and Spark at
  `REGTEST`. Explicit `KALEIDOSWAP_API_URL` / `SPARK_NETWORK` still win, and the
  active network is logged to stderr at startup. Unknown values exit with an error.
- `RGB_PROXY_ENDPOINT`, defaulting per network (signet: `rpcs://proxy.iriswallet.com/0.2/json-rpc`,
  the same proxy the `kaleido` CLI uses; mainnet: none).
- `KALEIDO_API_URL` is accepted as an alias for `KALEIDOSWAP_API_URL`.
- `kaleido_node_*` lifecycle tools (`list`, `up`, `stop`, `down`, `ps`,
  `status`, `info`, `use`, `init`, `unlock`, `lock`) that drive a local RGB
  Lightning Node through the `kaleido` CLI.
- Spark invoice tools: `spark_create_sats_invoice` and `spark_create_tokens_invoice` accept
  `sender_spark_address` and `expiry_minutes`; `spark_pay_invoice` and `spark_get_invoices` are the
  canonical names (`spark_pay_spark_invoice` / `spark_get_spark_invoices` remain as aliases), and
  `spark_pay_invoice` takes a per-invoice `amount` string (sats or token base units).
- `docs/TOOLS.md`, generated from the live tool registry by `npm run docs:tools`.
- CI workflow running build and contract tests on pull requests and `main`.
- `CHANGELOG.md` is shipped in the npm package.

### Fixed

- `wdk_create_rgb_invoice` sent an empty `transport_endpoints` list, producing invoices the payer
  could not deliver a consignment for. It and `wdk_send_asset` now fall back to `RGB_PROXY_ENDPOINT`
  when no endpoints are passed; explicit `transport_endpoints` still win.
- `spark_get_invoices` passed a bare array to the Spark SDK, which expects `{ invoices }`; Spark
  invoice results containing bigints no longer fail to serialise.
- `wdk_create_rgb_invoice` no longer returns a `usage` hint pointing at the removed order flow.

### Changed

- `kaleido-sdk` bumped to 0.1.18 (RGB Lightning Node 0.9.0 API).
- The Spark/WDK wallet modules are only loaded when `WDK_SEED` is set; seedless
  startup is roughly 45% faster.
- Empty environment variables are treated as unset, so the defaults apply.
- The MCP server now reports the package version instead of a hardcoded `1.0.0`.
- `@tetherto/wdk-mcp-toolkit` is pinned to a commit (no usable npm release yet).
- Contract tests are self-contained and no longer depend on files outside the repo.
- Tool descriptions no longer reference the removed order flow.
- README rewritten around `npx -y kaleido-mcp` with signet quickstart.
