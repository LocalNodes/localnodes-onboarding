// The renewal card mails (Phase 23, plan 23-32 Task 3; Tom's billing rule B-2,
// the Phase 23 part: "Renewal mails: as in the earlier delta, with 7 days").
// A renewal of this app's subscription (any billing_reason other than
// subscription_create) that fails, or needs the bank's confirmation, sends one
// plain mail per invoice: 23-UI-SPEC section 12, rows "Update card (renewal)"
// and "Confirm card (renewal)". Redis is FakeRedis and Resend a mocked fetch;
// nothing touches a network.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Stripe from 'stripe'
import { formatUsDate, sendRenewalMail, CARD_MAIL_SECONDS, type RenewalMailDeps } from '../../server/utils/billing-mail'
import { buildRenewalMail, MAIL_FOOTER, REPLY_TO } from '../../server/utils/mail-copy'
import { handleStripeWebhook } from '../../server/utils/stripe-webhook'
import { routeInvoiceEvent, type BillingDeps } from '../../server/utils/billing'
import { FakeRedis } from './helpers/fake-redis'

const PID = 'ReNeWaL00000000000000a'
const INVOICE = 'in_renew_1'
const EMAIL = 'organizer@example.org'
const HOSTED = 'https://invoice.stripe.com/i/acct_x/test_renewal_link'
/** 2026-11-08T12:00:00Z. */
const EVENT_CREATED = Date.UTC(2026, 10, 8, 12, 0, 0) / 1000

function renewalInvoice(over: Record<string, unknown> = {}) {
  return {
    id: INVOICE,
    billing_reason: 'subscription_cycle',
    customer_email: EMAIL,
    hosted_invoice_url: HOSTED,
    parent: { subscription_details: { metadata: { provision_id: PID }, subscription: 'sub_1' } },
    ...over
  }
}

describe('formatUsDate', () => {
  it('uses UTC: 2026-11-15T23:30:00Z prints "November 15, 2026"', () => {
    expect(formatUsDate(Date.UTC(2026, 10, 15, 23, 30, 0) / 1000)).toBe('November 15, 2026')
  })

  it('an event created 2026-11-08 UTC gives "November 15, 2026" seven days later', () => {
    expect(formatUsDate(EVENT_CREATED + 7 * 86400)).toBe('November 15, 2026')
  })
})

