// Every word and the look of the mails the sign-up site sends (Phase 23,
// plans 23-02, 23-14 and 23-19). One file, so the wording can be reviewed in
// one place. Each builder matches its 23-UI-SPEC.md section 12 row word for
// word; voice: plain and warm, second person, sentence case (22-UI-SPEC Part 6).
// npm run check:claims scans this file (mailSources in tests/fixtures/banned-claims.json).
//
// The look is the LocalNodes mail template from 22.1-07: a white card on a grey
// canvas, the name "LocalNodes" at the top of the card in 20px type with no
// divider, 16px body text, one button in the brand blue, and the footer under
// the card in 14px muted text. No images, so a mail reads the same with images
// off. Mail clients don't read CSS variables, so the colours are written out
// here; tests/unit/mail-copy.test.ts holds each one equal to its role in
// app/assets/css/ln-tokens.css, so a palette change there fails the test.
//
// Mail footers carry no "Open source" link (T-5). Mails to the early-access
// list carry an "Unsubscribe" link; the stopped and renewal card mails go to a
// customer and do not. The renewal card mails (update card, confirm card; B-2's
// Phase 23 part) are here since 23-32 and are sent by billing-mail.ts. The
// card declined, confirm your payment and payment not confirmed mails are
// 23-37's, word for word from their section 12 and "Billing copy (B-1)" rows;
// the teardown (retry-stop.ts) and the held step (teardown.ts) send them. The
// refund mails are 23-43 Task 6's, word for word from 23-UI-SPEC.md "Billing
// copy additions for 23-43" (P1 with its lateActivation rule, P5); the
// teardown's mail step sends them for the activation_failed reason.

/**
 * The reply-to on every mail the sign-up site sends (T-1, 2026-11-08). It
 * receives mail: Cloudflare Email Routing forwards it to Tom.
 */
export const REPLY_TO = 'hello@localnodes.xyz'

/** The footer line every mail carries, under the card (23-UI-SPEC section 12). */
export const MAIL_FOOTER = 'Sent by LocalNodes · Home base for communities that run things together.'

/** The words of the unsubscribe link in a footer. */
export const UNSUBSCRIBE_LABEL = 'Unsubscribe'

/** The heading at the top of the card. */
const MAIL_HEADING = 'LocalNodes'

/**
 * The 22.1-07 mail colours, each a role in app/assets/css/ln-tokens.css
 * (canvas --ui-bg-muted, card --ui-bg, border --ui-border, heading and text
 * --ui-text, button --ui-primary, button text --ui-text-inverted, link
 * --color-ln-brand-800, footer --ui-text-muted).
 */
export const MAIL_COLORS = {
  canvas: '#f3f3f3',
  card: '#ffffff',
  border: '#e6e6e6',
  heading: '#343434',
  text: '#343434',
  button: '#176c93',
  buttonText: '#ffffff',
  link: '#145f82',
  footer: '#555555'
} as const

const FONT = 'Montserrat, system-ui, sans-serif'
const RADIUS_CARD = '8px'
const RADIUS_CONTROL = '6px'

/** The parts a mail is made of. Paragraphs before the button, the button, paragraphs after it. */
export interface MailParts {
  subject: string
  before: string[]
  button?: { label: string, url: string }
  after: string[]
  /** Only for a mail to the early-access list. */
  unsubscribeUrl?: string
}

export interface BuiltMail {
  subject: string
  text: string
  html: string
  parts: MailParts
}

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:${MAIL_COLORS.text};">${escapeHtml(text)}</p>`
}

function button(label: string, url: string): string {
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;"><tr>'
    + `<td style="background-color:${MAIL_COLORS.button};border-radius:${RADIUS_CONTROL};">`
    + `<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;background-color:${MAIL_COLORS.button};`
    + `border:1px solid ${MAIL_COLORS.button};border-radius:${RADIUS_CONTROL};color:${MAIL_COLORS.buttonText};`
    + `font-family:${FONT};font-size:16px;font-weight:600;line-height:1.4;text-decoration:none;">${escapeHtml(label)}</a>`
    + '</td></tr></table>'
}

/** The plain-text part: paragraphs, the button as "Label: URL", the footer, and the unsubscribe link when there is one. */
function renderText(parts: MailParts): string {
  const blocks = [...parts.before]
  if (parts.button) blocks.push(`${parts.button.label}: ${parts.button.url}`)
  blocks.push(...parts.after)
  const footer = parts.unsubscribeUrl ? `${MAIL_FOOTER}\n${UNSUBSCRIBE_LABEL}: ${parts.unsubscribeUrl}` : MAIL_FOOTER
  return [...blocks, footer].join('\n\n')
}

