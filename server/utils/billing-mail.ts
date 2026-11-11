// The renewal card mails (Phase 23, plan 23-32; Tom's billing rule B-2, the
// Phase 23 part). Plain module, no Nitro globals: Redis, fetch, the Resend key,
// the sender and the clock are injected; billing-wiring.ts wires it to the
// webhook's onRenewalProblem.
//
// A renewal of this app's subscription (any billing_reason other than
// subscription_create, so 23-23's forced renewal counts) that fails or needs
// the bank's confirmation gets one plain mail per invoice: the words are
// mail-copy.ts buildRenewalMail, with the date 7 days after the event (Stripe
// Smart Retries run 7 days; US format, UTC). One mail per invoice across both
// events: SET card-mail:{invoiceId} NX EX 30 days, plus Resend's
// Idempotency-Key card-mail-{invoiceId}. A Resend failure deletes the marker
// and throws, so the webhook answers 503 and Stripe redelivers.
//
// Pause and removal after the 7 days, and the day-14 and day-27 mails, are
// B-2's later billing phase, not here.
//
// Privacy rule: log lines are fixed words only, never the address, an id or
// the hosted invoice URL.
import { buildRenewalMail, REPLY_TO } from './mail-copy'
import type { RoutedInvoice } from './billing'

/** One renewal mail per invoice, marked for 30 days. */
export const CARD_MAIL_SECONDS = 2592000
/** Smart Retries run 7 days (B-2): the mail names the day they end. */
export const RENEWAL_GRACE_DAYS = 7

export interface RenewalMailDeps {
  redis: {
    set: (key: string, value: string, opts: { nx: true, ex: number }) => Promise<unknown>
    del: (...keys: string[]) => Promise<unknown>
  }
  fetch: (url: string, opts: { method: 'POST', headers: Record<string, string>, body: Record<string, unknown> }) => Promise<unknown>
  /** NUXT_RESEND_API_KEY. */
  apiKey: string
  /** NUXT_MAIL_FROM. */
  from: string
  log?: (msg: string) => void
}

const US_DATE = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** Unix seconds as "November 15, 2026", in UTC. */
export function formatUsDate(seconds: number): string {
  return US_DATE.format(new Date(seconds * 1000))
}

/**
 * Send the renewal card mail for this invoice, once. `createdSec` is the
 * event's created time (unix seconds). True when a mail went out; false when
 * one already had, or the invoice lacks an address, a hosted page or an id.
 */
export async function sendRenewalMail(invoice: RoutedInvoice, kind: 'update' | 'confirm', createdSec: number, deps: RenewalMailDeps): Promise<boolean> {
  const invoiceId = typeof invoice.id === 'string' ? invoice.id : ''
  const to = typeof invoice.customer_email === 'string' ? invoice.customer_email : ''
  const link = typeof invoice.hosted_invoice_url === 'string' && invoice.hosted_invoice_url.startsWith('https://') ? invoice.hosted_invoice_url : ''
  if (!invoiceId || !to || !link) {
    deps.log?.('billing-mail: renewal invoice without an address, a hosted page or an id, nothing sent')
    return false
  }
  if (!deps.apiKey || !deps.from) throw new Error('billing-mail: mail not configured')
  const marker = `card-mail:${invoiceId}`
  const first = await deps.redis.set(marker, String(createdSec), { nx: true, ex: CARD_MAIL_SECONDS })
  if (!first) return false
  const mail = buildRenewalMail(kind, { date: formatUsDate(createdSec + RENEWAL_GRACE_DAYS * 86400), link })
  try {
    await deps.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${deps.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `card-mail-${invoiceId}`
      },
      body: {
        from: deps.from,
        to: [to],
        reply_to: REPLY_TO,
        subject: mail.subject,
        text: mail.text,
        html: mail.html
      }
    })
  } catch {
    deps.log?.('billing-mail: renewal mail not sent, Stripe will redeliver')
    await deps.redis.del(marker)
    throw new Error('billing-mail: renewal mail not sent')
  }
  return true
}