describe('sendRenewalMail', () => {
  let redis: FakeRedis
  let fetchMock: ReturnType<typeof vi.fn>
  let logs: string[]
  let deps: RenewalMailDeps

  beforeEach(() => {
    redis = new FakeRedis()
    fetchMock = vi.fn().mockResolvedValue({ id: 'email_1' })
    logs = []
    deps = { redis, fetch: fetchMock, apiKey: 're_test_key', from: 'LocalNodes <hello@localnodes.xyz>', log: m => logs.push(m) }
  })

  it('invoice.payment_failed for a renewal: one "Update card" mail, dated 7 days on, to the invoice email, keyed to the invoice', async () => {
    expect(await sendRenewalMail(renewalInvoice(), 'update', EVENT_CREATED, deps)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]! as [string, { method: string, headers: Record<string, string>, body: Record<string, unknown> }]
    expect(url).toBe('https://api.resend.com/emails')
    expect(opts.method).toBe('POST')
    expect(opts.headers).toEqual({
      'Authorization': 'Bearer re_test_key',
      'Content-Type': 'application/json',
      'Idempotency-Key': `card-mail-${INVOICE}`
    })
    const mail = buildRenewalMail('update', { date: 'November 15, 2026', link: HOSTED })
    expect(opts.body).toEqual({
      from: 'LocalNodes <hello@localnodes.xyz>',
      to: [EMAIL],
      reply_to: REPLY_TO,
      subject: 'Your card didn\'t go through',
      text: mail.text,
      html: mail.html
    })
    expect(REPLY_TO).toBe('hello@localnodes.xyz')
    expect(mail.text).toContain('Please update your card by November 15, 2026.')
    expect(mail.parts.button).toEqual({ label: 'Update my card', url: HOSTED })
    expect(mail.text).toContain(MAIL_FOOTER)
    expect(mail.html).not.toMatch(/unsubscribe/i)
    expect(mail.text).not.toMatch(/unsubscribe/i)
  })

  it('invoice.payment_action_required for a renewal: the "Confirm card" body and the button "Confirm my card"', async () => {
    await sendRenewalMail(renewalInvoice(), 'confirm', EVENT_CREATED, deps)
    const body = (fetchMock.mock.calls[0]![1] as { body: Record<string, unknown> }).body
    const mail = buildRenewalMail('confirm', { date: 'November 15, 2026', link: HOSTED })
    expect(body.text).toBe(mail.text)
    expect(mail.text).toContain('Please confirm it by November 15, 2026.')
    expect(mail.parts.button).toEqual({ label: 'Confirm my card', url: HOSTED })
  })

  it('the same invoice failing twice, or action required then failed, sends one mail in total (SET card-mail:{invoiceId} NX EX 30 days)', async () => {
    await sendRenewalMail(renewalInvoice(), 'confirm', EVENT_CREATED, deps)
    expect(await sendRenewalMail(renewalInvoice(), 'update', EVENT_CREATED + 3600, deps)).toBe(false)
    expect(await sendRenewalMail(renewalInvoice(), 'update', EVENT_CREATED + 7200, deps)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(CARD_MAIL_SECONDS).toBe(2592000)
    expect(await redis.ttl(`card-mail:${INVOICE}`)).toBe(2592000)
  })

  it('a Resend failure deletes the marker and throws, so the webhook answers 503 and Stripe redelivers', async () => {
    fetchMock.mockRejectedValueOnce(new Error(`resend 500 for ${EMAIL}`))
    await expect(sendRenewalMail(renewalInvoice(), 'update', EVENT_CREATED, deps)).rejects.toThrow()
    expect(await redis.exists(`card-mail:${INVOICE}`)).toBe(0)
    expect(await sendRenewalMail(renewalInvoice(), 'update', EVENT_CREATED, deps)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['customer_email', { customer_email: null }],
    ['hosted_invoice_url', { hosted_invoice_url: null }],
    ['an invoice id', { id: undefined }]
  ] as const)('a renewal invoice without %s sends nothing', async (_label, over) => {
    expect(await sendRenewalMail(renewalInvoice(over), 'update', EVENT_CREATED, deps)).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('no log line carries the email, the invoice id or the hosted URL', async () => {
    fetchMock.mockRejectedValueOnce(new Error(`resend 500 for ${EMAIL}`))
    await sendRenewalMail(renewalInvoice(), 'update', EVENT_CREATED, deps).catch(() => {})
    await sendRenewalMail(renewalInvoice({ customer_email: null }), 'update', EVENT_CREATED, deps)
    const text = logs.join('\n')
    for (const secret of [EMAIL, INVOICE, HOSTED, PID]) expect(text).not.toContain(secret)
  })
})

describe('renewal mails through the webhook (routeInvoiceEvent → onRenewalProblem)', () => {
  const WHSEC = 'whsec_test_secret'
  const stripe = new Stripe('sk_test_not_used')
  let redis: FakeRedis
  let fetchMock: ReturnType<typeof vi.fn>
  let logs: string[]

  beforeEach(() => {
    redis = new FakeRedis()
    fetchMock = vi.fn().mockResolvedValue({ id: 'email_1' })
    logs = []
  })

  const send = (type: string, over: Record<string, unknown> = {}, open = false) => {
    const payload = JSON.stringify({ id: `evt_${type}`, object: 'event', type, created: EVENT_CREATED, data: { object: { object: 'invoice', ...renewalInvoice(over) } } })
    const billing: BillingDeps = {
      redis,
      stripe: () => { throw new Error('no Stripe call expected') },
      fetch: vi.fn(),
      callbackSecret: 'secret',
      log: m => logs.push(m)
    }
    const mailDeps: RenewalMailDeps = { redis, fetch: fetchMock, apiKey: 're_test_key', from: 'LocalNodes <hello@localnodes.xyz>', log: m => logs.push(m) }
    return handleStripeWebhook(payload, stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC }), {
      open,
      constructEvent: (b, s) => stripe.webhooks.constructEvent(b, s, WHSEC),
      onCheckoutCompleted: vi.fn(async () => {}),
      onInvoice: async (event) => {
        await routeInvoiceEvent(event, { ...billing, onRenewalProblem: (invoice, kind, created) => sendRenewalMail(invoice, kind, created, mailDeps).then(() => undefined) })
      },
      log: m => logs.push(m)
    })
  }

  it.each(['subscription_cycle', 'subscription_update'])('invoice.payment_failed with billing_reason %s sends the update mail once, open or closed', async (reason) => {
    expect(await send('invoice.payment_failed', { billing_reason: reason })).toEqual({ status: 200, body: { received: true } })
    expect(await send('invoice.payment_failed', { billing_reason: reason }, true)).toEqual({ status: 200, body: { received: true } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0]![1] as { body: { subject: string, text: string } }).body.text).toContain('Please update your card by November 15, 2026.')
  })

  it('invoice.payment_action_required for a renewal sends the confirm mail', async () => {
    await send('invoice.payment_action_required')
    expect((fetchMock.mock.calls[0]![1] as { body: { text: string } }).body.text).toContain('your bank needs you to confirm the payment')
  })

  it('a Resend failure answers 503, so Stripe redelivers', async () => {
    fetchMock.mockRejectedValueOnce(new Error('resend down'))
    expect(await send('invoice.payment_failed')).toEqual({ status: 503, body: { error: 'Temporarily unavailable' } })
    expect(await send('invoice.payment_failed')).toEqual({ status: 200, body: { received: true } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a renewal invoice without provision_id sends nothing and answers 200', async () => {
    expect(await send('invoice.payment_failed', { parent: { subscription_details: { metadata: {}, subscription: 'sub_1' } } })).toEqual({ status: 200, body: { received: true } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a first-invoice failure sends no renewal mail', async () => {
    await send('invoice.payment_failed', { billing_reason: 'subscription_create' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the wiring', () => {
  it('billing-wiring.ts wires onRenewalProblem to sendRenewalMail with the Resend key and the sender, and the webhook route uses it', async () => {
    const { readFileSync } = await import('node:fs')
    const wiring = readFileSync(new URL('../../server/utils/billing-wiring.ts', import.meta.url), 'utf8')
    expect(wiring).toMatch(/onRenewalProblem[^=\n]*= \(invoice, kind, createdSec\) => sendRenewalMail\(/)
    expect(wiring).toMatch(/apiKey: String\(config\.resendApiKey/)
    expect(wiring).toMatch(/from: String\(config\.mailFrom/)
    const route = readFileSync(new URL('../../server/api/stripe-webhook.post.ts', import.meta.url), 'utf8')
    expect(route).toMatch(/onRenewalProblem: billing\.onRenewalProblem/)
  })
})