/** The html part, in the 22.1-07 look. Every value is escaped. */
function renderHtml(parts: MailParts): string {
  const body = [
    ...parts.before.map(paragraph),
    parts.button ? button(parts.button.label, parts.button.url) : '',
    ...parts.after.map(paragraph)
  ].join('')
  const footerStyle = `color:${MAIL_COLORS.footer};font-size:14px;line-height:1.5;font-family:${FONT};`
  const unsubscribe = parts.unsubscribeUrl
    ? `<p style="margin:8px 0 0;${footerStyle}"><a href="${escapeHtml(parts.unsubscribeUrl)}" style="${footerStyle}text-decoration:underline;">${UNSUBSCRIBE_LABEL}</a></p>`
    : ''
  return '<!doctype html>'
    + '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
    + `<title>${escapeHtml(parts.subject)}</title></head>`
    + `<body style="margin:0;padding:0;background-color:${MAIL_COLORS.canvas};color:${MAIL_COLORS.text};font-family:${FONT};font-size:16px;line-height:1.5;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${MAIL_COLORS.canvas};"><tr><td align="center" style="padding:16px;">`
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">'
    + `<tr><td style="background-color:${MAIL_COLORS.card};border:1px solid ${MAIL_COLORS.border};border-radius:${RADIUS_CARD};">`
    + `<div style="padding:32px 44px 8px;color:${MAIL_COLORS.heading};font-family:${FONT};font-size:20px;font-weight:600;line-height:1.4;">${MAIL_HEADING}</div>`
    + `<div style="padding:8px 44px 24px;">${body}</div>`
    + '</td></tr>'
    + `<tr><td align="center" style="padding:24px 16px 0;background-color:${MAIL_COLORS.canvas};">`
    + `<p style="margin:0;${footerStyle}">${escapeHtml(MAIL_FOOTER)}</p>${unsubscribe}`
    + '</td></tr></table>'
    + '</td></tr></table></body></html>'
}

/** Builds the text and html parts of a mail from its parts. */
export function renderMail(parts: MailParts): BuiltMail {
  return { subject: parts.subject, text: renderText(parts), html: renderHtml(parts), parts }
}

// --- the mails -------------------------------------------------------------------

export const INVITE_MAIL_SUBJECT = 'Your LocalNodes sign-in link'

export interface InviteMailContent {
  link: string
  /** The address's own unsubscribe link (this mail goes to the early-access list). */
  unsubscribeUrl: string
}

/**
 * The sign-in link mail (23-UI-SPEC section 12, row "Invite link"). It has no
 * pilot-code line: the sign-up form fills the invite's code in.
 */
export function buildInviteMail(content: InviteMailContent): BuiltMail {
  return renderMail({
    subject: INVITE_MAIL_SUBJECT,
    before: ['Here\'s your link to start setting up your community\'s site. It works once, for 15 minutes.'],
    button: { label: 'Open my sign-in link', url: content.link },
    after: ['If it stops working, ask for a new one at localnodes.xyz/invite. If you didn\'t ask for this, you can ignore this email.'],
    unsubscribeUrl: content.unsubscribeUrl
  })
}

/**
 * The one sentence of the stopped state (T-3): the page alert, the mail body
 * and the refusal of a third try all use it.
 */
export const STOPPED_SENTENCE = 'We couldn\'t set up your site. You weren\'t charged, and we\'ve removed your saved card.'

/**
 * The mail sent once when a sign-up stops after its second failed build
 * (23-UI-SPEC section 12, row "Stopped (T-3)"). It goes to a customer, not to
 * the early-access list, so it has no unsubscribe link. No button.
 */
export const STOPPED_MAIL: BuiltMail = renderMail({
  subject: 'We couldn\'t set up your site',
  before: [STOPPED_SENTENCE],
  after: []
})

/** The subject of the renewal mail for a card that was refused. */
export const RENEWAL_UPDATE_MAIL_SUBJECT = 'Your card didn\'t go through'
/** The subject of the renewal mail for a payment the bank needs confirmed. */
export const RENEWAL_CONFIRM_MAIL_SUBJECT = 'Confirm your site payment'

export interface RenewalMailContent {
  /** "November 15, 2026": 7 days after the failed charge (B-2). */
  date: string
  /** The invoice's hosted page. */
  link: string
}

/**
 * The renewal card mails: "Update card" for a refused renewal charge
 * (invoice.payment_failed) and "Confirm payment" for one the bank needs
 * confirmed (invoice.payment_action_required). Renewals only: a failed first
 * payment gets the card declined mail. They go to a customer, so no unsubscribe
 * link. They state no consequence: the site is still open, and the date is the
 * day the card needs sorting by.
 */
export function buildRenewalMail(kind: 'update' | 'confirm', content: RenewalMailContent): BuiltMail {
  const body = kind === 'update'
    ? `Your community's site is still open, but we couldn't charge your card. Please update your card by ${content.date}.`
    : `Your community's site is still open, but your bank needs you to confirm the payment. Please confirm it by ${content.date}.`
  return renderMail({
    subject: kind === 'update' ? RENEWAL_UPDATE_MAIL_SUBJECT : RENEWAL_CONFIRM_MAIL_SUBJECT,
    before: [body],
    button: { label: kind === 'update' ? 'Update my card' : 'Confirm my payment', url: content.link },
    after: []
  })
}

/** Where "Try again" goes after a failed first payment: the invite was reopened (23-37). */
export const INVITE_URL = 'https://localnodes.xyz/invite'

