import { ref, computed } from 'vue'

// The hero's typing search box cycle (fresh3 LANDING.md 3.1). It follows
// prefers-reduced-motion live: reduce on means question 1, still, with no
// pause button; reduce off means the cycle runs (Codex review, PR #8). The
// environment (matchMedia, timers) is injectable so the logic is testable in
// node; the component calls mount() and unmount().

export interface DemoQA {
  q: string
  a: string
  chip: string
  coming: boolean
}

interface MqlLike {
  matches: boolean
  addEventListener: (type: 'change', fn: (e: { matches: boolean }) => void) => void
  removeEventListener: (type: 'change', fn: (e: { matches: boolean }) => void) => void
}

export interface HeroDemoEnv {
  matchMedia?: (query: string) => MqlLike
}

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const TYPE_MS = 45
const HOLD_MS = 3800
const BEFORE_ANSWER_MS = 500

export function useHeroDemo(items: DemoQA[], env: HeroDemoEnv = {}) {
  const first = items[0]!
  const index = ref(0)
  // SSR, no JS and reduced motion: question 1 in full, answer shown.
  const typed = ref(first.q)
  const showAnswer = ref(true)
  const animating = ref(false)
  const paused = ref(false)
  const current = computed(() => items[index.value]!)

  let timer: ReturnType<typeof setTimeout> | undefined
  let mql: MqlLike | undefined

  function clear() {
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  function typeNext(pos: number) {
    const q = current.value.q
    if (pos <= q.length) {
      typed.value = q.slice(0, pos)
      timer = setTimeout(() => typeNext(pos + 1), TYPE_MS)
      return
    }
    timer = setTimeout(() => {
      showAnswer.value = true
      timer = setTimeout(advance, HOLD_MS)
    }, BEFORE_ANSWER_MS)
  }

  function advance() {
    index.value = (index.value + 1) % items.length
    start()
  }

  function start() {
    clear()
    showAnswer.value = false
    typed.value = ''
    typeNext(0)
  }

  /** Question 1, still: the reduced-motion and SSR state. */
  function still() {
    clear()
    animating.value = false
    paused.value = false
    index.value = 0
    typed.value = first.q
    showAnswer.value = true
  }

  /** Begin cycling from the still question 1 (hold it first, then advance). */
  function run() {
    clear()
    animating.value = true
    paused.value = false
    timer = setTimeout(advance, HOLD_MS)
  }

  function onChange(e: { matches: boolean }) {
    if (e.matches) still()
    else if (!animating.value) run()
  }

  function togglePause() {
    if (!animating.value) return
    if (paused.value) {
      paused.value = false
      start()
    } else {
      paused.value = true
      clear()
      typed.value = current.value.q
      showAnswer.value = true
    }
  }

  function mount() {
    const mm = env.matchMedia ?? (typeof window !== 'undefined' ? window.matchMedia.bind(window) : undefined)
    if (!mm) return
    mql = mm(REDUCED_MOTION_QUERY)
    mql.addEventListener('change', onChange)
    if (!mql.matches) run()
  }

  function unmount() {
    clear()
    mql?.removeEventListener('change', onChange)
    mql = undefined
  }

  return { index, typed, showAnswer, animating, paused, current, togglePause, mount, unmount }
}
