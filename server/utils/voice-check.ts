// Runtime voice and banned-claims check (Phase 23, plan 23-33, T-2). A twin of
// scripts/check-landing-claims.mjs (compileRow, findBannedHits): it reads the
// same rows from tests/fixtures/banned-claims.json, the `banned` honesty list
// and `voiceRules.rules`, so the build-time check of the landing page and this
// check of generated text share one list. Never copy the rows here.
// `buyerWords` is a sign-up-screen rule (D-05) and does not apply to a
// community's own words on its own site.
import fixture from '../../tests/fixtures/banned-claims.json'

export interface BannedRow {
  pattern: string
  regex?: boolean
  flags?: string
  rule?: string
  reason?: string
}

const ALNUM = /[A-Za-z0-9]/

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Compile one row into a RegExp, exactly as compileRow in the build check does. */
function compileRow(row: BannedRow): RegExp {
  if (row.regex) return new RegExp(row.pattern, row.flags ?? '')
  const p = row.pattern
  const start = ALNUM.test(p[0]!) ? '\\b' : ''
  const end = ALNUM.test(p[p.length - 1]!) ? '\\b' : ''
  return new RegExp(start + escapeRegex(p) + end, 'i')
}

const ROWS: { row: BannedRow, re: RegExp }[] = [
  ...(fixture.banned as BannedRow[]),
  ...(fixture.voiceRules.rules as BannedRow[])
].map(row => ({ row, re: compileRow(row) }))

/** The banned and voice rows that match the text; none means the text is clean. */
export function voiceHits(text: string): BannedRow[] {
  return ROWS.filter(({ re }) => re.test(text)).map(({ row }) => row)
}
