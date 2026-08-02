import { useState, useCallback, useRef, useEffect } from 'react'
import logoImg from '@/imports/LOGO.jpeg'
import mrRockson from '@/imports/MR.ROCKSON.jpeg'
import mrsPatricia from '@/imports/MRS.PATRICIA.jpeg'
import mtnLogo from '@/imports/MTN_Ghana.jpg'
import supabase from "./config/supabaseClient"

// Whichever program the admin has marked active shows here automatically —
// no env var to update every time a new workshop is added. If more than one
// is active, the most recently created one wins.

type Screen = 'landing' | 'register' | 'confirming' | 'success'
type PaymentMethod = 'mtn' | 'telecel' | 'card' | 'airteltigo'

// ─── Workshop program (real data from the shared `programs` table) ───────────
interface WorkshopProgram {
  id: string
  name: string
  description: string | null
  price: number
  location: string | null
  date: string | null // ISO timestamp
}

interface ProgramFetchResult {
  program: WorkshopProgram | null
  // 'none' = fetch worked fine, there's just no active program right now (show the
  // friendly "come back later" screen). 'error' = the fetch itself failed (show the
  // generic error/refresh message).
  reason?: 'none' | 'error'
}

async function getWorkshopProgram(): Promise<ProgramFetchResult> {
  const { data, error } = await supabase
    .from('programs')
    .select('id, name, description, price, location, date')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('getWorkshopProgram error:', error)
    return { program: null, reason: 'error' }
  }
  if (!data) {
    console.log('No active program found — add one from the admin dashboard.')
    return { program: null, reason: 'none' }
  }
  return {
    program: {
      id: data.id,
      name: data.name,
      description: data.description,
      price: Number(data.price),
      location: data.location,
      date: data.date,
    },
  }
}

