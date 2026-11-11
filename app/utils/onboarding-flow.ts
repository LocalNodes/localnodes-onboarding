// Logic and words for the sign-up form at /onboarding (fresh3 23-19; D-06,
// D-08, D-20, D-21, D-24; T-2, T-3; rulings C and P(a)).
// Plain module with no Nuxt globals: the components pass in $fetch, and the
// tests pass a fake. Every string is a row of 23-UI-SPEC.md section 3, word for
// word (Title Case for the page title and h1, sentence case for the rest). The
// AI choice copy lives in shared/ai-choice.ts (23-18). Do not reword a string
// here; change the UI-SPEC first. npm run check:claims scans this file with the
// sign-up rules (signupSources in tests/fixtures/banned-claims.json).
import { DEFAULT_TOPIC_TYPES } from '#shared/signup'
import {
  GEMINI_BILLING_MESSAGE,
  KEY_FAILED_MESSAGE,
  KEY_NOT_CHECKED_MESSAGE,
  SERVER_ERROR_MESSAGE,
  type AiChoice,
  type OwnKeyKind
} from '#shared/ai-choice'

/** The most page types the form keeps (23-UI-SPEC section 3, "At 8 rows"). */
export const MAX_PAGE_TYPES = 8
export const MIN_DESCRIPTION = 10
export const MAX_DESCRIPTION = 400

export const SIGNUP_COPY = {
  title: 'Name Your Community',
  intro: 'Pick a name and an address for your community\'s site. You can change the name later.',
  nameLabel: 'Community name',
  nameEmpty: 'Enter a name for your community.',
  address: {
    checking: 'Checking…',
    available: 'Available',
    taken: 'Taken. Try a different name.',
    invalid: 'Couldn\'t check this right now. Try again in a moment.'
  },
  emailLabel: 'Email',
  emailHelp: 'Your invite was sent to this address. We\'ll use it for checkout, and we\'ll send your sign-in link here once your site is ready.',
  pageTypes: {
    heading: 'Page types for your library',
    intro: 'Page types sort the pages in your library, like "Meeting notes" or "How-to". Skip this and you\'ll start with the standard ones.',
    descriptionLabel: 'Describe your community (optional)',
    descriptionHelp: 'A sentence or two is enough. We use it to suggest page types.',
    suggest: 'Suggest page types',
    suggesting: 'Suggesting…',
    suggestingAnnouncement: 'Suggesting page types.',
    newLabel: 'New page type',
    add: 'Add a type',
    atMax: 'You can have up to 8 page types.',
    alwaysIncluded: 'Always included: Blog, Content, Dialog, News and Reference.',
    fallback: 'We couldn\'t suggest types just now. You can add your own, or skip this.',
    tooMany: 'You\'ve asked for suggestions a lot. Wait a bit, or add your own types.',
    tooShort: 'Write at least 10 characters so we can make useful suggestions.',
    tooLong: 'Keep it to 400 characters or fewer.'
  },
  code: {
    open: 'I have a code',
    label: 'Code',
    apply: 'Apply code',
    prefilledHelp: 'Your invite includes this code.',
    accepted: 'Code applied. It\'s used when we start your subscription, once your site is live.'
  },
  submit: {
    button: 'Continue to card details',
    working: 'Redirecting to card details…',
    under: 'We\'ll save your card now and charge it only once your site is live.',
    checkoutFailed: 'We couldn\'t start checkout. Try again in a moment.',
    summaryHeading: 'Fix these to continue'
  },
  full: {
    title: 'Waiting for Room',
    // The same words as server/utils/capacity.ts FULL_MESSAGE (a test keeps them equal).
    alert: 'We\'re full right now. We\'ll email you when there\'s room.',
    line: 'You haven\'t been charged.'
  }
} as const

/** "5 page types suggested. You can edit them." */
export const suggestedAnnouncement = (count: number) => `${count} page types suggested. You can edit them.`
/** "Page type 1", "Page type 2" … */
export const rowLabel = (index: number) => `Page type ${index + 1}`
/** The icon-only remove button's accessible name. */
export const removeLabel = (type: string) => `Remove ${type}`
/** Polite announcement after a row is removed. */
export const removedAnnouncement = (type: string) => `${type} removed.`
/** The primary button's words, while its request runs and not. */
export const submitLabel = (submitting: boolean) => submitting ? SIGNUP_COPY.submit.working : SIGNUP_COPY.submit.button

