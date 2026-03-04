<script setup lang="ts">
import { onboardingSchema, type OnboardingSchema } from '~/utils/onboarding-schema'

const state = reactive<OnboardingSchema>({
  communityName: '',
  email: ''
})

const { slug, subdomain, availability, errorMessage } = useSubdomain(
  toRef(() => state.communityName)
)

const canSubmit = computed(() => availability.value === 'available')

async function onSubmit() {
  if (availability.value !== 'available') return
  console.log('Onboarding form submitted:', { ...state, slug: slug.value })
  await navigateTo('/onboarding/confirm')
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
        label="Continue to Payment"
        block
        size="xl"
        :disabled="!canSubmit || availability === 'checking'"
        :loading="availability === 'checking'"
      />
      <p class="mt-2 text-center text-sm text-(--ui-text-muted)">
        You'll be charged $29/month
      </p>
    </div>
  </UForm>
</template>
