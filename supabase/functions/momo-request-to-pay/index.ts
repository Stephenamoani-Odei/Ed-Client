// supabase/functions/momo-request-to-pay/index.ts
//
// Called by the client (via supabase.functions.invoke) to push an MTN MoMo
// approval prompt to the customer's phone. All MoMo credentials stay
// server-side here — the browser never sees them.
//
// Also creates the `payments` row (client_id, program_id, amount, status
// 'pending', idempotency_key) here, after MTN confirms the prompt was sent
// — so a failed MoMo call never leaves an orphaned pending row behind.
//
// Deploy with:
//   supabase functions deploy momo-request-to-pay --no-verify-jwt
// Secrets required — see supabase/functions/_shared/momo.ts for the list.
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { readMomoEnv, requestToPay } from '../_shared/momo.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { phone, amount, reference, payerMessage, clientId, programId } = await req.json()

    if (!phone || !amount || !reference || !clientId || !programId) {
      return json({ error: 'phone, amount, reference, clientId, and programId are required' }, 400)
    }
    const amountNum = Number(amount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return json({ error: 'amount must be a positive number' }, 400)
    }
    if (!/^\d{10,15}$/.test(phone)) {
      return json({ error: 'phone must be a normalized MSISDN (digits only, with country code)' }, 400)
    }

    const env = readMomoEnv()
    if (!env) {
      console.error('MoMo environment variables are not fully configured')
      return json({ error: 'Server is not configured for MoMo payments' }, 500)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: 'Server is not configured' }, 500)
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey)

    const callbackBase = Deno.env.get('MOMO_CALLBACK_URL')
    const callbackUrl = callbackBase ? `${callbackBase}?ref=${encodeURIComponent(reference)}` : undefined

    await requestToPay(env, {
      referenceId: reference,
      amount: amountNum,
      phoneMsisdn: phone,
      payerMessage: payerMessage ?? 'EdenPlus Workshop registration',
      payeeNote: 'EdenPlus Workshop registration',
      callbackUrl,
    })

    // Only create the pending row once MTN has accepted the prompt — avoids
    // an orphaned payment row if the MoMo call itself fails.
    const { error: insertError } = await supabase.from('payments').insert({
      client_id: clientId,
      program_id: programId,
      amount: amountNum,
      status: 'pending',
      idempotency_key: reference,
    })
    if (insertError) {
      console.error('momo-request-to-pay: failed to record pending payment:', insertError)
    }

    return json({ ok: true, referenceId: reference })
  } catch (err) {
    console.error('momo-request-to-pay error:', err)
    return json({ error: 'Could not start the MoMo payment. Please try again.' }, 502)
  }
})
