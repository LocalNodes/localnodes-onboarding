// Phase 23, plan 23-24 (D-01, D-03). While the sign-up flag is closed, the
// server gate (server/middleware/launch-gate.ts) looks up the httpOnly
// ln_invite session and records its answer on event.context.invited. This
// plugin runs only during server rendering and copies that answer into the
// page state `ln-invited`. Nuxt serialises page state into the page payload,
// so the browser starts with the same answer and its route middleware
// (app/middleware/launch-gate.global.ts) keeps an invited person on
// /onboarding instead of bouncing them to the early-access form.
//
// The state steers navigation only. It is a copy of a server decision, never
// an input to one: the server re-checks the session cookie on every gated
// request, so a browser that sets ln-invited by hand still gets 404 from the
// gated API routes (T-23-70). Only the boolean true counts.
//
// This is a Nuxt plugin (app/plugins/*.server.ts), not a Nitro plugin: the
// state lives in the Nuxt app, and server/plugins/* cannot reach it.
//
// 23-19: the sign-up form also needs the invited address (shown read-only) and
// the invite's code (filled in). The gate puts just those two fields on
// event.context.invitedDetails; they are copied into `ln-invite-details` only
// when the session is live. Like the boolean, they are display only: checkout
// takes the address and checks the code on the server.
export default defineNuxtPlugin(() => {
  const event = useRequestEvent()
  const invited = useState<boolean>('ln-invited', () => false)
  invited.value = event?.context.invited === true
  const details = useState<{ email: string, promoCode?: string } | null>('ln-invite-details', () => null)
  const raw = event?.context.invitedDetails as { email?: unknown, promoCode?: unknown } | undefined
  details.value = invited.value && raw && typeof raw.email === 'string' && raw.email
    ? { email: raw.email, ...(typeof raw.promoCode === 'string' && raw.promoCode ? { promoCode: raw.promoCode } : {}) }
    : null
})
