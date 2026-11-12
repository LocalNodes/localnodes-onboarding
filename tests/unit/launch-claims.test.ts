// The launch claims list and the build gate that reads it
// (shared/launch-claims.mjs, nuxt.config.ts): sign-ups cannot open while a
// home page promise is pending.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LAUNCH_CLAIMS, isLaunchFlagOpen, pendingClaims, launchGateProblem, missingClaims } from '../../shared/launch-claims.mjs'
import { isLaunchOpen } from '../../shared/launch'

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

const ready = (id: string) => ({ id, text: `${id} sentence.`, ready: true, until: 'done' })
const pending = (id: string) => ({ id, text: `${id} sentence.`, ready: false, until: `${id} ships` })

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
    expect(config).toContain('launchGateProblem(process.env.NUXT_LAUNCH_OPEN)')
    expect(config).toMatch(/if \(problem\) throw new Error\(problem\)/)
    // The flag is read in these two places only.
    expect(config.match(/process\.env\.NUXT_LAUNCH_OPEN/g)).toHaveLength(2)
    // The gate skips dev, prepare and test runs only; nothing else turns it off.
    const gate = config.slice(config.indexOf('(_options, nuxt) => {'), config.indexOf('if (problem) throw'))
    expect(gate).toContain('if (nuxt.options.dev || nuxt.options._prepare || nuxt.options.test) return')
    expect(gate.match(/return/g)).toHaveLength(1)
  })
})

describe('the build gate', () => {
  it('stops an open build while any promise is pending, naming each one', () => {
    const claims = [ready('a'), pending('b'), pending('c')]
    for (const flag of ['true', '1']) {
      const problem = launchGateProblem(flag, claims)
      expect(problem).toMatch(/^Sign-ups cannot open: 2 home page promise/)
      expect(problem).toContain('- b: "b sentence." Needs: b ships')
      expect(problem).toContain('- c: "c sentence." Needs: c ships')
      expect(problem).not.toContain('- a:')
    }
  })

  it('lets a closed build through whatever is pending', () => {
    for (const flag of [undefined, '', 'false', '0']) expect(launchGateProblem(flag, [pending('b')])).toBeNull()
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
