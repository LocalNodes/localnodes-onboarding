// The launch claims list and the build gate that reads it
// (shared/launch-claims.mjs, nuxt.config.ts): sign-ups cannot open while a
// promise on the home page or the Who it's for page is pending.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LAUNCH_CLAIMS, CLAIM_PAGES, claimsOn, isLaunchFlagOpen, mightOpen, serverLaunchOpen, pendingClaims, launchGateProblem, missingClaims } from '../../shared/launch-claims.mjs'
import { isLaunchOpen } from '../../shared/launch'

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

const ready = (id: string) => ({ id, page: '/' as const, text: `${id} sentence.`, ready: true, until: 'done', evidence: 'a merged pull request' })
const pending = (id: string) => ({ id, page: '/' as const, text: `${id} sentence.`, ready: false, until: `${id} ships` })

describe('the launch flag', () => {
  it('is open only for "true" or "1", the same values the sign-up gate reads from the env var', () => {
    for (const v of ['true', '1']) {
      expect(isLaunchFlagOpen(v)).toBe(true)
      expect(isLaunchOpen(v)).toBe(true)
    }
    for (const v of [undefined, '', 'false', '0', 'TRUE', ' true', 'yes']) {
      expect(isLaunchFlagOpen(v)).toBe(false)
      expect(isLaunchOpen(v)).toBe(false)
    }
  })

  it('nuxt.config.ts reads the flag and runs the gate through the shared module', () => {
    const config = read('nuxt.config.ts')
    expect(config).toContain('const launchOpen = isLaunchFlagOpen(process.env.NUXT_LAUNCH_OPEN)')
    expect(config).toContain('launchGateProblem(process.env.NUXT_LAUNCH_OPEN) ?? launchGateProblem(process.env.NITRO_LAUNCH_OPEN)')
    expect(config).toMatch(/if \(problem\) throw new Error\(problem\)/)
    expect(config.match(/process\.env\.NUXT_LAUNCH_OPEN/g)).toHaveLength(2)
    // The gate skips dev and prepare runs only (neither writes a build); nothing else turns it off.
    const gate = config.slice(config.indexOf('(_options, nuxt) => {'), config.indexOf('if (problem) throw'))
    expect(gate).toContain('if (nuxt.options.dev || nuxt.options._prepare) return')
    expect(gate).not.toContain('options.test')
    expect(gate.match(/return/g)).toHaveLength(1)
  })
})

describe('the build gate', () => {
  it('stops an open build while any promise is pending, naming each one', () => {
    const claims = [ready('a'), pending('b'), { ...pending('c'), page: '/for' as const }]
    for (const flag of ['true', '1']) {
      const problem = launchGateProblem(flag, claims)
      expect(problem).toMatch(/^Sign-ups cannot open: 2 page promise/)
      expect(problem).toContain('- b on /: "b sentence." Needs: b ships')
      expect(problem).toContain('- c on /for: "c sentence." Needs: c ships')
      expect(problem).not.toContain('- a ')
    }
  })

  it('lets a closed build through whatever is pending', () => {
    for (const flag of [undefined, '', 'false', '0', ' FALSE ']) expect(launchGateProblem(flag, [pending('b')])).toBeNull()
  })

  it('stops on any value the server might read as open, not only "true" and "1"', () => {
    for (const flag of ['TRUE', ' true', '1.0', '"true"', 'yes', 'on']) {
      expect(mightOpen(flag)).toBe(true)
      expect(launchGateProblem(flag, [pending('b')])).not.toBeNull()
    }
  })

  it('lets an open build through once every promise is ready', () => {
    expect(launchGateProblem('true', [ready('a'), ready('b')])).toBeNull()
  })

  it('counts anything other than ready: true as pending', () => {
    const odd = [{ ...ready('x'), ready: 'true' }, { ...ready('y'), ready: 1 }, { id: 'z', text: 'z.', until: 'z' }]
    expect(pendingClaims(odd as never).map(c => c.id)).toEqual(['x', 'y', 'z'])
  })

  it('stops an open build today: the real list has pending promises', () => {
    expect(pendingClaims().length).toBeGreaterThan(0)
    expect(launchGateProblem('true')).not.toBeNull()
  })
})

