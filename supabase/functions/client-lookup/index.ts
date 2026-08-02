// supabase/functions/client-lookup/index.ts
//
// Read-only. Called by the client site (public, no login) to check whether
// someone registering has an existing record — matched by email, then
// phone, then name, same priority as before. Uses the service role
// internally so the browser never gets direct table access to `clients`.
//
// Deploy with: supabase functions deploy client-lookup --no-verify-jwt
// (no-verify-jwt because this is called by anonymous website visitors, not
// logged-in admins — there's no Supabase session to verify here.)
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
    const { email, phone, fullName, programId } = await req.json()
    if (!programId) return json({ error: 'programId is required' }, 400)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: 'Server is not configured' }, 500)
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey)

    let client = null

    if (email) {
      const { data } = await supabase.from('clients').select('*').eq('email', email).maybeSingle()
      client = data
    }
    if (!client && phone) {
      const normalizedPhone = String(phone).replace(/\s+/g, '')
      const { data } = await supabase.from('clients').select('*').eq('phone', normalizedPhone).maybeSingle()
      client = data
    }
    if (!client && fullName) {
      const { data } = await supabase.from('clients').select('*').ilike('name', fullName).maybeSingle()
      client = data
    }

    if (!client) return json({ exists: false })

    const { data: paidRows } = await supabase
      .from('payments')
      .select('amount')
      .eq('client_id', client.id)
      .eq('program_id', programId)
      .eq('status', 'paid')

    const totalPaid = (paidRows || []).reduce((sum: number, p: any) => sum + Number(p.amount), 0)

    return json({
      exists: true,
      clientId: client.id,
      name: client.name,
      email: client.email,
      phone: client.phone,
      ticketNumber: client.ticket_number,
      totalPaid,
    })
  } catch (err) {
    console.error('client-lookup error:', err)
    return json({ error: 'Something went wrong. Please try again.' }, 500)
  }
})
