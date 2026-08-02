// supabase/functions/momo-poll-pending/index.ts
//
// MTN MoMo callbacks aren't always delivered reliably in practice. This
// function is a safety net: call it on a schedule (every 1-2 minutes) and
// it re-checks every still-pending payment against MTN's real status, so a
// missed callback doesn't leave anyone stuck on the confirming screen
// forever. Uses the same reconcilePayment logic as momo-callback, so the
// same "never trust, always verify with MTN" rule applies here too.
//
// Deploy with (secured by a shared secret instead of Supabase JWT, since
// it's triggered by pg_cron, not a logged-in browser — see the header
// check below and supabase_schema.sql for the pg_cron setup):
//   supabase functions deploy momo-poll-pending --no-verify-jwt
//   supabase secrets set CRON_SECRET=some-long-random-string
//
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { readMomoEnv, reconcilePayment } from '../_shared/momo.ts'

// Only re-check payments created in roughly the last 24h — anything older
// that's still pending is stale and not worth hammering MTN's API for.
const LOOKBACK_HOURS = 24
// How many pending payments to reconcile per invocation, to keep each run fast.
const BATCH_LIMIT = 25

Deno.serve(async (req: Request) => {
  const CRON_SECRET = Deno.env.get('CRON_SECRET')
  if (CRON_SECRET && req.headers.get('x-cron-secret') !== CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 })
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const momoEnv = readMomoEnv()

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !momoEnv) {
    console.error('momo-poll-pending is missing required environment variables')
    return new Response('misconfigured', { status: 500 })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()

  const { data: pending, error } = await supabase
    .from('payments')
    .select('idempotency_key')
    .eq('status', 'pending')
    .gte('created_at', since)
    .limit(BATCH_LIMIT)

  if (error) {
    console.error('momo-poll-pending: could not list pending payments:', error)
    return new Response('error listing payments', { status: 500 })
  }

  const results: Record<string, string> = {}
  for (const row of pending ?? []) {
    try {
      results[row.idempotency_key] = await reconcilePayment(
        row.idempotency_key, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, momoEnv
      )
    } catch (err) {
      console.error(`momo-poll-pending: failed to reconcile ${row.idempotency_key}:`, err)
      results[row.idempotency_key] = 'error'
    }
  }

  return new Response(JSON.stringify({ checked: pending?.length ?? 0, results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