// --- page types ---------------------------------------------------------------

const tidy = (label: string) => label.trim().replace(/\s+/g, ' ')

/** True when the list already has this label, ignoring case, or it is one of the always-included types. */
function taken(list: readonly string[], label: string): boolean {
  const key = label.toLowerCase()
  return list.some(t => t.toLowerCase() === key) || DEFAULT_TOPIC_TYPES.some(t => t.toLowerCase() === key)
}

/**
 * Adds a label at the end. A blank label, one equal to a row already there
 * (ignoring case) or to an always-included type, and any label past the 8th,
 * leave the list as it was. The order never changes.
 */
export function addTopicType(list: readonly string[], label: string): string[] {
  const clean = tidy(label)
  if (!clean || list.length >= MAX_PAGE_TYPES || taken(list, clean)) return [...list]
  return [...list, clean]
}

/** Removes the row at index; the rest keep their order. */
export function removeTopicType(list: readonly string[], index: number): string[] {
  return list.filter((_, i) => i !== index)
}

/** Adds suggested labels after the organizer's own, by the same rules as addTopicType. */
export function mergeSuggestions(list: readonly string[], suggested: readonly string[]): { list: string[], added: number } {
  let next = [...list]
  for (const label of suggested) next = addTopicType(next, label)
  return { list: next, added: next.length - list.length }
}

/** The description's own message, or null when it is empty or usable (10 to 400 characters after trimming). */
export function descriptionProblem(description: string): string | null {
  const length = description.trim().length
  if (length === 0) return null
  if (length < MIN_DESCRIPTION) return SIGNUP_COPY.pageTypes.tooShort
  if (length > MAX_DESCRIPTION) return SIGNUP_COPY.pageTypes.tooLong
  return null
}

// --- server calls ---------------------------------------------------------------

/** What a call to $fetch looks like to this module (ofetch throws with statusCode, status and data). */
export type Fetcher = (url: string, opts: { method: 'GET' | 'POST', body?: Record<string, unknown> }) => Promise<unknown>

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number, status?: number } | null
  return e?.statusCode ?? e?.status
}

/** The message the server put in an error reply ({message} bodies, and h3's createError statusMessage). */
function messageOf(err: unknown): string | undefined {
  const data = (err as { data?: { message?: unknown, statusMessage?: unknown } } | null)?.data
  const message = data?.message ?? data?.statusMessage
  return typeof message === 'string' && message ? message : undefined
}

export type SuggestResult =
  | { kind: 'suggested', types: string[] }
  | { kind: 'fallback' }
  | { kind: 'too-many' }
  | { kind: 'invalid', message: string }

/**
 * Asks POST /api/suggest-topic-types (23-30). An empty list is the fallback;
 * a 429 is "too many"; a 400 carries the UI-SPEC length message. A 503 (the
 * limiter can't count), a 404 or anything else shows the fallback line: the
 * person can still add their own types or skip, and nothing blocks checkout.
 */
export async function suggestTopicTypes(fetcher: Fetcher, description: string): Promise<SuggestResult> {
  try {
    const res = await fetcher('/api/suggest-topic-types', { method: 'POST', body: { description } }) as { types?: unknown } | null
    const types = Array.isArray(res?.types) ? res.types.filter((t): t is string => typeof t === 'string') : []
    return types.length ? { kind: 'suggested', types } : { kind: 'fallback' }
  } catch (err) {
    const status = statusOf(err)
    if (status === 429) return { kind: 'too-many' }
    if (status === 400) return { kind: 'invalid', message: messageOf(err) ?? SIGNUP_COPY.pageTypes.tooShort }
    return { kind: 'fallback' }
  }
}

export type KeyCheckResult =
  | { kind: 'checked' }
  /** field: where the message goes. kept: whether the server still holds an earlier key for this session. */
  | { kind: 'refused', message: string, field: 'key' | 'billing', kept: boolean }

/**
 * POST /api/ai-key {kind, key, billingConfirmed} (23-18). A new check deletes
 * the session's earlier key before the rate limit, the secret check and the
 * provider call, so every refusal except the billing one and a 404 leaves no
 * key kept: the form goes back to "not checked". The key is only ever in the
 * request body, never in a reply, a message or a log.
 */