function formatProgramDate(iso: string | null): string {
  if (!iso) return 'Date to be announced'
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ─── Client lookup / registration (real data — shared `clients` + `payments`
// tables, the same ones the EdenPlus admin dashboard reads) ────────────────
// These never touch the tables directly from the browser — everything goes
// through small Edge Functions running with the service role, so a visitor
// can never query every client's contact info directly.

interface LookupResult {
  exists: boolean
  clientId?: string
  name?: string
  email?: string
  phone?: string
  ticketNumber?: string | null
  totalPaid?: number
}

async function clientLookup(opts: { email: string; phone: string; fullName: string; programId: string }): Promise<LookupResult> {
  const { data, error } = await supabase.functions.invoke('client-lookup', {
    body: { email: opts.email, phone: opts.phone, fullName: opts.fullName, programId: opts.programId },
  })
  if (error) {
    console.error('client-lookup invoke error:', error)
    throw new Error('Could not reach the server. Please check your connection and try again.')
  }
  return data as LookupResult
}

interface GetOrCreateResult {
  clientId: string
  ticketNumber: string | null
  totalPaid: number
  existingReference: string | null
}

async function clientGetOrCreate(opts: {
  name: string; email: string; phone: string; region: string; city: string; amount: number; programId: string
}): Promise<GetOrCreateResult> {
  const { data, error } = await supabase.functions.invoke('client-get-or-create', {
    body: { ...opts },
  })
  if (error) {
    console.error('client-get-or-create invoke error:', error)
    throw new Error('Something went wrong saving your registration. Please try again.')
  }
  if (data?.error) throw new Error(data.error)
  return data as GetOrCreateResult
}

interface PaymentStatusResult {
  status: 'pending' | 'paid' | 'overdue' | 'not-found'
  amount?: number
  name?: string
  email?: string
  ticketNumber?: string
  totalPaid?: number
}

async function getPaymentStatus(reference: string, programId: string): Promise<PaymentStatusResult> {
  const { data, error } = await supabase.functions.invoke('client-payment-status', {
    body: { reference, programId },
  })
  if (error) {
    console.error('client-payment-status invoke error:', error)
    throw new Error('Could not check your payment status.')
  }
  return data as PaymentStatusResult
}

// Normalizes a Ghanaian phone number into the MSISDN format MTN MoMo expects
// (country code, no leading 0, no +, no spaces) — e.g. "024 123 4567" -> "233241234567".
function toMsisdn(phone: string): string {
  let digits = phone.replace(/\D/g, '')
  if (digits.startsWith('0')) digits = '233' + digits.slice(1)
  else if (!digits.startsWith('233')) digits = '233' + digits
  return digits
}

// Asks a Supabase Edge Function to initiate an MTN MoMo "request to pay" —
// this pushes an approval prompt straight to the customer's phone. Uses the
// MoMo API subscription key / API user / API key server-side; none of that
// ever reaches the browser. Also creates the payment row server-side.
async function initiateMomoPayment(opts: {
  phone: string
  amount: number
  reference: string
  clientId: string
  programId: string
  payerMessage?: string
}): Promise<{ ok: true } | { error: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('momo-request-to-pay', {
      body: {
        phone: toMsisdn(opts.phone),
        amount: opts.amount,
        reference: opts.reference,
        clientId: opts.clientId,
        programId: opts.programId,
        payerMessage: opts.payerMessage ?? 'EdenPlus Workshop registration',
      },
    })
    if (error) {
      console.error('momo-request-to-pay invoke error:', error)
      return { error: 'Could not start the MoMo payment. Please try again.' }
    }
    if (data?.error) {
      console.error('momo-request-to-pay returned error:', data.error)
      return { error: data.error }
    }
    return { ok: true }
  } catch (err) {
    console.error('momo-request-to-pay exception:', err)
    return { error: 'Could not reach the payment server. Please try again.' }
  }
}

function generateIdempotencyKey(): string {
  return `epc-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

// ─── Success payload shared between screens ───────────────────────────────────
interface SuccessPayload {
  fullName: string
  email: string
  amountPaid: number
  totalPaid: number
  ticketNumber: string
}

// ─── No Active Program Screen ─────────────────────────────────────────────────
// Shown when the fetch to Supabase succeeds but no admin has an active
// workshop right now — this is a normal, expected state, not an error.
function NoProgramScreen() {
  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-4 py-10 font-sans">
      <div className="w-full max-w-sm text-center">
        <div className="flex justify-center mb-4">
          <img src={logoImg} alt="EdenPlus Education Consult logo" className="h-20 w-auto object-contain" />
        </div>
        <p className="text-[#5B2EE8] font-bold text-sm tracking-wide font-display uppercase leading-tight mb-0.5">
          EdenPlus Education Consult
        </p>
        <p className="text-gray-500 text-xs mb-8">The Cambridge Curriculum Expert</p>

        <div className="w-16 h-16 rounded-full bg-[#EDE9FD] flex items-center justify-center mx-auto mb-5">
          <svg className="w-8 h-8 text-[#5B2EE8]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3M3 11h18M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>

        <h2 className="text-xl font-bold text-gray-900 font-display mb-2">
          No Workshop Right Now
        </h2>
        <p className="text-gray-500 text-sm leading-relaxed mb-8">
          There's no active program open for registration at the moment.
          Please check back later — we'll have new workshop dates up soon!
        </p>

        <footer className="text-center text-[10px] text-gray-400">
          <p>©2026 Copyright, All Right Reserved</p>
          <p className="text-[#5B2EE8] cursor-pointer hover:underline">Privacy Policy</p>
          <p className="mt-1">Powered by DataLens</p>
        </footer>
      </div>
    </div>
  )
}

// ─── Landing Screen ───────────────────────────────────────────────────────────
function LandingScreen({ program, onRegister }: { program: WorkshopProgram; onRegister: () => void }) {
  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-start px-4 py-6 font-sans">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-2">
          <img src={logoImg} alt="EdenPlus Education Consult logo" className="h-20 w-auto object-contain" />
        </div>
        <div className="text-center mb-5">
          <p className="text-[#5B2EE8] font-bold text-sm tracking-wide font-display uppercase leading-tight">
            EdenPlus Education Consult
          </p>
          <p className="text-gray-500 text-xs mt-0.5">The Cambridge Curriculum Expert</p>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="rounded-xl overflow-hidden bg-gray-100 aspect-[3/4]">
            <img src={mrRockson} alt="Mr. Rockson" className="w-full h-full object-cover object-top" />
          </div>
          <div className="rounded-xl overflow-hidden bg-gray-100 aspect-[3/4]">
            <img src={mrsPatricia} alt="Mrs. Patricia" className="w-full h-full object-cover object-top" />
          </div>
        </div>

        <div className="space-y-3 mb-6">
          <DetailRow icon="🎓" label="Workshop" value={program.name} />
          <DetailRow icon="📍" label="Location" value={program.location ?? 'Venue to be announced'} />
          <DetailRow icon="📅" label="Date" value={formatProgramDate(program.date)} />
        </div>

        <div className="space-y-2 mb-6">
          <BenefitItem text="Gain practical tools for lesson planning and classroom management." />
          <BenefitItem text="Engage experts to solve sector challenges and drive institutional transformation." />
          <BenefitItem text="Get hands-on, interactive exposure to your specific subject" />
        </div>

        <button
          onClick={onRegister}
          className="w-full bg-[#5B2EE8] hover:bg-[#4320C4] active:scale-[0.98] transition-all text-white font-semibold py-3.5 rounded-lg text-sm tracking-wide font-display"
        >
          Register Now
        </button>
        <footer className="mt-8 text-center text-[10px] text-gray-400">
          <p>©2026 Copyright, All Right Reserved</p>
          <p className="text-[#5B2EE8] cursor-pointer hover:underline">Privacy Policy</p>
          <p className="mt-1">Powered by DataLens</p>
        </footer>
      </div>
    </div>
  )
}

function DetailRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="text-base leading-5">{icon}</span>
      <span className="text-gray-500 font-medium min-w-16">{label}:</span>
      <span className="text-gray-800">{value}</span>
    </div>
  )
}

function BenefitItem({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2">
      <svg className="w-4 h-4 mt-0.5 text-[#5B2EE8] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
      <p className="text-gray-600 text-xs leading-relaxed">{text}</p>
    </div>
  )
}

// ─── Register Screen ──────────────────────────────────────────────────────────
// Step 1: fill form  →  system detects returning client
// Step 2 (returning): enter ticket number to confirm
// Step 3: choose amount (preset or custom) + payment method → pay

type RegisterStep = 'form' | 'ticket-verify' | 'payment'

function RegisterScreen({ program, onBack, onAwaitingConfirmation }: {
  program: WorkshopProgram
  onBack: () => void
  onAwaitingConfirmation: (reference: string) => void
}) {
  const [step, setStep] = useState<RegisterStep>('form')
  const [form, setForm] = useState({ fullName: '', email: '', contact: '', region: '', town: '' })

  // Returning client state
  const [existingReg, setExistingReg] = useState<LookupResult | null>(null)
  const [ticketInput, setTicketInput] = useState('')
  const [ticketError, setTicketError] = useState('')
  const [ticketVerified, setTicketVerified] = useState(false)

  // Payment state
  const [partPayment, setPartPayment] = useState<number | null>(null)
  const [partDropdownOpen, setPartDropdownOpen] = useState(false)
  const [customAmount, setCustomAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('mtn')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [isDuplicate, setIsDuplicate] = useState(false)
  const [clientId, setClientId] = useState<string | null>(null)

  const ticketRef = useRef<HTMLInputElement>(null)

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value })),
  })

  const FULL_AMOUNT = program.price
  // Dynamic part-payment presets — roughly a quarter, half, and three
  // quarters of the program price, rounded to the nearest 10.
  const PART_AMOUNTS = [0.25, 0.5, 0.75].map(f => Math.round((FULL_AMOUNT * f) / 10) * 10)

  const remaining = existingReg?.exists
    ? Math.max(0, FULL_AMOUNT - (existingReg.totalPaid ?? 0))
    : FULL_AMOUNT
  const maxPayable = ticketVerified ? remaining : FULL_AMOUNT
  const customAmountNum = parseFloat(customAmount)
  const amountToPay = customAmount !== '' && !isNaN(customAmountNum)
    ? customAmountNum
    : (partPayment ?? (ticketVerified ? remaining : FULL_AMOUNT))

  // ── Step 1: form submitted ──
  const handleFormNext = async () => {
    if (!form.fullName || !form.email || !form.contact) {
      setError('Please fill in Full Name, Email, and Contact.')
      return
    }
    if (!/\S+@\S+\.\S+/.test(form.email)) {
      setError('Please enter a valid email address.')
      return
    }
    setError('')
    setLoading(true)

    let found: LookupResult
    try {
      found = await clientLookup({ email: form.email, phone: form.contact, fullName: form.fullName, programId: program.id })
    } catch (err: any) {
      console.error('Lookup error:', err)
      setError(err.message ?? 'Could not reach the server. Please check your connection and try again.')
      setLoading(false)
      return
    }
    setLoading(false)

    if (found.exists && (found.totalPaid ?? 0) < FULL_AMOUNT) {
      setExistingReg(found)
      setClientId(found.clientId ?? null)
      setStep('ticket-verify')
      setTimeout(() => ticketRef.current?.focus(), 100)
    } else if (found.exists && (found.totalPaid ?? 0) >= FULL_AMOUNT) {
      setIsDuplicate(true)
      setClientId(found.clientId ?? null)
      setStep('payment')
    } else {
      setStep('payment')
    }
  }

  // ── Step 2: verify ticket ──
  const handleTicketVerify = () => {
    if (!ticketInput.trim()) {
      setTicketError('Please enter your ticket number.')
      return
    }
    if (ticketInput.trim().toUpperCase() !== existingReg?.ticketNumber) {
      setTicketError('Ticket number does not match our records. Please check and try again.')
      return
    }
    setTicketError('')
    setTicketVerified(true)
    setForm(prev => ({
      ...prev,
      fullName: existingReg!.name ?? prev.fullName,
      email: existingReg!.email ?? prev.email,
      contact: existingReg!.phone ?? prev.contact,
    }))
    setStep('payment')
  }

  // ── Step 3: pay ──
  const handlePay = useCallback(async () => {
    if (isDuplicate) return
    setError('')

    if (customAmount !== '' && (isNaN(customAmountNum) || customAmountNum <= 0)) {
      setError('Please enter a valid payment amount.')
      return
    }
    if (customAmount !== '' && customAmountNum > maxPayable) {
      setError(`Amount cannot exceed your balance of ₵${maxPayable}.`)
      return
    }
    if (amountToPay <= 0) {
      setError('Please select or enter an amount to pay.')
      return
    }
    if (toMsisdn(form.contact).length !== 12) {
      setError('Please enter a valid Ghanaian MTN MoMo number (e.g. 024 123 4567).')
      return
    }

    setLoading(true)

    try {
      const result = await clientGetOrCreate({
        name: form.fullName,
        email: form.email,
        phone: form.contact,
        region: form.region,
        city: form.town,
        amount: amountToPay,
        programId: program.id,
      })

      const idempotencyKey = result.existingReference ?? generateIdempotencyKey()

      const momoResult = await initiateMomoPayment({
        phone: form.contact,
        amount: amountToPay,
        reference: idempotencyKey,
        clientId: result.clientId,
        programId: program.id,
      })

      if ('error' in momoResult) {
        setError(momoResult.error)
        setLoading(false)
        return
      }

      setLoading(false)
      onAwaitingConfirmation(idempotencyKey)
    } catch (err: any) {
      console.error('Payment error:', err)
      setError(err.message ?? 'Something went wrong. Please try again.')
      setLoading(false)
    }
  }, [form, amountToPay, customAmount, customAmountNum, maxPayable, isDuplicate])

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-start px-4 py-6 font-sans">
      <div className="w-full max-w-sm">

        {/* Back */}
        <button
          onClick={() => step === 'form' ? onBack() : setStep(step === 'payment' && !ticketVerified ? 'form' : step === 'ticket-verify' ? 'form' : 'ticket-verify')}
          className="flex items-center gap-1 text-gray-500 text-sm mb-4 hover:text-gray-800 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>

        {/* Step indicator */}
        <div className="flex items-center gap-1.5 mb-5">
          {(['form', 'ticket-verify', 'payment'] as RegisterStep[]).map((s, i) => {
            const steps: RegisterStep[] = existingReg ? ['form', 'ticket-verify', 'payment'] : ['form', 'payment']
            if (!existingReg && s === 'ticket-verify') return null
            const idx = steps.indexOf(s)
            const current = steps.indexOf(step)
            return (
              <div key={s} className="flex items-center gap-1.5">
                {i > 0 && existingReg && <div className={`h-px w-6 ${idx <= current ? 'bg-[#5B2EE8]' : 'bg-gray-200'}`} />}
                {i > 0 && !existingReg && s !== 'ticket-verify' && <div className={`h-px w-6 ${idx <= current ? 'bg-[#5B2EE8]' : 'bg-gray-200'}`} />}
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${idx < current ? 'bg-[#5B2EE8] text-white' : idx === current ? 'bg-[#5B2EE8] text-white ring-2 ring-[#c4b5fd]' : 'bg-gray-100 text-gray-400'}`}>
                  {idx < current ? '✓' : idx + 1}
                </div>
              </div>
            )
          })}
        </div>

        {/* ── STEP 1: Form ── */}
        {step === 'form' && (
          <>
            <h1 className="text-xl font-bold text-gray-900 font-display mb-5">Registration Form</h1>
            <div className="space-y-3 mb-6">
              <FormField label="Full Name:" id="fullName" type="text" placeholder="e.g. Kwame Mensah" {...field('fullName')} />
              <FormField label="Email:" id="email" type="email" placeholder="you@example.com" {...field('email')} />
              <FormField label="Contact:" id="contact" type="tel" placeholder="024 000 0000" {...field('contact')} />
              <div className="space-y-2">
                <label htmlFor="region" className="text-sm font-medium">Region:</label>
                <select
                  id="region"
                  value={form.region}
                  onChange={(e) => setForm({ ...form, region: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 p-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                >
                  <option value="">Select Region</option>
                  <option value="Ahafo">Ahafo</option>
                  <option value="Ashanti">Ashanti</option>
                  <option value="Bono">Bono</option>
                  <option value="Bono East">Bono East</option>
                  <option value="Central">Central</option>
                  <option value="Eastern">Eastern</option>
                  <option value="Greater Accra">Greater Accra</option>
                  <option value="North East">North East</option>
                  <option value="Northern">Northern</option>
                  <option value="Oti">Oti</option>
                  <option value="Savannah">Savannah</option>
                  <option value="Upper East">Upper East</option>
                  <option value="Upper West">Upper West</option>
                  <option value="Volta">Volta</option>
                  <option value="Western">Western</option>
                  <option value="Western North">Western North</option>
                </select>
              </div>
              <FormField label="Town:" id="town" type="text" placeholder="East Legon" {...field('town')} />
            </div>
            {error && <p className="mb-3 text-red-500 text-xs">{error}</p>}
            <button
              onClick={handleFormNext}
              disabled={loading}
              className="w-full bg-[#5B2EE8] hover:bg-[#4320C4] disabled:opacity-60 disabled:cursor-not-allowed transition-all text-white font-semibold py-3.5 rounded-lg text-sm font-display"
            >
              {loading ? 'Checking…' : 'Continue'}
            </button>
          </>
        )}

        {/* ── STEP 2: Ticket Verify ── */}
        {step === 'ticket-verify' && existingReg && (
          <>
            <h1 className="text-xl font-bold text-gray-900 font-display mb-2">Verify Your Ticket</h1>
            <p className="text-gray-500 text-sm mb-5">
              We found an existing registration for <span className="font-medium text-gray-800">{existingReg.name}</span>.
              Enter your ticket number to access your remaining balance of{' '}
              <span className="font-bold text-[#5B2EE8]">₵{Math.max(0, FULL_AMOUNT - (existingReg.totalPaid ?? 0))}</span>.
            </p>

            <div className="bg-[#EDE9FD] border border-[#c4b5fd] rounded-xl p-4 mb-5">
              <p className="text-xs text-[#5B2EE8] font-semibold mb-2">Your ticket number was sent to you after your first payment.</p>
              <label className="block text-xs text-gray-600 mb-1 font-medium">Ticket Number</label>
              <input
                ref={ticketRef}
                type="text"
                value={ticketInput}
                onChange={e => { setTicketInput(e.target.value.toUpperCase()); setTicketError('') }}
                placeholder="EP-000000"
                className="w-full border border-[#c4b5fd] bg-white rounded-md px-3 py-2.5 text-sm font-mono text-gray-900 placeholder-gray-300 focus:outline-none focus:border-[#5B2EE8] focus:ring-1 focus:ring-[#5B2EE8] tracking-wider uppercase"
              />
              {ticketError && <p className="mt-1.5 text-red-500 text-xs">{ticketError}</p>}
            </div>

            <button onClick={handleTicketVerify} className="w-full bg-[#5B2EE8] hover:bg-[#4320C4] text-white font-semibold py-3.5 rounded-lg text-sm font-display">
              Confirm Ticket
            </button>
          </>
        )}

        {/* ── STEP 3: Payment ── */}
        {step === 'payment' && (
          <>
            <h1 className="text-xl font-bold text-gray-900 font-display mb-1">Payment</h1>

            {ticketVerified && existingReg && (
              <div className="bg-[#EDE9FD] border border-[#c4b5fd] rounded-xl px-4 py-3 mb-4">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-gray-600">Already paid</span>
                  <span className="font-semibold text-gray-800">₵{existingReg.totalPaid ?? 0}</span>
                </div>
                <div className="flex justify-between items-center text-sm mt-1">
                  <span className="text-gray-600">Remaining balance</span>
                  <span className="font-bold text-[#5B2EE8]">₵{remaining}</span>
                </div>
                <div className="mt-1.5 pt-1.5 border-t border-[#c4b5fd] flex justify-between items-center text-xs">
                  <span className="text-gray-500">Ticket</span>
                  <span className="font-mono font-semibold text-[#4320C4] tracking-wider">{existingReg.ticketNumber}</span>
                </div>
              </div>
            )}

            {isDuplicate ? (
              <div className="my-4 p-4 bg-amber-50 border border-amber-200 rounded-xl">
                <p className="text-amber-800 text-sm font-medium text-center">
                  Full payment of ₵{FULL_AMOUNT} already received. No further payment is required.
                </p>
              </div>
            ) : (
              <>
                <div className="text-center my-3">
                  <span className="text-[#5B2EE8] font-bold text-2xl font-display">
                    ₵ {amountToPay.toFixed(2)}
                  </span>
                  {ticketVerified && (
                    <p className="text-xs text-gray-400 mt-0.5">of ₵{remaining} remaining balance</p>
                  )}
                </div>

                <div className="relative mb-3">
                  <button
                    type="button"
                    onClick={() => setPartDropdownOpen(v => !v)}
                    className="w-full flex items-center justify-between border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-700 bg-white hover:border-[#5B2EE8] transition-colors"
                  >
                    <span>{partPayment != null && customAmount === '' ? `Part payment — ₵${partPayment}` : 'Part payment (select preset)'}</span>
                    <svg className={`w-4 h-4 text-gray-400 transition-transform ${partDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {partDropdownOpen && (
                    <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
                      <button
                        onClick={() => { setPartPayment(null); setCustomAmount(''); setPartDropdownOpen(false) }}
                        className="w-full text-left px-4 py-2.5 text-sm text-gray-500 hover:bg-gray-50 border-b border-gray-100"
                      >
                        Pay full amount (₵{ticketVerified ? remaining : FULL_AMOUNT})
                      </button>
                      {PART_AMOUNTS.map(amount => (
                        <button
                          key={amount}
                          onClick={() => { setPartPayment(amount); setCustomAmount(''); setPartDropdownOpen(false) }}
                          className={`w-full text-left px-4 py-2.5 text-sm flex items-center justify-between hover:bg-[#EDE9FD] transition-colors ${partPayment === amount && customAmount === '' ? 'bg-[#EDE9FD] text-[#5B2EE8] font-semibold' : 'text-gray-700'}`}
                        >
                          <span>₵{amount} GHS</span>
                          {partPayment === amount && customAmount === '' && (
                            <svg className="w-4 h-4 text-[#5B2EE8]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="mb-4">
                  <label className="block text-xs text-gray-600 mb-1 font-medium">
                    Or enter a custom amount (GHS)
                    {ticketVerified && <span className="text-gray-400"> · max ₵{remaining}</span>}
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-semibold">₵</span>
                    <input
                      type="number"
                      min="1"
                      max={maxPayable}
                      step="0.01"
                      placeholder={`e.g. ${ticketVerified ? remaining : FULL_AMOUNT}`}
                      value={customAmount}
                      onChange={e => { setCustomAmount(e.target.value); setPartPayment(null) }}
                      className="w-full border border-gray-300 rounded-md pl-7 pr-3 py-2.5 text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:border-[#5B2EE8] focus:ring-1 focus:ring-[#5B2EE8] transition-colors"
                    />
                  </div>
                </div>

                <div className="mb-5 flex-col items-center text-center justify-center">
                  <p className="text-xs text-gray-500 mb-2 font-medium padding-top">Payment method</p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    <MethodChip
                     label="MTN" logo={mtnLogo}
                     bgColor="#FFD600"
                     selected={paymentMethod === 'mtn'}
                     onClick={() => setPaymentMethod('mtn')} />
                  </div>
                </div>
              </>
            )}

            {error && <p className="mb-3 text-red-500 text-xs">{error}</p>}

            {!isDuplicate && (
              <button
                onClick={handlePay}
                disabled={loading}
                className="w-full bg-[#5B2EE8] hover:bg-[#4320C4] active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed transition-all text-white font-semibold py-3.5 rounded-lg text-sm tracking-wide font-display"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Processing…
                  </span>
                ) : 'Pay Now'}
              </button>
            )}
            <p className="text-center text-[10px] text-gray-400 mt-1.5">You'll get a MoMo prompt on your phone to approve</p>
          </>
        )}

        <footer className="mt-8 text-center text-[10px] text-gray-400">
          <p>©2026 Copyright, All Right Reserved</p>
          <p className="text-[#5B2EE8] cursor-pointer hover:underline">Privacy Policy</p>
          <p className="mt-1">Powered by DataLens</p>
        </footer>
      </div>
    </div>
  )
}

// ─── Confirming Screen ────────────────────────────────────────────────────────
// Polls the client-payment-status Edge Function, which reads the same
// `payments` row the momo-callback / momo-poll-pending Edge Functions update
// after independently verifying with MTN — the browser never marks a
// payment paid itself.
const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 3 * 60 * 1000

function ConfirmingScreen({ reference, program, onConfirmed, onBack }: {
  reference: string
  program: WorkshopProgram
  onConfirmed: (payload: SuccessPayload) => void
  onBack: () => void
}) {
  const [status, setStatus] = useState<'polling' | 'timed-out' | 'error'>('polling')
  const [checking, setChecking] = useState(false)

  const checkStatus = useCallback(async () => {
    setChecking(true)
    try {
      const result = await getPaymentStatus(reference, program.id)
      if (result.status === 'paid') {
        onConfirmed({
          fullName: result.name ?? '',
          email: result.email ?? '',
          amountPaid: result.amount ?? 0,
          totalPaid: result.totalPaid ?? result.amount ?? 0,
          ticketNumber: result.ticketNumber ?? '',
        })
        return true
      }
    } catch (err) {
      console.error('Confirming-screen poll error:', err)
    } finally {
      setChecking(false)
    }
    return false
  }, [reference, program.id, onConfirmed])

  useEffect(() => {
    let cancelled = false
    const start = Date.now()

    const tick = async () => {
      if (cancelled) return
      const done = await checkStatus()
      if (done || cancelled) return
      if (Date.now() - start > POLL_TIMEOUT_MS) {
        setStatus('timed-out')
        return
      }
      setTimeout(tick, POLL_INTERVAL_MS)
    }
    tick()

    return () => { cancelled = true }
  }, [checkStatus])

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-4 py-10 font-sans">
      <div className="w-full max-w-sm text-center">
        {status === 'polling' && (
          <>
            <svg className="animate-spin w-10 h-10 text-[#5B2EE8] mx-auto mb-5" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <h2 className="text-lg font-bold text-gray-900 font-display mb-2">Waiting for MoMo approval…</h2>
            <p className="text-gray-500 text-sm leading-relaxed">
              Check your phone for an MTN MoMo prompt and enter your PIN to approve the payment.
              This page will update automatically once it's confirmed.
            </p>
          </>
        )}

        {status === 'timed-out' && (
          <>
            <div className="w-14 h-14 rounded-full bg-amber-50 flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">⏳</span>
            </div>
            <h2 className="text-lg font-bold text-gray-900 font-display mb-2">Still waiting on confirmation</h2>
            <p className="text-gray-500 text-sm leading-relaxed mb-5">
              If you approved the MoMo prompt, this can sometimes take a little longer to reflect.
              You can check again, or come back later — your ticket number will show your balance once it's confirmed.
            </p>
            <button
              onClick={async () => { setStatus('polling'); await checkStatus() }}
              disabled={checking}
              className="w-full bg-[#5B2EE8] hover:bg-[#4320C4] disabled:opacity-60 transition-all text-white font-semibold py-3.5 rounded-lg text-sm font-display mb-3"
            >
              {checking ? 'Checking…' : 'Check again'}
            </button>
          </>
        )}

        {status === 'error' && (
          <p className="text-red-500 text-sm mb-5">Something went wrong while checking your payment status.</p>
        )}

        <button onClick={onBack} className="text-gray-400 text-xs hover:text-gray-600 hover:underline mt-2">
          Back to home
        </button>
      </div>
    </div>
  )
}

function FormField({ label, id, type, placeholder, value, onChange }: {
  label: string; id: string; type: string; placeholder: string
  value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-gray-600 mb-1 font-medium">{label}</label>
      <input
        id={id} type={type} placeholder={placeholder} value={value} onChange={onChange}
        className="w-full border border-gray-300 rounded-md px-3 py-2.5 text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:border-[#5B2EE8] focus:ring-1 focus:ring-[#5B2EE8] transition-colors"
      />
    </div>
  )
}

function MethodChip({ label, color, textColor, logo, bgColor, selected, onClick }: {
  label: string; color?: string; textColor?: string; logo?: string; bgColor?: string
  selected: boolean; onClick: () => void
}) {
  if (logo) {
    return (
      <button
        onClick={onClick}
        aria-label={label}
        title={label}
        className={`flex items-center justify-center h-9 w-16 rounded-md border transition-all overflow-hidden ${
          selected ? 'ring-2 ring-[#5B2EE8] ring-offset-1 scale-105 border-transparent' : 'border-gray-200 opacity-75 hover:opacity-100'
        }`}
        style={{ backgroundColor: bgColor ?? '#ffffff' }}
      >
        <img src={logo} alt={label} className="max-h-6 max-w-12 object-contain" />
      </button>
    )
  }

  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${selected ? 'ring-2 ring-[#5B2EE8] ring-offset-1 scale-105' : 'opacity-75 hover:opacity-100'}`}
      style={{ backgroundColor: color, color: textColor }}
    >
      {label}
    </button>
  )
}

// ─── Success Screen ───────────────────────────────────────────────────────────
function SuccessScreen({ program, payload, onBack }: { program: WorkshopProgram; payload: SuccessPayload; onBack: () => void }) {
  const [copied, setCopied] = useState(false)
  const remaining = Math.max(0, program.price - payload.totalPaid)
  const isFullyPaid = remaining <= 0

  const copyTicket = () => {
    navigator.clipboard.writeText(payload.ticketNumber).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-start px-4 py-10 font-sans">
      <div className="w-full max-w-sm">

        <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 ${isFullyPaid ? 'bg-green-50' : 'bg-[#EDE9FD]'}`}>
          <svg className={`w-8 h-8 ${isFullyPaid ? 'text-green-500' : 'text-[#5B2EE8]'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>

        <h2 className="text-xl font-bold text-gray-900 font-display text-center mb-1">
          {isFullyPaid ? 'Payment Complete!' : 'Part Payment Received'}
        </h2>
        <p className="text-gray-500 text-sm text-center mb-5">
          {isFullyPaid
            ? `Your full registration fee of ₵${program.price} has been received.`
            : `₵${payload.amountPaid} received. Balance remaining: ₵${remaining}.`}
        </p>

        <div className="bg-[#EDE9FD] border border-[#c4b5fd] rounded-2xl p-5 mb-5">
          <p className="text-xs text-[#5B2EE8] font-semibold uppercase tracking-wider mb-1 text-center">
            Your Ticket Number
          </p>
          <div className="flex items-center justify-center gap-2 mt-1">
            <span className="text-2xl font-bold text-[#4320C4] font-display tracking-widest">
              {payload.ticketNumber}
            </span>
            <button onClick={copyTicket} title="Copy" className="p-1.5 rounded-md hover:bg-[#c4b5fd] transition-colors">
              {copied
                ? <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                : <svg className="w-4 h-4 text-[#5B2EE8]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
              }
            </button>
          </div>
          {!isFullyPaid && (
            <p className="text-[10px] text-[#5B2EE8] text-center mt-2 leading-relaxed">
              Save this number — you'll need it to complete your remaining balance of ₵{remaining}.
            </p>
          )}
        </div>

        <div className="bg-gray-50 rounded-xl p-4 mb-6 space-y-2 text-sm">
          <SummaryRow label="Amount paid now" value={`₵${payload.amountPaid}`} />
          <SummaryRow label="Total paid" value={`₵${payload.totalPaid}`} />
          <SummaryRow label="Full fee" value={`₵${program.price}`} />
          {!isFullyPaid && <SummaryRow label="Balance" value={`₵${remaining}`} highlight />}
          <div className="border-t border-gray-200 pt-2 space-y-2">
            <SummaryRow label="Workshop date" value={formatProgramDate(program.date)} />
            <SummaryRow label="Venue" value={program.location ?? 'To be announced'} />
          </div>
        </div>

        <button
          onClick={onBack}
          className="w-full bg-[#5B2EE8] hover:bg-[#4320C4] text-white font-semibold py-3.5 rounded-lg text-sm font-display transition-colors"
        >
          Back to Home
        </button>

        <footer className="mt-8 text-center text-[10px] text-gray-400">
          <p>©2026 Copyright, All Right Reserved</p>
          <p className="text-[#5B2EE8] cursor-pointer hover:underline">Privacy Policy</p>
          <p className="mt-1">Powered by DataLens</p>
        </footer>
      </div>
    </div>
  )
}

function SummaryRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-gray-500">{label}</span>
      <span className={`font-semibold ${highlight ? 'text-amber-600' : 'text-gray-800'}`}>{value}</span>
    </div>
  )
}

// ─── App root ─────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState<Screen>('landing')
  const [successPayload, setSuccessPayload] = useState<SuccessPayload | null>(null)
  const [pendingReference, setPendingReference] = useState<string | null>(null)
  const [program, setProgram] = useState<WorkshopProgram | null>(null)
  const [programStatus, setProgramStatus] = useState<'loading' | 'ready' | 'none' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    getWorkshopProgram().then(({ program: p, reason }) => {
      setProgram(p)
      if (p) setProgramStatus('ready')
      else if (reason === 'none') setProgramStatus('none')
      else {
        setProgramStatus('error')
        setLoadError('Could not load workshop details. Please refresh the page.')
      }
    })
  }, [])

  const handleAwaitingConfirmation = useCallback((reference: string) => {
    setPendingReference(reference)
    setScreen('confirming')
  }, [])

  const handleConfirmed = useCallback((payload: SuccessPayload) => {
    setSuccessPayload(payload)
    setScreen('success')
  }, [])

  if (programStatus === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 text-center font-sans">
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    )
  }

  if (programStatus === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 text-center font-sans">
        <p className="text-sm text-gray-500">{loadError}</p>
      </div>
    )
  }

  if (programStatus === 'none' || !program) {
    return <NoProgramScreen />
  }

  return (
    <div className="font-sans">
      {screen === 'landing' && <LandingScreen program={program} onRegister={() => setScreen('register')} />}
      {screen === 'register' && (
        <RegisterScreen
          program={program}
          onBack={() => setScreen('landing')}
          onAwaitingConfirmation={handleAwaitingConfirmation}
        />
      )}
      {screen === 'confirming' && pendingReference && (
        <ConfirmingScreen
          reference={pendingReference}
          program={program}
          onConfirmed={handleConfirmed}
          onBack={() => setScreen('landing')}
        />
      )}
      {screen === 'success' && successPayload && (
        <SuccessScreen program={program} payload={successPayload} onBack={() => setScreen('landing')} />
      )}
    </div>
  )
}
