// The mails the sign-up site sends (fresh3 23-19; T-1, T-5; 23-UI-SPEC.md
// section 12 and "Footers (T-5)"). Each builder's subject, body, button and
// footer are checked against its section 12 row, word for word; every mail has
// an html part in the 22.1-07 look, with colours pinned to the token file; and
// every POST /emails call in the app sends reply_to hello@localnodes.xyz.
// The renewal card mails (update card, confirm card; B-2 Phase 23 part) are
// built here since 23-32 and sent by server/utils/billing-mail.ts; the declined
// and 3DS mails come in 23-37. The "room is available" mail has no sender yet
// (23-17).
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  MAIL_COLORS,
  MAIL_FOOTER,
  REPLY_TO,
  STOPPED_MAIL,
  buildDeclinedMail,
  buildHeldMail,
  buildInviteMail,
  buildPilotEndMail,
  buildRefundMail,
  buildRemovedMail,
  buildRenewalMail,
  renderMail
} from '../../server/utils/mail-copy'

const root = resolve(__dirname, '../..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

const LINK = `https://localnodes.xyz/invite/verify#t=${'a'.repeat(43)}`
const UNSUB = 'https://localnodes.xyz/unsubscribe?t=sealed-token'
const FOOTER = 'Sent by LocalNodes · Home base for communities that run things together.'

/** 23-UI-SPEC.md section 12, copied word for word. */
const ROWS = [
  {
    mail: 'Invite link',
    built: () => buildInviteMail({ link: LINK, unsubscribeUrl: UNSUB }),
    subject: 'Your LocalNodes sign-in link',
    body: 'Here\'s your link to start setting up your community\'s site. It works once, for 15 minutes. If it stops working, ask for a new one at localnodes.xyz/invite. If you didn\'t ask for this, you can ignore this email.',
    button: 'Open my sign-in link',
    unsubscribe: true
  },
  {
    mail: 'Stopped (T-3)',
    built: () => STOPPED_MAIL,
    subject: 'We couldn\'t set up your site',
    body: 'We couldn\'t set up your site. You weren\'t charged, and we\'ve removed your saved card.',
    button: null,
    unsubscribe: false
  },
  {
    // B-1, the first payment (23-37). Sent by the teardown's mail step (retry-stop.ts).
    mail: 'Card declined (B-1, the first payment)',
    built: () => buildDeclinedMail(),
    subject: 'Your card was declined',
    body: 'Your card was declined, so we didn\'t finish setting up your site. You weren\'t charged.',
    button: 'Try again',
    unsubscribe: false
  },
  {
    // B-1, 3DS on the first payment (23-37). The time is the end of the hold, in the zone kept at checkout or UTC.
    mail: 'Confirm your payment (B-1, 3DS on the first payment)',
    built: () => buildHeldMail({ until: 'November 9, 2026 at 4:15pm MST', link: 'https://invoice.stripe.com/i/acct_x/test_link' }),
    subject: 'Confirm your payment',
    body: 'Your community\'s site is ready. Your bank needs you to confirm the first payment before we hand it over. Please confirm it by November 9, 2026 at 4:15pm MST; after that we\'ll remove the site and you won\'t be charged.',
    button: 'Confirm my payment',
    unsubscribe: false
  },
  {
    // B-1, the 3DS hold ran out (23-37; "Billing copy (B-1)", Q-held-expiry answer, row "Payment not confirmed (mail)").
    mail: 'Payment not confirmed (mail)',
    built: () => buildRemovedMail(),
    subject: 'We\'ve removed your site',
    body: 'We didn\'t get your payment confirmation in time, so we\'ve removed your site. You weren\'t charged.',
    button: 'Try again',
    unsubscribe: false
  },
  {
    // 23-43 Task 6, P1 ("Billing copy additions for 23-43"): a paid site that could not be handed over in 24 hours, refunded in full.
    mail: 'P1 Refund mail',
    built: () => buildRefundMail({ lateActivation: false }),
    subject: 'We\'ve refunded your payment',
    body: 'We couldn\'t finish setting up your site, so we\'ve refunded your payment in full.',
    button: 'Try again',
    unsubscribe: false
  },
  {
    // 23-43 Task 6, P1's truth rule: the site activated late (lateActivation), so the body never says it wasn't set up.
    mail: 'P1 Refund mail with lateActivation',
    built: () => buildRefundMail({ lateActivation: true }),
    subject: 'We\'ve refunded your payment',
    body: 'We\'ve refunded your payment in full.',
    button: 'Try again',
    unsubscribe: false
  },
  {
    // 23-43 Task 6, P5: a 100%-off pilot whose site never activated; nothing was charged, so the approved Stopped mail word for word.
    mail: 'P5 Zero-charge pilot (the Stopped mail)',
    built: () => buildRefundMail({ lateActivation: false, refundZero: true }),
    subject: 'We couldn\'t set up your site',
    body: 'We couldn\'t set up your site. You weren\'t charged, and we\'ve removed your saved card.',
    button: null,
    unsubscribe: false
  },
  {
    // B-2 Phase 23 part, invoice.payment_failed for a renewal (23-32). The date is 7 days after the failed charge.
    mail: 'Update card (renewal)',
    built: () => buildRenewalMail('update', { date: 'November 15, 2026', link: 'https://invoice.stripe.com/i/acct_x/test_link' }),
    subject: 'Your card didn\'t go through',
    body: 'Your community\'s site is still open, but we couldn\'t charge your card. Please update your card by November 15, 2026.',
    button: 'Update my card',
    unsubscribe: false
  },
  {
    // B-2 Phase 23 part, invoice.payment_action_required for a renewal (23-32).
    mail: 'Confirm card (renewal)',
    built: () => buildRenewalMail('confirm', { date: 'November 15, 2026', link: 'https://invoice.stripe.com/i/acct_x/test_link' }),
    subject: 'Confirm your site payment',
    body: 'Your community\'s site is still open, but your bank needs you to confirm the payment. Please confirm it by November 15, 2026.',
    button: 'Confirm my payment',
    unsubscribe: false
  }
] as const

describe.each(ROWS)('the $mail mail matches its 23-UI-SPEC section 12 row', (row) => {
  it('subject', () => {
    expect(row.built().subject).toBe(row.subject)
  })

  it('body, word for word', () => {
    const m = row.built()
    expect([...m.parts.before, ...m.parts.after].join(' ')).toBe(row.body)
  })

  it('button', () => {
    expect(row.built().parts.button?.label ?? null).toBe(row.button)
  })

  it('footer, with "Unsubscribe" only on a mail to the early-access list', () => {
    const m = row.built()
    expect(MAIL_FOOTER).toBe(FOOTER)
    expect(m.text).toContain(FOOTER)
    expect(m.html).toContain(FOOTER)
    if (row.unsubscribe) {
      expect(m.html).toMatch(/<a [^>]*href="https:\/\/localnodes\.xyz\/unsubscribe\?t=sealed-token"[^>]*>Unsubscribe<\/a>/)
      expect(m.text).toContain(`Unsubscribe: ${UNSUB}`)
    } else {
      expect(m.html).not.toMatch(/unsubscribe/i)
      expect(m.text).not.toMatch(/unsubscribe/i)
    }
  })

  it('has an html part in the 22.1-07 look: the "LocalNodes" heading at 20px on a white card, the footer under the card at 14px, no images', () => {
    const { html } = row.built()
    expect(html).toMatch(/^<!doctype html>/i)
    expect(html).toMatch(/font-size:20px[^"]*">LocalNodes</)
    expect(html).toContain(`background-color:${MAIL_COLORS.card}`)
    expect(html).toContain(`background-color:${MAIL_COLORS.canvas}`)
    expect(html).toMatch(new RegExp(`color:${MAIL_COLORS.footer};font-size:14px`))
    expect(html.indexOf('>LocalNodes<')).toBeLessThan(html.indexOf(FOOTER))
    expect(html).not.toMatch(/<img|background-image|url\(/i)
    expect(html).not.toContain('github.com')
  })
})

describe('the invite mail', () => {
  it('has no pilot-code line: the form fills the code in (the section 12 row has none)', () => {
    const m = buildInviteMail({ link: LINK, unsubscribeUrl: UNSUB })
    expect(m.text).not.toMatch(/code/i)
    expect(m.html).not.toMatch(/pilot|your code/i)
  })

  it('the button links to the sign-in link, in the brand colour', () => {
    const { html } = buildInviteMail({ link: LINK, unsubscribeUrl: UNSUB })
    expect(html).toMatch(new RegExp(`<a href="${LINK.replace(/[.?#]/g, '\\$&')}"[^>]*background-color:${MAIL_COLORS.button}[^>]*>Open my sign-in link</a>`))
    expect(buildInviteMail({ link: LINK, unsubscribeUrl: UNSUB }).text).toContain(`Open my sign-in link: ${LINK}`)
  })
})

describe('the mail look', () => {
  it('escapes every value it puts in the html', () => {
    const { html } = renderMail({ subject: 'S', before: ['<b>&"\''], after: [], button: { label: 'Go', url: 'https://x.example/?a=1&b="2"' } })
    expect(html).toContain('&lt;b&gt;&amp;&quot;&#39;')
    expect(html).toContain('href="https://x.example/?a=1&amp;b=&quot;2&quot;"')
    expect(html).not.toContain('<b>&')
  })

  it('every colour is a role in the generated token file, so a palette change shows up here', () => {
    const tokens = read('app/assets/css/ln-tokens.css')
    const light = tokens.slice(tokens.indexOf(':root {'), tokens.indexOf('}', tokens.indexOf(':root {')))
    const role = (name: string) => new RegExp(`${name}:\\s*${''}([^;]+);`).exec(light)?.[1]?.trim()
    const palette = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(tokens)?.[1]?.trim()
    expect(MAIL_COLORS).toEqual({
      canvas: role('--ui-bg-muted'),
      card: role('--ui-bg'),
      border: role('--ui-border'),
      heading: role('--ui-text'),
      text: role('--ui-text'),
      button: role('--ui-primary'),
      buttonText: role('--ui-text-inverted'),
      link: palette('--color-ln-brand-800'),
      footer: role('--ui-text-muted')
    })
  })
})

describe('every mail the sign-up site sends can be answered (T-1)', () => {
  /** Every server file that POSTs to Resend's /emails. */
  const senders = () => {
    const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true })
      .flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
    return walk('server').filter(f => f.endsWith('.ts') && read(f).includes('api.resend.com/emails'))
  }

  it('reply-to is hello@localnodes.xyz', () => {
    expect(REPLY_TO).toBe('hello@localnodes.xyz')
  })

  it('every POST /emails call sends reply_to REPLY_TO and an html part', () => {
    const files = senders()
    expect(files.sort()).toEqual(['server/utils/billing-mail.ts', 'server/utils/invites.ts', 'server/utils/pilot-end.ts', 'server/utils/retry-stop.ts'])
    for (const file of files) {
      const src = read(file)
      const calls = src.split('api.resend.com/emails').slice(1)
      for (const call of calls) {
        const body = call.slice(0, call.indexOf('})'))
        expect(body, file).toMatch(/reply_to: REPLY_TO/)
        expect(body, file).toMatch(/html: /)
      }
    }
  })
})

describe('the card declined mail (23-37)', () => {
  it('the button goes to localnodes.xyz/invite', () => {
    const m = buildDeclinedMail()
    expect(m.parts.button?.url).toBe('https://localnodes.xyz/invite')
    expect(m.html).toContain('href="https://localnodes.xyz/invite"')
    expect(m.text).toContain('Try again: https://localnodes.xyz/invite')
  })
})

describe('the confirm your payment and payment not confirmed mails (23-37)', () => {
  it('"Confirm my payment" goes to the invoice\'s hosted page; the mail always has the button (Tom\'s answer 3)', () => {
    const link = 'https://invoice.stripe.com/i/acct_x/test_link'
    const m = buildHeldMail({ until: 'November 9, 2026 at 4:15pm UTC', link })
    expect(m.parts.button).toEqual({ label: 'Confirm my payment', url: link })
    expect(m.html).toContain(`href="${link}"`)
  })

  it('"Try again" on the removed mail goes to localnodes.xyz/invite', () => {
    expect(buildRemovedMail().parts.button).toEqual({ label: 'Try again', url: 'https://localnodes.xyz/invite' })
  })
})

describe('the refund mails (23-43 Task 6)', () => {
  it('"Try again" goes to localnodes.xyz/invite on both P1 variants', () => {
    for (const lateActivation of [false, true]) expect(buildRefundMail({ lateActivation }).parts.button).toEqual({ label: 'Try again', url: 'https://localnodes.xyz/invite' })
  })

  it('with lateActivation the mail never says the site was not set up', () => {
    const late = buildRefundMail({ lateActivation: true })
    expect(late.text).not.toMatch(/couldn't finish|set up|setting up/i)
    expect(late.html).not.toMatch(/couldn&#39;t finish|setting up/i)
  })

  it('the P5 zero-charge mail is the Stopped mail itself', () => {
    expect(buildRefundMail({ lateActivation: false, refundZero: true })).toEqual(STOPPED_MAIL)
  })
})

describe('the renewal card mails (23-32)', () => {
  it('the button links to the invoice\'s hosted page', () => {
    const link = 'https://invoice.stripe.com/i/acct_x/test_link'
    for (const kind of ['update', 'confirm'] as const) {
      const m = buildRenewalMail(kind, { date: 'November 15, 2026', link })
      expect(m.parts.button?.url).toBe(link)
      expect(m.html).toContain(`href="${link}"`)
    }
  })
})

describe('the pilot end notice: a lapsed site stays 30 days, with a written notice before removal (project rule)', () => {
  it('says the site stays open 30 days after the end and that we write at least a week before removing it', () => {
    const m = buildPilotEndMail({ date: 'March 12, 2027', price: '$49 a month', link: 'https://localnodes.xyz/pilot/continue?t=x' })
    expect(m.text).toContain('If you do nothing, we won\'t charge you anything.')
    expect(m.text).toContain('Your site stays open for 30 days after that')
    expect(m.text).toContain('we\'ll write to you at least a week before we remove it')
  })
})

describe('the pilot end notice: the choice and its price', () => {
  const m = buildPilotEndMail({ date: 'March 12, 2027', price: '$49 a month', link: 'https://localnodes.xyz/pilot/continue?t=x' })

  it('names the end, the price only if you choose, and the date to choose by', () => {
    expect(m.text).toContain('Your free pilot ends on March 12, 2027.')
    expect(m.text).toContain('After that, the site costs $49 a month only if you choose to keep it; we charge only if you say yes.')
    expect(m.text).toContain('To keep it, choose "Keep my site" below before March 12, 2027.')
  })

  it('promises no second question and never says "from then on"', () => {
    expect(m.text).not.toMatch(/we will ask|we'll ask|from then on|full price/i)
  })
})
