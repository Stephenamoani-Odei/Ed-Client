// supabase/functions/client-payment-status/index.ts
//
// Polled by the confirming screen while waiting for MTN MoMo approval. Once
// the payment is 'paid' (set by reconcilePayment in momo-callback /
// momo-poll-pending, which always re-verifies with MTN first), this also
// returns the client's ticket number and running total — by then the
// database trigger has already assigned the ticket number automatically.
//
// Deploy with: supabase functions deploy client-payment-status --no-verify-jwt
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
    const { reference, programId } = await req.json()
    if (!reference) return json({ error: 'reference is required' }, 400)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: 'Server is not configured' }, 500)
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey)

    const { data: payment, error } = await supabase
      .from('payments')
      .select('*')
      .eq('idempotency_key', reference)
      .maybeSingle()

    if (error) throw error
    if (!payment) return json({ status: 'not-found' })
    if (payment.status !== 'paid') return json({ status: payment.status })

    const { data: client } = await supabase
      .from('clients')
      .select('*')
      .eq('id', payment.client_id)
      .single()

    const { data: paidRows } = await supabase
      .from('payments')
      .select('amount')
      .eq('client_id', payment.client_id)
      .eq('program_id', programId ?? payment.program_id)
      .eq('status', 'paid')

    const totalPaid = (paidRows || []).reduce((sum: number, p: any) => sum + Number(p.amount), 0)

    return json({
      status: 'paid',
      amount: Number(payment.amount),
      name: client?.name ?? '',
      email: client?.email ?? '',
      ticketNumber: client?.ticket_number ?? '',
      totalPaid,
    })
  } catch (err) {
    console.error('client-payment-status error:', err)
    return json({ error: 'Something went wrong checking your payment.' }, 500)
  }
})
