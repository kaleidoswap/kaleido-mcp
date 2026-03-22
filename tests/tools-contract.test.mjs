import test from 'node:test'
import { assertHasAllTools, listToolNames } from './mcp-contract-test-utils.mjs'

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

test('kaleido-mcp includes the canonical focused-server contracts and legacy aliases', async () => {
  const tools = await listToolNames({
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      WDK_SEED: TEST_MNEMONIC,
      SPARK_NETWORK: 'REGTEST',
      RLN_NODE_URL: 'http://localhost:3001',
      KALEIDOSWAP_API_URL: 'https://api.kaleidoswap.com',
    },
  })

  assertHasAllTools(tools, [
    'kaleidoswap_get_quote',
    'kaleidoswap_place_order',
    'wdk_get_node_info',
    'wdk_get_balances',
    'wdk_mpp_pay',
    'spark_get_balance',
    'spark_get_address',
    'spark_transfer_token',
    'l402_get_price',
    'l402_get_market_data',
    'mpp_request_challenge',
    'search_paid_apis',
    'rln_get_node_info',
    'rln_mpp_pay',
    'get_price',
    'get_market_data',
  ])
})
