// supabase/functions/_shared/momo.ts
//
// Shared helper for talking to the MTN MoMo Collections API from Edge
// Functions. Imported via relative path by momo-request-to-pay,
// momo-callback, and momo-poll-pending.
//
// Required secrets (set with `supabase secrets set NAME=value`):
//   MOMO_SUBSCRIPTION_KEY   - Ocp-Apim-Subscription-Key for your Collections product
//   MOMO_API_USER           - the API user UUID you created for this subscription
//   MOMO_API_KEY            - the API key generated for that API user
//   MOMO_TARGET_ENVIRONMENT - "sandbox" while testing; MTN's assigned production
//                             environment name once live (e.g. "mtnghana")
//   MOMO_BASE_URL           - "https://sandbox.momodeveloper.mtn.com" for sandbox,
//                             or the production base URL MTN gives you
//   MOMO_CURRENCY           - "EUR" for sandbox (MTN sandbox only accepts EUR),
//                             "GHS" once you're on production
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export interface MomoEnv {
  subscriptionKey: string
  apiUser: string
  apiKey: string
  targetEnvironment: string
  baseUrl: string
  currency: string
}

export function readMomoEnv(): MomoEnv | null {
  const subscriptionKey = Deno.env.get('MOMO_SUBSCRIPTION_KEY')
  const apiUser = Deno.env.get('MOMO_API_USER')
  const apiKey = Deno.env.get('MOMO_API_KEY')
  const targetEnvironment = Deno.env.get('MOMO_TARGET_ENVIRONMENT')
  const baseUrl = Deno.env.get('MOMO_BASE_URL')
  const currency = Deno.env.get('MOMO_CURRENCY') ?? 'GHS'

  if (!subscriptionKey || !apiUser || !apiKey || !targetEnvironment || !baseUrl) {
    return null
  }
  return { subscriptionKey, apiUser, apiKey, targetEnvironment, baseUrl, currency }
}

// Fetches a fresh OAuth2 access token from the Collections auth endpoint.
// Tokens are short-lived (~1hr per MTN docs); simplest safe approach is to
// fetch a new one per call rather than trying to cache across invocations.
export async function getMomoAccessToken(env: MomoEnv): Promise<string> {
  const basicAuth = btoa(`${env.apiUser}:${env.apiKey}`)
  const res = await fetch(`${env.baseUrl}/collection/token/`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Ocp-Apim-Subscription-Key': env.subscriptionKey,
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`MoMo auth failed (${res.status}): ${text}`)
  }
  const data: any = await res.json()
  if (!data?.access_token) throw new Error('MoMo auth response missing access_token')
  return data.access_token as string
}

// Initiates a "request to pay" — pushes an approval prompt to the payer's
// phone. Returns nothing on success (202 Accepted); the referenceId you
// generated is how you look up its status afterwards.
export async function requestToPay(env: MomoEnv, opts: {
  referenceId: string
  amount: number // major units, e.g. GHS
  phoneMsisdn: string
  payerMessage: string
  payeeNote: string
  callbackUrl?: string
}): Promise<void> {
  const token = await getMomoAccessToken(env)

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'X-Reference-Id': opts.referenceId,
    'X-Target-Environment': env.targetEnvironment,
    'Ocp-Apim-Subscription-Key': env.subscriptionKey,
    'Content-Type': 'application/json',
  }
  if (opts.callbackUrl) headers['X-Callback-Url'] = opts.callbackUrl

  const res = await fetch(`${env.baseUrl}/collection/v1_0/requesttopay`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      amount: String(opts.amount),
      currency: env.currency,
      externalId: opts.referenceId,
      payer: { partyIdType: 'MSISDN', partyId: opts.phoneMsisdn },
      payerMessage: opts.payerMessage,
      payeeNote: opts.payeeNote,
    }),
  })

  if (res.status !== 202) {
    const text = await res.text().catch(() => '')
    throw new Error(`MoMo requesttopay failed (${res.status}): ${text}`)
  }
}

export type MomoStatus = 'PENDING' | 'SUCCESSFUL' | 'FAILED'

// Asks MTN directly for the true status of a request-to-pay transaction.
// This is what makes the flow trustworthy: we never take a callback's word
// for it, we always verify against MTN's own record.
export async function getRequestToPayStatus(env: MomoEnv, referenceId: string): Promise<{
  status: MomoStatus
  amount?: string
  reason?: string
}> {
  const token = await getMomoAccessToken(env)
  const res = await fetch(`${env.baseUrl}/collection/v1_0/requesttopay/${referenceId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Target-Environment': env.targetEnvironment,
      'Ocp-Apim-Subscription-Key': env.subscriptionKey,
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`MoMo status check failed (${res.status}): ${text}`)
  }
  const data: any = await res.json()
  return {
    status: data.status,
    amount: data.amount,
    reason: data.reason?.message ?? data.reason,
  }
}

// Checks a single payment's true status with MTN and, if MTN confirms it
// succeeded, marks it paid. This is the ONLY path that ever marks a payment
// paid — it always verifies against MTN's own API first, never trusts a
// caller's claim. Used by both momo-callback (triggered by MTN's callback)
// and momo-poll-pending (a scheduled fallback in case the callback never
// arrives, which is common with MoMo).
//
// Note: this writes to the SAME `payments` table the EdenPlus admin
// dashboard reads. The moment status becomes 'paid', a database trigger on
// that table automatically assigns the client a ticket number — there's
// nothing else this function needs to do to make that happen, and nothing
// admin-side needs to be told separately; it's the same row.
export async function reconcilePayment(
  reference: string,
  supabaseUrl: string,
  serviceRoleKey: string,
  momoEnv: MomoEnv
): Promise<'completed' | 'pending' | 'not-found' | 'failed'> {
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { data: payment, error: paymentError } = await supabase
    .from('payments')
    .select('*')
    .eq('idempotency_key', reference)
    .maybeSingle()

  if (paymentError) throw paymentError
  if (!payment) {
    console.warn('No matching payment row for MoMo reference:', reference)
    return 'not-found'
  }
  if (payment.status === 'paid') return 'completed' // already processed, idempotent

  const { status } = await getRequestToPayStatus(momoEnv, reference)

  if (status === 'FAILED') return 'failed'
  if (status !== 'SUCCESSFUL') return 'pending'

  const { error: updatePaymentError } = await supabase
    .from('payments')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('idempotency_key', reference)
  if (updatePaymentError) throw updatePaymentError

  return 'completed'
}