/**
 * The mail sent once when the first payment is declined (23-UI-SPEC section
 * 12, row "Card declined (B-1, the first payment)"). A customer mail: no
 * unsubscribe link. Its button goes to /invite, which works again because the
 * teardown reopened the invite before this mail goes out.
 */
export function buildDeclinedMail(): BuiltMail {
  return renderMail({
    subject: 'Your card was declined',
    before: ['Your card was declined, so we didn\'t finish setting up your site. You weren\'t charged.'],
    button: { label: 'Try again', url: INVITE_URL },
    after: []
  })
}

export interface HeldMailContent {
  /** The end of the hold, from shared/billing-time.ts formatHeldUntil in the zone kept at checkout (or UTC). */
  until: string
  /** The invoice's hosted page. */
  link: string
}

/**
 * The 3DS mail, sent once when the first payment is held for the bank's
 * confirmation (23-UI-SPEC section 12, row "Confirm your payment (B-1, 3DS on
 * the first payment)"). The mail always has the button (Tom's answer 3). A
 * customer mail: no unsubscribe link.
 */
export function buildHeldMail(content: HeldMailContent): BuiltMail {
  return renderMail({
    subject: 'Confirm your payment',
    before: [`Your community's site is ready. Your bank needs you to confirm the first payment before we hand it over. Please confirm it by ${content.until}; after that we'll remove the site and you won't be charged.`],
    button: { label: 'Confirm my payment', url: content.link },
    after: []
  })
}

/**
 * The one mail sent when a 3DS hold runs out unconfirmed and the site is
 * removed (23-UI-SPEC "Billing copy (B-1)", Q-held-expiry answer, row
 * "Payment not confirmed (mail)"). A customer mail: no unsubscribe link.
 */
export function buildRemovedMail(): BuiltMail {
  return renderMail({
    subject: 'We\'ve removed your site',
    before: ['We didn\'t get your payment confirmation in time, so we\'ve removed your site. You weren\'t charged.'],
    button: { label: 'Try again', url: INVITE_URL },
    after: []
  })
}

export interface RefundMailContent {
  /** A 200 {activated: true} was seen after the refund began (Q-straggler): the body must not say the site wasn't set up. */
  lateActivation: boolean
  /** The first invoice was 0 (a 100%-off pilot): nothing was charged, so nothing was refunded (P5). */
  refundZero?: boolean
}

/**
 * The one mail after a paid site could not be handed over in 24 hours (23-43
 * Task 6, Tom's ruling 2026-11-09), from 23-UI-SPEC.md "Billing copy additions
 * for 23-43":
 *   - P1: "We've refunded your payment", "We couldn't finish setting up your
 *     site, so we've refunded your payment in full." and "Try again" to
 *     localnodes.xyz/invite. Sent only after the refund succeeded for the full
 *     amount captured (D2), so "in full" is true;
 *   - P1 with lateActivation: only "We've refunded your payment in full." and
 *     "Try again" (the site did come up, late);
 *   - P5, a zero invoice: the approved Stopped mail word for word (nothing was
 *     charged; the teardown detaches the card).
 * A customer mail: no unsubscribe link. Idempotency-Key refund-mail-{provisionId}.
 */
export function buildRefundMail(content: RefundMailContent): BuiltMail {
  if (content.refundZero) return STOPPED_MAIL
  return renderMail({
    subject: 'We\'ve refunded your payment',
    before: [content.lateActivation
      ? 'We\'ve refunded your payment in full.'
      : 'We couldn\'t finish setting up your site, so we\'ve refunded your payment in full.'],
    button: { label: 'Try again', url: INVITE_URL },
    after: []
  })
}

/**
 * The pilot end notice (fresh3 23, pilot end; project rule: a free pilot is
 * never charged unless its organizer says yes). Sent once, about 14 days
 * before the free months end, by pilot-end.ts. The words are draft wording,
 * to be confirmed.
 */
export interface PilotEndMailContent {
  /** "February 26, 2027". */
  date: string
  /** "$20 a month". */
  price: string
  /** The continue link (pilot-end.ts continueUrl). */
  link: string
}

export function pilotEndMailSubject(date: string): string {
  return `Your free LocalNodes pilot ends on ${date}`
}

export const PILOT_END_BUTTON = 'Keep my site'

export function buildPilotEndMail(content: PilotEndMailContent): BuiltMail {
  return renderMail({
    subject: pilotEndMailSubject(content.date),
    before: [
      `Your free pilot ends on ${content.date}.`,
      `After that, the site costs ${content.price} only if you choose to keep it; we charge only if you say yes. To keep it, choose "${PILOT_END_BUTTON}" below before ${content.date}.`
    ],
    button: { label: PILOT_END_BUTTON, url: content.link },
    after: [
      'If you do nothing, we won\'t charge you anything. Your site stays open for 30 days after that so you can export what you need, and we\'ll write to you at least a week before we remove it.',
      `If you change your mind after ${content.date}, the same button still works until we remove the site. It then takes you to a secure Stripe payment page that shows the total, and nothing is charged until you confirm there.`,
      'Questions? Reply to this email.'
    ]
  })
}
