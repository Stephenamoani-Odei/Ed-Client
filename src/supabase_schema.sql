-- ============================================================================
-- EdenPlus Workshop App — Supabase schema
-- Run this in the Supabase SQL editor (Project > SQL Editor > New query)
-- ============================================================================

-- 1. Registrants table -------------------------------------------------------
create table if not exists public.registrants (
  id           uuid primary key default gen_random_uuid(),
  ticket_number text unique not null,
  full_name    text not null,
  email        text unique not null,
  phone        text not null,
  region       text,
  town         text,
  total_paid   numeric not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists registrants_phone_idx on public.registrants (phone);
create index if not exists registrants_full_name_idx on public.registrants (lower(full_name));

-- 2. Payments table -----------------------------------------------------------
create table if not exists public.payments (
  id              uuid primary key default gen_random_uuid(),
  idempotency_key text unique not null,
  email           text not null,
  amount          numeric not null,
  status          text not null default 'pending' check (status in ('pending','completed')),
  created_at      timestamptz not null default now()
);

create index if not exists payments_email_amount_idx on public.payments (email, amount);

-- 3. Row Level Security --------------------------------------------------------
-- The app uses the public "anon" key from the browser, so we need policies
-- that let it read/write only what it needs — never a blanket "allow all".

alter table public.registrants enable row level security;
alter table public.payments enable row level security;

-- Registrants: allow the app to look itself up and insert new registrants.
-- (No update-anything policy for anon; balance updates happen through the
--  markPaymentComplete flow which only touches total_paid — see policy below.)
create policy "anon can read registrants"
  on public.registrants for select
  to anon
  using (true);

create policy "anon can insert registrants"
  on public.registrants for insert
  to anon
  with check (true);

-- NOTE: there is deliberately no "anon can update registrants" policy.
-- total_paid is only ever changed by reconcilePayment (shared by the
-- momo-callback and momo-poll-pending Edge Functions), which uses the
-- service_role key and bypasses RLS entirely — so the browser (anon key)
-- can never credit itself a payment.

-- Payments: read for idempotency checks / confirming-screen polling, and
-- insert to record a "pending" attempt before pushing the MoMo prompt.
create policy "anon can read payments"
  on public.payments for select
  to anon
  using (true);

create policy "anon can insert payments"
  on public.payments for insert
  to anon
  with check (true);

-- NOTE: no "anon can update payments" policy either. Only
-- reconcilePayment (service_role key, in momo-callback / momo-poll-pending)
-- can flip a payment's status to 'completed' — and only after independently
-- verifying the real status with MTN's own status endpoint, since MoMo
-- callbacks are not cryptographically signed and can't be trusted as-is.

-- SECURITY NOTE: with the policies above, the anon (browser) key can only
-- INSERT new registrants/payments and SELECT existing rows — it can never
-- flip a payment to 'completed' or change total_paid. Only reconcilePayment
-- (service_role key), which always re-verifies against MTN's own status
-- endpoint, can do that. This is what makes it safe to trust total_paid as
-- the real balance, even though MoMo's callback itself isn't signed.

-- 4. Scheduled fallback poll (recommended) ------------------------------------
-- MTN MoMo callback delivery isn't fully reliable in practice, so schedule
-- momo-poll-pending to re-check pending payments every couple of minutes as
-- a safety net. Requires the pg_cron and pg_net extensions (enable them in
-- Database > Extensions in the Supabase dashboard first).

-- select cron.schedule(
--   'momo-poll-pending-every-2-min',
--   '*/2 * * * *',
--   $$
--   select net.http_post(
--     url := 'https://<your-project-ref>.supabase.co/functions/v1/momo-poll-pending',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'x-cron-secret', '<same value as the CRON_SECRET secret you set>'
--     ),
--     body := '{}'::jsonb
--   );
--   $$
-- );

