// Promises the home page makes that are not yet true for a paying community.
//
// The page describes the product as it will be at launch. Each entry below is
// one sentence or heading on the page that is not yet true for a hosted,
// paying community, with what has to happen before it is. Two checks hold the
// list to the page:
// - The build: with the launch flag open (NUXT_LAUNCH_OPEN), a production
//   build fails while any entry is not ready (nuxt.config.ts). Sign-ups cannot
//   open while a promise is pending. Mark an entry ready in a reviewed change
//   once it is true, or change the sentence on the page.
// - The page: every entry's text must be on the rendered home page, word for
//   word (scripts/check-landing-claims.mjs on the built page, and the unit
//   tests on the rendered components). Reword or remove the sentence and the
//   check fails until the entry is updated or removed.
//
// Plain module, Node built-ins only and no Nuxt globals: the claims script,
// nuxt.config.ts and the tests all import it.

/**
 * @typedef {object} LaunchClaim
 * @property {string} id      Short name for the promise.
 * @property {string} text    The exact sentence or heading on the home page.
 * @property {boolean} ready  True only once the promise holds for a paying community.
 * @property {string} until   What makes it true.
 */

/** @type {readonly LaunchClaim[]} */
export const LAUNCH_CLAIMS = Object.freeze([
  {
    id: 'deciding',
    text: 'Decide in the open, with everyone who has a say.',
    ready: false,
    until: 'Deciding together (agree, stand aside, block) is in a release that hosted communities run.'
  },
  {
    id: 'real-fund',
    text: 'Open your real fund when the group is ready.',
    ready: false,
    until: 'A community can open a fund with real money; practice money works first.'
  },
  {
    id: 'export',
    text: 'If you ever want to move, one button will give you everything your community has put here.',
    ready: false,
    until: 'A site manager can press the export button on a hosted site and download the archive.'
  },
  {
    id: 'ownership',
    text: 'Your community owns it, not a platform.',
    ready: false,
    until: 'The site terms say the community owns its site and content.'
  },
  {
    id: 'privacy',
    text: 'What we keep: your email address, and your community\'s name and kind of group if you give them.',
    ready: false,
    until: 'The privacy block lists everything the sign-up site keeps, and for how long.'
  }
].map(c => Object.freeze(c)))

/** The launch flag as nuxt.config.ts reads it: open only for "true" or "1". */
export function isLaunchFlagOpen(value) {
  return value === 'true' || value === '1'
}

/** Entries not marked ready. Anything other than `ready: true` counts as pending. */
export function pendingClaims(claims = LAUNCH_CLAIMS) {
  return claims.filter(c => c.ready !== true)
}

/**
 * Why a build with this launch flag must stop, or null when it may go ahead:
 * the flag is open and at least one promise is pending.
 */
export function launchGateProblem(flag, claims = LAUNCH_CLAIMS) {
  if (!isLaunchFlagOpen(flag)) return null
  const pending = pendingClaims(claims)
  if (!pending.length) return null
  return [
    `Sign-ups cannot open: ${pending.length} home page promise(s) are not ready (shared/launch-claims.mjs).`,
    ...pending.map(c => `- ${c.id}: "${c.text}" Needs: ${c.until}`),
    'Mark an entry ready once it is true, or change the sentence on the page, then build again.'
  ].join('\n')
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
