<script setup lang="ts">
import { onboardingSchema, type OnboardingSchema } from '~/utils/onboarding-schema'

const state = reactive<OnboardingSchema>({
  communityName: '',
  email: ''
})

const { slug, subdomain, availability, errorMessage } = useSubdomain(
  toRef(() => state.communityName)
)

const toast = useToast()
const submitting = ref(false)

const canSubmit = computed(() => availability.value === 'available' && !submitting.value)

async function onSubmit() {
  if (availability.value !== 'available' || submitting.value) return

  submitting.value = true
  try {
    const { url } = await $fetch('/api/create-checkout', {
      method: 'POST',
      body: {
        communityName: state.communityName,
        email: state.email,
        subdomain: slug.value
      }
    })

    await navigateTo(url, { external: true })
  } catch (error: any) {
    toast.add({
      title: 'Payment error',
      description: error?.data?.statusText || 'Could not start checkout. Please try again.',
      color: 'error'
    })
    submitting.value = false
  }
}
</script>

<template>
  <UForm
    :schema="onboardingSchema"
    :state="state"
    :validate-on="['blur', 'submit']"
    class="space-y-6"
    @submit="onSubmit"
  >
    <div>
      <UFormField label="Community Name" name="communityName" required>
        <UInput
          v-model="state.communityName"
          placeholder="e.g., Cascadia Bioregion"
          size="xl"
          class="w-full"
          autofocus
        />
      </UFormField>
      <SubdomainPreview :subdomain="subdomain" :availability="availability" />
      <p v-if="errorMessage" class="mt-1 text-sm text-red-500">
        {{ errorMessage }}
      </p>
    </div>

    <UFormField label="Email Address" name="email" required>
      <UInput
        v-model="state.email"
        type="email"
        placeholder="you@example.com"
        size="xl"
        class="w-full"
      />
    </UFormField>

    <div class="pt-2">
      <UButton
        type="submit"
        :label="submitting ? 'Redirecting to payment...' : 'Continue to Payment'"
        block
        size="xl"
        :disabled="!canSubmit || availability === 'checking'"
        :loading="availability === 'checking' || submitting"
      />
      <p class="mt-2 text-center text-sm text-(--ui-text-muted)">
        You'll be charged $29/month
      </p>
    </div>
  </UForm>
</template>
