/**
 * MPP / L402 / 402index.io tools — payment-gated API access + discovery.
 */
import { z } from 'zod'
import type { WdkMcpServer } from '@tetherto/wdk-mcp-toolkit'
import { MppClient } from '../mpp-client.js'

export function registerMppTools(server: WdkMcpServer): void {
  const mpp = new MppClient()

  // -----------------------------------------------------------------------
  server.tool('mpp_request_challenge',
    'Probe an MPP-protected URL and return the payment challenge. If server returns HTTP 402, parses WWW-Authenticate and returns the Lightning invoice, challenge_id, and amount. After this, use rln_mpp_pay or spark_mpp_pay to settle, then mpp_submit_credential to access the resource.',
    { url: z.string().describe('URL of the MPP-protected resource') },
    async ({ url }) => {
      try {
        const challenge = await mpp.requestChallenge(url)
        return t(JSON.stringify({
          ...challenge,
          next_step: challenge.invoice
            ? 'Pay invoice via wdk_mpp_pay (RLN) or spark_mpp_pay (Spark), then call mpp_submit_credential'
            : 'No Lightning invoice in challenge — check method',
        }, null, 2))
      } catch (err) {
        return t(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2))
      }
    })

  // -----------------------------------------------------------------------
  server.tool('mpp_submit_credential',
    'Submit an MPP payment credential to access a protected resource. Call after rln_mpp_pay or spark_mpp_pay returns a credential JSON. Returns the resource data and a receipt.',
    {
      url: z.string().describe('Same URL used in mpp_request_challenge'),
      credential: z.string().describe('Credential JSON string from rln_mpp_pay or spark_mpp_pay'),
    },
    async ({ url, credential: credStr }) => {
      try {
        const cred = mpp.deserializeCredential(credStr)
        const result = await mpp.submitCredential(url, cred)
        return t(JSON.stringify({ ok: result.ok, status: result.status, receipt: result.receipt ?? null, data: result.data }, null, 2))
      } catch (err) {
        return t(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2))
      }
    })

  // -----------------------------------------------------------------------
  server.tool('mpp_parse_challenge_header',
    'Parse a raw WWW-Authenticate header from an HTTP 402 response into a structured MPP challenge. Use when you have the raw header and need to extract invoice/challenge_id without a new HTTP request.',
    {
      url: z.string().describe('URL that issued the 402'),
      www_authenticate: z.string().describe('Raw value of the WWW-Authenticate header'),
    },
    async ({ url, www_authenticate }) => {
      try { return t(JSON.stringify(mpp.parseChallenge(url, www_authenticate), null, 2)) }
      catch (err) { return t(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2)) }
    })

  // -----------------------------------------------------------------------
  server.tool('l402_request_challenge',
    'Request an L402 Lightning challenge for a premium endpoint (legacy L402 protocol). Returns a BOLT11 invoice and macaroon. After paying with rln_pay_invoice, call l402_fetch_resource with the preimage.',
    {
      resource_url: z.string().describe('URL of the L402-protected resource'),
      price_sats: z.number().int().positive().optional().describe('Max price in sats willing to pay (default: 10)'),
    },
    async ({ resource_url, price_sats = 10 }) => {
      // Simple HEAD probe to extract L402 challenge
      try {
        const res = await fetch(resource_url, { method: 'GET', signal: AbortSignal.timeout(8_000) })
        if (res.status === 402) {
          const wwwAuth = res.headers.get('WWW-Authenticate') ?? ''
          const challenge = mpp.parseChallenge(resource_url, wwwAuth)
          return t(JSON.stringify({ ...challenge, price_sats, next_step: 'Pay invoice via rln_pay_invoice, then call l402_fetch_resource with preimage as token' }, null, 2))
        }
        return t(JSON.stringify({ info: `Server returned ${res.status} — may not require payment`, resource_url }, null, 2))
      } catch (err) {
        return t(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2))
      }
    })

  // -----------------------------------------------------------------------
  server.tool('l402_fetch_resource',
    'Fetch an L402-protected resource using a paid Bearer token (format: "macaroon:preimage"). Call after paying the L402 invoice.',
    {
      resource_url: z.string(),
      token: z.string().describe('L402 Bearer token in format "macaroon:preimage"'),
    },
    async ({ resource_url, token }) => {
      try {
        const res = await fetch(resource_url, { headers: { Authorization: `L402 ${token}` }, signal: AbortSignal.timeout(10_000) })
        const body = await res.text()
        let data: unknown
        try { data = JSON.parse(body) } catch { data = body }
        return t(JSON.stringify({ status: res.status, data }, null, 2))
      } catch (err) {
        return t(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2))
      }
    })

  // -----------------------------------------------------------------------
  server.tool('search_paid_apis',
    'Search the 402index.io directory for payment-gated APIs (L402/MPP/x402). Returns endpoint URLs, pricing in sats, health status, and protocol type — ready to call via mpp_request_challenge. Use to discover premium Bitcoin data feeds, on-chain analytics, and AI services payable with Lightning micropayments.',
    {
      query: z.string().optional().describe('Search keyword (e.g. "bitcoin price", "on-chain analytics", "sentiment")'),
      protocol: z.enum(['L402', 'x402', 'MPP']).optional().describe('L402=Lightning, MPP=Stripe/Tempo, x402=Base/Solana'),
      category: z.string().optional().describe('Category filter (e.g. "finance", "crypto", "ai", "data")'),
      health: z.enum(['healthy', 'degraded', 'unknown']).optional(),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default: 10)'),
    },
    async ({ query, protocol, category, health, limit = 10 }) => {
      try {
        const params = new URLSearchParams()
        if (query)    params.set('search', query)
        if (protocol) params.set('protocol', protocol)
        if (category) params.set('category', category)
        if (health)   params.set('health', health)
        params.set('limit', String(limit))
        const res = await fetch(`https://402index.io/api/v1/services?${params}`, {
          headers: { Accept: 'application/json', 'User-Agent': 'kaleido-mcp/1.0' },
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) return t(JSON.stringify({ error: `402index.io returned ${res.status}` }, null, 2))
        const data = await res.json() as { services?: Array<Record<string, unknown>>; total?: number }
        const services = (data.services ?? []).map(s => ({
          id: s.id, name: s.name, description: s.description, url: s.url,
          protocol: s.protocol, price_usd: (s.pricing as Record<string, unknown> | undefined)?.usd ?? null,
          price_sats: (s.pricing as Record<string, unknown> | undefined)?.sats ?? null,
          category: s.category, health: s.health,
        }))
        return t(JSON.stringify({
          total_available: data.total ?? services.length,
          returned: services.length, services,
          usage: 'For L402/MPP: call mpp_request_challenge → wdk_mpp_pay or spark_mpp_pay → mpp_submit_credential',
        }, null, 2))
      } catch (err) {
        return t(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2))
      }
    })
}

const t = (content: string) => ({ content: [{ type: 'text' as const, text: content }] })
