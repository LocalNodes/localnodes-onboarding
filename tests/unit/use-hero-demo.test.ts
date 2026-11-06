// The hero's typing search box follows prefers-reduced-motion live (Codex,
// PR #8): turning reduce on mid-cycle stops the timer and shows question 1,
// still, with no pause button; turning it off resumes; unmount removes the
// listener.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useHeroDemo, type DemoQA } from '~/composables/useHeroDemo'

const items: DemoQA[] = [
  { q: 'Question one?', a: 'Answer one.', chip: '[1] One', coming: false },
  { q: 'Question two?', a: 'Answer two.', chip: 'Coming', coming: true }
]

function fakeMql(matches: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>()
  return {
    matches,
    addEventListener: vi.fn((_t: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn)),
    removeEventListener: vi.fn((_t: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn)),
    fire(m: boolean) {
      this.matches = m
      for (const fn of listeners) fn({ matches: m })
    },
    get count() {
      return listeners.size
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useHeroDemo', () => {
  it('renders question 1 in full before mount (SSR, no JS)', () => {
    const d = useHeroDemo(items)
    expect(d.typed.value).toBe('Question one?')
    expect(d.showAnswer.value).toBe(true)
    expect(d.animating.value).toBe(false)
  })

  it('stays still on question 1 when reduced motion is on at mount', () => {
    const mql = fakeMql(true)
    const d = useHeroDemo(items, { matchMedia: () => mql })
    d.mount()
    vi.advanceTimersByTime(60_000)
    expect(d.animating.value).toBe(false)
    expect(d.index.value).toBe(0)
    expect(d.typed.value).toBe('Question one?')
  })

  it('cycles when motion is allowed', () => {
    const mql = fakeMql(false)
    const d = useHeroDemo(items, { matchMedia: () => mql })
    d.mount()
    expect(d.animating.value).toBe(true)
    vi.advanceTimersByTime(4000)
    expect(d.index.value).toBe(1)
  })

  it('stops and shows question 1, still, when reduce turns on mid-cycle', () => {
    const mql = fakeMql(false)
    const d = useHeroDemo(items, { matchMedia: () => mql })
    d.mount()
    vi.advanceTimersByTime(4100) // on question 2, typing
    expect(d.index.value).toBe(1)
    mql.fire(true)
    expect(d.animating.value).toBe(false) // pause button hidden
    expect(d.paused.value).toBe(false)
    expect(d.index.value).toBe(0)
    expect(d.typed.value).toBe('Question one?')
    expect(d.showAnswer.value).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(d.index.value).toBe(0) // timer really stopped
    expect(d.typed.value).toBe('Question one?')
  })

  it('resumes when reduce turns off again', () => {
    const mql = fakeMql(true)
    const d = useHeroDemo(items, { matchMedia: () => mql })
    d.mount()
    mql.fire(false)
    expect(d.animating.value).toBe(true)
    vi.advanceTimersByTime(4000)
    expect(d.index.value).toBe(1)
  })

  it('removes the listener and the timer on unmount', () => {
    const mql = fakeMql(false)
    const d = useHeroDemo(items, { matchMedia: () => mql })
    d.mount()
    expect(mql.count).toBe(1)
    d.unmount()
    expect(mql.count).toBe(0)
    expect(mql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    const at = d.index.value
    vi.advanceTimersByTime(60_000)
    expect(d.index.value).toBe(at)
  })
})
