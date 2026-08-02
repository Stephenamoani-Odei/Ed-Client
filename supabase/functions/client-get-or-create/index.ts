// supabase/functions/client-get-or-create/index.ts
//
// Called right before pushing an MTN MoMo prompt. Finds the matching client
// (same email → phone → name priority as client-lookup) or creates a new
// row in the shared `clients` table used by the admin dashboard. Also
// checks for an already-pending payment of the exact same amount, so a
// retry doesn't create a second parallel MoMo request.
//
// Deploy with: supabase functions deploy client-get-or-create --no-verify-jwt
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
    const { name, email, phone, region, city, programId, amount } = await req.json()
    if (!name || !email || !phone || !programId || !amount) {
      return json({ error: 'name, email, phone, programId, and amount are required' }, 400)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: 'Server is not configured' }, 500)
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey)

    const normalizedPhone = String(phone).replace(/\s+/g, '')

    let client = (await supabase.from('clients').select('*').eq('email', email).maybeSingle()).data
    if (!client) {
      client = (await supabase.from('clients').select('*').eq('phone', normalizedPhone).maybeSingle()).data
    }

    if (!client) {
      const { data: created, error: insertError } = await supabase
        .from('clients')
        .insert({ name, email, phone: normalizedPhone, region: region || null, city: city || null })
        .select('*')
        .single()
      if (insertError) {
        console.error('client-get-or-create insert error:', insertError)
        return json({ error: 'Could not save your registration. Please try again.' }, 500)
      }
      client = created
    }

    // Resume an existing pending payment for this exact amount rather than
    // starting a parallel MoMo request if the visitor retries.
    const { data: existingPending } = await supabase
      .from('payments')
      .select('idempotency_key')
      .eq('client_id', client.id)
      .eq('program_id', programId)
      .eq('amount', amount)
      .eq('status', 'pending')
      .maybeSingle()

    const { data: paidRows } = await supabase
      .from('payments')
      .select('amount')
      .eq('client_id', client.id)
      .eq('program_id', programId)
      .eq('status', 'paid')

    const totalPaid = (paidRows || []).reduce((sum: number, p: any) => sum + Number(p.amount), 0)

    return json({
      clientId: client.id,
      ticketNumber: client.ticket_number,
      totalPaid,
      existingReference: existingPending?.idempotency_key ?? null,
    })
  } catch (err) {
    console.error('client-get-or-create error:', err)
    return json({ error: 'Something went wrong. Please try again.' }, 500)
  }
})
