import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick, computed } from 'vue'

// Mock $fetch globally before importing the composable
vi.stubGlobal('$fetch', vi.fn())

// Mock @vueuse/core's refDebounced to pass through immediately (no debounce delay)
// This makes tests synchronous and avoids timer issues
vi.mock('@vueuse/core', () => ({
  refDebounced: (source: any, _delay: number) => {
    // Return a computed that tracks source value immediately
    return computed(() => source.value)
  }
}))

import { useSubdomain } from '~/composables/useSubdomain'

describe('useSubdomain', () => {
  beforeEach(() => {
    vi.mocked($fetch).mockReset()
  })

  it('computes slug from communityName', () => {
    const name = ref('My Community')
    const { slug } = useSubdomain(name)
    expect(slug.value).toBe('my-community')
  })

  it('computes subdomain format from slug', () => {
    const name = ref('My Community')
    const { subdomain } = useSubdomain(name)
    expect(subdomain.value).toBe('my-community.localnodes.xyz')
  })

  it('returns empty subdomain for empty communityName', () => {
    const name = ref('')
    const { subdomain, availability } = useSubdomain(name)
    expect(subdomain.value).toBe('')
    expect(availability.value).toBe('idle')
  })

  it('starts with idle availability', () => {
    const name = ref('')
    const { availability } = useSubdomain(name)
    expect(availability.value).toBe('idle')
  })

  it('transitions to available after successful check', async () => {
    vi.mocked($fetch).mockResolvedValue({ available: true, reason: null })

    const name = ref('')
    const { availability } = useSubdomain(name)

    name.value = 'Test Community'
    // Allow watchers to fire
    await nextTick()
    // Allow $fetch promise to resolve
    await nextTick()
    // Allow availability update
    await nextTick()

    expect(vi.mocked($fetch)).toHaveBeenCalledWith('/api/check-subdomain', {
      query: { slug: 'test-community' }
    })
    expect(availability.value).toBe('available')
  })

  it('transitions to taken when subdomain is taken', async () => {
    vi.mocked($fetch).mockResolvedValue({ available: false, reason: 'This subdomain is already in use' })

    const name = ref('')
    const { availability, errorMessage } = useSubdomain(name)

    name.value = 'Cascadia'
    await nextTick()
    await nextTick()
    await nextTick()

    expect(availability.value).toBe('taken')
    expect(errorMessage.value).toBe('This subdomain is already in use')
  })

  it('transitions to invalid on fetch error', async () => {
    vi.mocked($fetch).mockRejectedValue(new Error('Network error'))

    const name = ref('')
    const { availability, errorMessage } = useSubdomain(name)

    name.value = 'Test Community'
    await nextTick()
    await nextTick()
    await nextTick()

    expect(availability.value).toBe('invalid')
    expect(errorMessage.value).toBe('Could not check availability')
  })

  it('stays idle for short slugs (< 3 chars) and does not call $fetch', async () => {
    const name = ref('')
    const { availability } = useSubdomain(name)

    name.value = 'ab'
    await nextTick()
    await nextTick()
    await nextTick()

    expect(availability.value).toBe('idle')
    expect(vi.mocked($fetch)).not.toHaveBeenCalled()
  })
})