export async function checkAiKey(fetcher: Fetcher, kind: OwnKeyKind, key: string, billingConfirmed: boolean): Promise<KeyCheckResult> {
  try {
    const res = await fetcher('/api/ai-key', { method: 'POST', body: { kind, key, billingConfirmed } }) as { ok?: boolean } | null
    if (res?.ok === true) return { kind: 'checked' }
    return { kind: 'refused', message: KEY_FAILED_MESSAGE, field: 'key', kept: false }
  } catch (err) {
    const status = statusOf(err)
    const message = messageOf(err)
    if (status === 400 && message === GEMINI_BILLING_MESSAGE) return { kind: 'refused', message, field: 'billing', kept: true }
    if (status === 404) return { kind: 'refused', message: SERVER_ERROR_MESSAGE, field: 'key', kept: true }
    return { kind: 'refused', message: message ?? SERVER_ERROR_MESSAGE, field: 'key', kept: false }
  }
}

export type CodeResult = { kind: 'accepted' } | { kind: 'refused', message: string }

/**
 * POST /api/check-code {code} (23-15). The server gives one message for every
 * refusal, and the form shows it as it comes.
 */
export async function applyCode(fetcher: Fetcher, code: string): Promise<CodeResult> {
  try {
    const res = await fetcher('/api/check-code', { method: 'POST', body: { code } }) as { ok?: boolean } | null
    return res?.ok === true ? { kind: 'accepted' } : { kind: 'refused', message: SERVER_ERROR_MESSAGE }
  } catch (err) {
    return { kind: 'refused', message: messageOf(err) ?? SERVER_ERROR_MESSAGE }
  }
}

export type PriceResult = { kind: 'price', line: string } | { kind: 'unavailable', message: string }

/** GET /api/price (23-31): the line above the button, for example "$20 a month". */
export async function readPrice(fetcher: Fetcher): Promise<PriceResult> {
  try {
    const res = await fetcher('/api/price', { method: 'GET' }) as { line?: unknown } | null
    if (typeof res?.line === 'string' && res.line) return { kind: 'price', line: res.line }
  } catch {
    // Every failure reads the same to the person.
  }
  return { kind: 'unavailable', message: SIGNUP_COPY.submit.checkoutFailed }
}

/** The form's state at submit, as the checkout body needs it. */
export interface CheckoutInput {
  communityName: string
  subdomain: string
  description: string
  topicTypes: readonly string[]
  aiChoice: AiChoice
  code: string
  /** Only for the public flow (launch open, no invite); an invited checkout takes the invite's address. */
  email?: string
  /** The browser's IANA time zone (23-32); the server keeps it only when it is a real zone name. */
  timeZone?: string
}

/** The browser's IANA time zone, for the times in the payment mails (23-32, 23-37); none when Intl can't say. */
export function browserTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone ? zone : undefined
  } catch {
    return undefined
  }
}

/** The create-checkout body: name, address, description, page types, AI choice and code (T-2, 23-18, 23-15). */
export function checkoutBody(input: CheckoutInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    communityName: input.communityName.trim(),
    subdomain: input.subdomain,
    description: input.description.trim(),
    topicTypes: [...input.topicTypes],
    aiChoice: input.aiChoice,
    code: input.code.trim()
  }
  if (input.email !== undefined) body.email = input.email.trim()
  if (input.timeZone) body.timeZone = input.timeZone
  return body
}

export type CheckoutResult =
  | { kind: 'redirect', url: string }
  | { kind: 'key', message: string }
  | { kind: 'refused', message: string }
  | { kind: 'failed', message: string }

/**
 * POST /api/create-checkout. A "Check your key before continuing." refusal goes
 * to the key field; a 409 (full server, a used invite, a code that can't be
 * used) is shown as the server words it; anything else is the inline
 * "couldn't start checkout" alert.
 */
export async function startCheckout(fetcher: Fetcher, body: Record<string, unknown>): Promise<CheckoutResult> {
  try {
    const res = await fetcher('/api/create-checkout', { method: 'POST', body }) as { url?: unknown } | null
    if (typeof res?.url === 'string' && res.url) return { kind: 'redirect', url: res.url }
  } catch (err) {
    const status = statusOf(err)
    const message = messageOf(err)
    if (status === 400 && message === KEY_NOT_CHECKED_MESSAGE) return { kind: 'key', message }
    if (status === 409 && message) return { kind: 'refused', message }
  }
  return { kind: 'failed', message: SIGNUP_COPY.submit.checkoutFailed }
}
