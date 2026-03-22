/**
 * MPP (Machine Payments Protocol) client.
 * Implements the Challenge -> Credential -> Receipt flow over HTTP.
 */

export type MppMethod = 'lightning' | 'tempo' | 'stripe' | 'card' | (string & {})
export type MppIntent = 'charge' | 'session' | (string & {})

/**
 * Parsed MPP challenge from an HTTP 402 `WWW-Authenticate` header.
 */
export interface MppChallenge {
  id: string
  /** @deprecated alias for `id` kept for backwards compatibility */
  challenge_id: string
  url: string
  method: MppMethod
  intent: MppIntent
  amount?: string
  currency?: string
  description?: string
  request?: string
  digest?: string
  invoice?: string
  macaroon?: string
  amount_msat?: number
  amount_sats?: number
  expires_at?: number
  raw_header?: string
}

export interface MppCredential {
  id: string
  /** @deprecated alias for `id` */
  challenge_id?: string
  method: MppMethod
  intent?: MppIntent
  preimage?: string
  macaroon?: string
  session_id?: string
  session_voucher?: string
}

export interface MppReceipt {
  receipt_id?: string
  paid_at?: string
  method?: string
  amount?: string
  currency?: string
  amount_msat?: number
}

export interface MppResourceResponse {
  ok: boolean
  status: number
  data: unknown
  receipt?: MppReceipt
  raw_receipt_header?: string
}

export interface MppProblemDetail {
  type: string
  title: string
  status: number
  detail?: string
}

export const MppErrorCode = {
  PaymentRequired: 'payment-required',
  PaymentInsufficient: 'payment-insufficient',
  PaymentExpired: 'payment-expired',
  VerificationFailed: 'verification-failed',
  MalformedCredential: 'malformed-credential',
  InvalidChallenge: 'invalid-challenge',
} as const

export class MppClient {
  async requestChallenge(url: string): Promise<MppChallenge> {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
    } catch (err) {
      throw new Error(`Cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (res.status !== 402) {
      throw new Error(
        `Expected HTTP 402 from ${url}, got ${res.status}. This resource may not be MPP-protected.`
      )
    }

    const authHeader = res.headers.get('WWW-Authenticate')
    if (!authHeader) {
      throw new Error(`HTTP 402 received but no WWW-Authenticate header at ${url}`)
    }

    return this.parseChallenge(url, authHeader)
  }

  async submitCredential(url: string, credential: MppCredential): Promise<MppResourceResponse> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Payment-Authorization': this.buildPaymentAuthHeader(credential),
    }

    if (credential.macaroon && credential.preimage) {
      headers.Authorization = `L402 ${credential.macaroon}:${credential.preimage}`
    }

    const res = await fetch(url, { method: 'GET', headers })

    let data: unknown
    try {
      const body = await res.text()
      data = body ? JSON.parse(body) : {}
    } catch {
      data = null
    }

    const receiptHeader = res.headers.get('Payment-Receipt')
    const receipt = receiptHeader ? this.parseReceipt(receiptHeader) : undefined

    return {
      ok: res.ok,
      status: res.status,
      data,
      receipt,
      raw_receipt_header: receiptHeader ?? undefined,
    }
  }

  buildLightningCredential(challenge: MppChallenge, preimage: string): MppCredential {
    return {
      id: challenge.id,
      challenge_id: challenge.id,
      method: 'lightning',
      intent: challenge.intent,
      preimage,
      macaroon: challenge.macaroon,
    }
  }

  serializeCredential(credential: MppCredential): string {
    return JSON.stringify(credential)
  }

  deserializeCredential(raw: string): MppCredential {
    try {
      return JSON.parse(raw) as MppCredential
    } catch {
      throw new Error('Invalid credential format. Expected JSON string from wdk_mpp_pay.')
    }
  }

  parseChallenge(url: string, header: string): MppChallenge {
    const stripped = header.replace(/^Payment\s+/i, '').replace(/^L402\s+/i, '')

    const params: Record<string, string> = {}
    for (const match of stripped.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) {
      params[match[1]] = match[2] ?? match[3]
    }

    const method = (params.method ?? 'lightning') as MppMethod
    const intent = (params.intent ?? 'charge') as MppIntent
    const id = params.id ?? params.challenge_id ?? params.nonce ?? this.randomId()

    let invoice: string | undefined
    let macaroon: string | undefined
    let amountMsat: number | undefined

    if (params.request) {
      try {
        const decoded = JSON.parse(this.base64urlDecode(params.request)) as Record<string, unknown>
        invoice = (decoded.invoice ?? decoded.bolt11) as string | undefined
        macaroon = (decoded.macaroon ?? decoded.token) as string | undefined
        if (decoded.amount_msat) amountMsat = Number(decoded.amount_msat)
      } catch {
        // Some servers use a non-JSON request payload.
      }
    }

    invoice ??= params.invoice
    macaroon ??= params.macaroon ?? params.token

    if (!amountMsat && params.amount) {
      const amount = parseFloat(params.amount)
      const currency = (params.currency ?? 'sat').toLowerCase()
      if (currency === 'sat' || currency === 'sats') amountMsat = amount * 1_000
      else if (currency === 'msat' || currency === 'msats') amountMsat = amount
      else if (currency === 'btc') amountMsat = Math.round(amount * 1e11)
    }

    const amountSats = amountMsat ? Math.ceil(amountMsat / 1000) : undefined

    return {
      id,
      challenge_id: id,
      url,
      method,
      intent,
      amount: params.amount,
      currency: params.currency,
      description: params.description,
      request: params.request,
      digest: params.digest,
      invoice,
      macaroon,
      amount_msat: amountMsat,
      amount_sats: amountSats,
      expires_at: params.expires_at ? parseInt(params.expires_at, 10) : undefined,
      raw_header: header,
    }
  }

  private buildPaymentAuthHeader(credential: MppCredential): string {
    const id = credential.id ?? credential.challenge_id ?? ''
    const parts = [
      `Payment id="${id}"`,
      `method="${credential.method}"`,
    ]

    if (credential.intent) parts.push(`intent="${credential.intent}"`)
    if (credential.preimage) parts.push(`preimage="${credential.preimage}"`)
    if (credential.macaroon) parts.push(`macaroon="${credential.macaroon}"`)
    if (credential.session_id) parts.push(`session_id="${credential.session_id}"`)
    if (credential.session_voucher) parts.push(`voucher="${credential.session_voucher}"`)

    return parts.join(', ')
  }

  private parseReceipt(header: string): MppReceipt {
    try {
      if (header.trim().startsWith('{')) {
        return JSON.parse(header) as MppReceipt
      }

      const params: Record<string, string> = {}
      for (const match of header.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) {
        params[match[1]] = match[2] ?? match[3]
      }

      return {
        receipt_id: params.receipt_id,
        paid_at: params.paid_at,
        method: params.method,
        amount: params.amount,
        currency: params.currency,
      }
    } catch {
      return {}
    }
  }

  private base64urlDecode(input: string): string {
    const base64 = input.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=')
    return Buffer.from(padded, 'base64').toString('utf8')
  }

  private randomId(): string {
    return Math.random().toString(36).substring(2, 12)
  }
}
