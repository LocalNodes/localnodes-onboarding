import { ref, computed, watch, type Ref } from 'vue'
import { refDebounced } from '@vueuse/core'
import { slugify } from '~/utils/slugify'

export type AvailabilityStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid'

export function useSubdomain(communityName: Ref<string>) {
  const slug = computed(() => slugify(communityName.value))
  const debouncedSlug = refDebounced(slug, 500)
  const availability = ref<AvailabilityStatus>('idle')
  const errorMessage = ref<string | null>(null)

  // Immediate feedback: when slug changes and differs from debounced, show 'checking'
  watch(slug, (newSlug) => {
    if (newSlug && newSlug.length >= 3 && newSlug !== debouncedSlug.value) {
      availability.value = 'checking'
      errorMessage.value = null
    } else if (!newSlug || newSlug.length < 3) {
      availability.value = 'idle'
      errorMessage.value = null
    }
  })

  // Debounced API call
  watch(debouncedSlug, async (newSlug) => {
    if (!newSlug || newSlug.length < 3) {
      availability.value = 'idle'
      errorMessage.value = null
      return
    }

    availability.value = 'checking'
    errorMessage.value = null

    try {
      const result = await $fetch<{ available: boolean; reason: string | null }>('/api/check-subdomain', {
        query: { slug: newSlug }
      })

      availability.value = result.available ? 'available' : 'taken'
      errorMessage.value = result.reason
    } catch {
      availability.value = 'invalid'
      errorMessage.value = 'Could not check availability'
    }
  })

  const subdomain = computed(() => slug.value ? `${slug.value}.localnodes.xyz` : '')

  return { slug, subdomain, availability, errorMessage }
}