describe('the list', () => {
  it('has unique ids, one sentence each, and says what makes each true', () => {
    expect(new Set(LAUNCH_CLAIMS.map(c => c.id)).size).toBe(LAUNCH_CLAIMS.length)
    for (const c of LAUNCH_CLAIMS) {
      expect(c.text.trim()).toBe(c.text)
      expect(c.text.length).toBeGreaterThan(10)
      expect(c.until.length).toBeGreaterThan(10)
      expect(typeof c.ready).toBe('boolean')
    }
  })

  it('names the page each promise is on, and both pages have promises', () => {
    expect([...CLAIM_PAGES]).toEqual(['/', '/for'])
    for (const c of LAUNCH_CLAIMS) expect(CLAIM_PAGES, c.id).toContain(c.page)
    for (const page of CLAIM_PAGES) expect(claimsOn(page).length, page).toBeGreaterThan(0)
    expect(claimsOn('/').length + claimsOn('/for').length).toBe(LAUNCH_CLAIMS.length)
  })

  it('names the public pull request and merge commit for every ready promise, and none for a pending one', () => {
    for (const c of LAUNCH_CLAIMS) {
      if (c.ready) {
        expect(c.evidence, c.id).toMatch(/^https:\/\/github\.com\/LocalNodes\/[\w-]+\/pull\/\d+, "[^"]+", merged as commit [0-9a-f]{7,40}\.$/)
      } else {
        expect(c.evidence, c.id).toBeUndefined()
      }
    }
  })

  it('lists the calendar and quick-poll sentences of the Who it\'s for page as live, with the pull request that shipped them', () => {
    const live = claimsOn('/for').filter(c => /\b(?:polls?|calendars?)\b/i.test(c.text))
    expect(live.length).toBeGreaterThan(0)
    for (const c of live) {
      expect(c.ready, c.id).toBe(true)
      expect(c.evidence, c.id).toBe('https://github.com/LocalNodes/os-knowledge-garden/pull/73, "A month calendar for events and quick polls in groups", merged as commit 8767385.')
    }
  })

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(LAUNCH_CLAIMS)).toBe(true)
    for (const c of LAUNCH_CLAIMS) expect(Object.isFrozen(c)).toBe(true)
  })

  it('finds a missing or reworded sentence, and reads across whitespace', () => {
    const claims = [pending('one'), pending('two')]
    expect(missingClaims('one sentence. two sentence.', claims)).toEqual([])
    expect(missingClaims('one\n   sentence.  two sentence.', claims)).toEqual([])
    expect(missingClaims('one sentence. two sentences.', claims).map(c => c.id)).toEqual(['two'])
    expect(missingClaims('', claims).map(c => c.id)).toEqual(['one', 'two'])
  })
})

describe('the server gate', () => {
  it('a production server stays closed while any promise is pending, whatever the flag', () => {
    expect(serverLaunchOpen(true, { dev: false, claims: [ready('a'), pending('b')] })).toBe(false)
    expect(serverLaunchOpen(true, { dev: undefined, claims: [pending('b')] })).toBe(false)
    expect(serverLaunchOpen(true, { dev: false })).toBe(false)
  })

  it('opens with the flag once every promise is ready, and never without the flag', () => {
    expect(serverLaunchOpen(true, { dev: false, claims: [ready('a')] })).toBe(true)
    expect(serverLaunchOpen(false, { dev: false, claims: [ready('a')] })).toBe(false)
    expect(serverLaunchOpen(false, { dev: true, claims: [ready('a')] })).toBe(false)
  })

  it('a dev server follows the flag alone, as the build gate does', () => {
    expect(serverLaunchOpen(true, { dev: true, claims: [pending('b')] })).toBe(true)
  })

  it('the server middleware decides through it, with the build\'s dev value', () => {
    const src = read('server/middleware/launch-gate.ts')
    expect(src).toContain('const open = serverLaunchOpen(isLaunchOpen(useRuntimeConfig(event).launchOpen), { dev: import.meta.dev })')
  })
})
