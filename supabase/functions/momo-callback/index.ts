// supabase/functions/momo-callback/index.ts
//
// MTN calls this when a request-to-pay transaction changes status (if you
// passed X-Callback-Url on the original request). IMPORTANT: unlike
// Paystack, MTN MoMo callbacks are NOT cryptographically signed — anyone
// who guesses this URL could POST a fake "SUCCESSFUL" body. So this
// function never trusts the callback body's status directly. Instead it
// treats the callback purely as a "check now" trigger, and always asks
// MTN's own status endpoint (via reconcilePayment) for the real,
// authoritative status before crediting anything.
//
// The callback URL is configured automatically by momo-request-to-pay,
// which appends ?ref=<reference> — see MOMO_CALLBACK_URL in _shared/momo.ts.
//
// Deploy with (MTN won't send a Supabase auth header):
//   supabase functions deploy momo-callback --no-verify-jwt
//
import { readMomoEnv, reconcilePayment } from '../_shared/momo.ts'

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  // Read (and discard) the body — deliberately not trusted. It exists only
  // so MTN gets a clean 200 response for a well-formed callback delivery.
  await req.text().catch(() => '')

  const url = new URL(req.url)
  const reference = url.searchParams.get('ref')
  if (!reference) {
    console.warn('momo-callback received without a ?ref= reference')
    return new Response('ok', { status: 200 })
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const momoEnv = readMomoEnv()

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !momoEnv) {
    console.error('momo-callback is missing required environment variables')
    return new Response('ok', { status: 200 })
  }

  try {
    const result = await reconcilePayment(reference, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, momoEnv)
    console.log(`momo-callback: reference ${reference} -> ${result}`)
  } catch (err) {
    console.error('momo-callback reconcile error:', err)
  }

  return new Response('ok', { status: 200 })
})
