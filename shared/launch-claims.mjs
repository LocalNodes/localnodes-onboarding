// Promises the public pages make, and whether each is true for a paying
// community yet.
//
// The home page and the "Who it's for" page describe the product as it will be
// at launch. Each entry below is one sentence or heading on one of those pages
// (`page`: '/' or '/for'), with what has to happen before it is true. An entry
// that is already true is marked ready and names its evidence: the public pull
// request that shipped it. Three checks hold the list to the pages:
// - The build: with the launch flag open (NUXT_LAUNCH_OPEN), a production
//   build fails while any entry is not ready (nuxt.config.ts). Sign-ups cannot
//   open while a promise is pending. Mark an entry ready in a reviewed change
//   once it is true, with its evidence, or change the sentence on the page.
// - The pages: every entry's text must be on its own page, word for word
//   (scripts/check-landing-claims.mjs on the built pages, and the unit tests on
//   the rendered components). Reword or remove the sentence and the check fails
//   until the entry is updated or removed.
// - The topic words: on the "Who it's for" page, a sentence about deciding,
//   money, export, ownership, polls or the calendar fails the claims check
//   unless it is on this list word for word (pendingTopicWords in
//   tests/fixtures/banned-claims.json).
//
// Plain module, Node built-ins only and no Nuxt globals: the claims script,
// nuxt.config.ts and the tests all import it.

/**
 * @typedef {object} LaunchClaim
 * @property {string} id          Short name for the promise.
 * @property {'/' | '/for'} page  The page that says it.
 * @property {string} text        The exact sentence or heading on that page.
 * @property {boolean} ready      True only once the promise holds for a paying community.
 * @property {string} until       What makes it true.
 * @property {string} [evidence]  For a ready entry: the public pull request that made it true.
 */

/** The pages the list covers. */
export const CLAIM_PAGES = Object.freeze(['/', '/for'])

// The month calendar and quick polls are merged into the public site
// repository. One pull request ships both.
const CALENDAR_AND_POLLS = 'https://github.com/LocalNodes/os-knowledge-garden/pull/73, "A month calendar for events and quick polls in groups", merged as commit 8767385.'
const CALENDAR = 'A group\'s events show on a month calendar.'
const QUICK_POLLS = 'A member can ask a quick question in a group; the others answer once and see the totals.'

/** A sentence on the "Who it's for" page that names the calendar. */
const calendar = (id, text) => ({ id, page: '/for', text, ready: true, until: CALENDAR, evidence: CALENDAR_AND_POLLS })
/** A sentence on the "Who it's for" page that names a quick poll. */
const quickPoll = (id, text) => ({ id, page: '/for', text, ready: true, until: QUICK_POLLS, evidence: CALENDAR_AND_POLLS })

/** @type {readonly LaunchClaim[]} */
export const LAUNCH_CLAIMS = Object.freeze([
  {
    id: 'deciding',
    page: '/',
    text: 'Decide in the open, with everyone who has a say.',
    ready: false,
    until: 'Deciding together (agree, stand aside, block) is in a release that hosted communities run.'
  },
  {
    id: 'real-fund',
    page: '/',
    text: 'Open your real fund when the group is ready.',
    ready: false,
    until: 'A community can open a fund with real money; practice money works first.'
  },
  {
    id: 'export',
    page: '/',
    text: 'If you ever want to move, one button will give you everything your community has put here.',
    ready: false,
    until: 'A site manager can press the export button on a hosted site and download the archive.'
  },
  {
    id: 'ownership',
    page: '/',
    text: 'Your community owns it, not a platform.',
    ready: false,
    until: 'The site terms say the community owns its site and content.'
  },
  {
    id: 'privacy',
    page: '/',
    text: 'What we keep: your email address, and your community\'s name and kind of group if you give them.',
    ready: false,
    until: 'The privacy block lists everything the sign-up site keeps, and for how long.'
  },
  calendar('calendar-market-day', 'Post the next market day or evening market on the calendar.'),
  calendar('calendar-garden-day', 'Put the garden day on the calendar.'),
  calendar('calendar-open-house', 'Post the next open house on the calendar.'),
  calendar('calendar-shed-cleanup', 'Put the shed cleanup on the calendar.'),
  calendar('calendar-outing', 'Add the next outing or match to the calendar.'),
  calendar('calendar-open-studio', 'Post the open-studio date on the calendar.'),
  calendar('calendar-pick-up-days', 'Put pick-up days and volunteer meetups on the calendar.'),
  quickPoll('poll-garden-day', 'Run a quick poll: Saturday morning or Sunday afternoon?'),
  quickPoll('poll-event-dates', 'Ask which event dates work in a quick poll.')
].map(c => Object.freeze(c)))

/** The entries one page says ('/' or '/for'). */
export function claimsOn(page, claims = LAUNCH_CLAIMS) {
  return claims.filter(c => c.page === page)
}

/** The launch flag as nuxt.config.ts reads it: open only for "true" or "1". */
export function isLaunchFlagOpen(value) {
  return value === 'true' || value === '1'
}

/**
 * Whether a flag value might open sign-ups once the server reads it. The
 * server decodes env values loosely ("TRUE", " true", "1.0" and a quoted
 * "true" all read as open), so the build gate counts every value as open
 * except unset, empty, "false" and "0".
 */
export function mightOpen(value) {
  if (value === undefined) return false
  return !['', 'false', '0'].includes(value.trim().toLowerCase())
}

/** Entries not marked ready. Anything other than `ready: true` counts as pending. */
export function pendingClaims(claims = LAUNCH_CLAIMS) {
  return claims.filter(c => c.ready !== true)
}

/**
 * Why a build with this launch flag must stop, or null when it may go ahead:
 * the flag might open sign-ups and at least one promise is pending.
 */
export function launchGateProblem(flag, claims = LAUNCH_CLAIMS) {
  if (!mightOpen(flag)) return null
  const pending = pendingClaims(claims)
  if (!pending.length) return null
  return [
    `Sign-ups cannot open: ${pending.length} page promise(s) are not ready (shared/launch-claims.mjs).`,
    ...pending.map(c => `- ${c.id} on ${c.page}: "${c.text}" Needs: ${c.until}`),
    'Mark an entry ready once it is true, or change the sentence on the page, then build again.'
  ].join('\n')
}

/**
 * Whether the server may open sign-ups now. In a production server the flag
 * opens nothing while any promise is pending, wherever the flag was set (the
 * build gate cannot see a flag set when the server starts). Dev servers
 * follow the flag alone, the same as the build gate, so the sign-up flow can
 * still be worked on.
 */
export function serverLaunchOpen(flagOpen, { dev, claims = LAUNCH_CLAIMS }) {
  if (!flagOpen) return false
  return dev === true || pendingClaims(claims).length === 0
}

/** Text collapsed the way the checks read a page: whitespace runs become one space. */
function flat(s) {
  return s.replace(/\s+/g, ' ').trim()
}

/** Entries whose text is not in the given visible page text. */
export function missingClaims(pageText, claims = LAUNCH_CLAIMS) {
  const page = flat(pageText)
  return claims.filter(c => !page.includes(flat(c.text)))
}
