<script setup lang="ts">
// Early-access form (Tom, 2026-11-06, PR #9). Posts to /api/early-access
// (server/utils/early-access.ts): email, optional community name, optional
// kind of group, plus a honeypot field people never see. The server answers
// every accepted request the same way, so this form shows one thank-you
// whatever happened to the address.
const email = ref('')
const community = ref('')
const groupKind = ref<string | undefined>(undefined)
const hpField = ref('') // honeypot
const state = ref<'idle' | 'sending' | 'done' | 'error'>('idle')
const message = ref('')

const kinds = ['Co-op', 'Online guild or DAO', 'Land trust', 'User group or meetup', 'Network of groups', 'Something else']

async function submit() {
  if (state.value === 'sending') return
  state.value = 'sending'
  message.value = ''
  try {
    const res = await $fetch<{ ok: boolean, message: string }>('/api/early-access', {
      method: 'POST',
      body: { email: email.value, community: community.value, groupKind: groupKind.value ?? '', hpField: hpField.value }
    })
    state.value = 'done'
    message.value = res.message
  } catch (err) {
    state.value = 'error'
    const data = (err as { data?: { message?: string } })?.data
    message.value = data?.message ?? 'Something went wrong. Please try again.'
  }
}
</script>

<template>
  <div class="w-full max-w-xl">
    <p v-if="state === 'done'" role="status" class="rounded-lg border border-default bg-elevated p-5 text-lg text-highlighted">
      {{ message }}
    </p>

    <form v-else class="relative flex flex-col gap-4 text-left" novalidate @submit.prevent="submit">
      <UFormField label="Email" name="email" required>
        <UInput
          v-model="email"
          type="email"
          autocomplete="email"
          required
          size="xl"
          class="w-full"
          placeholder="you@example.org"
        />
      </UFormField>
      <UFormField label="Community name" name="community" hint="Optional">
        <UInput v-model="community" autocomplete="organization" size="xl" class="w-full" maxlength="80" />
      </UFormField>
      <UFormField label="What kind of group?" name="groupKind" hint="Optional">
        <USelect v-model="groupKind" :items="kinds" size="xl" class="w-full" placeholder="Choose one" />
      </UFormField>

      <!-- Honeypot: hidden from people and screen readers; bots fill it. -->
      <div aria-hidden="true" class="absolute -left-[9999px] w-px h-px overflow-hidden">
        <label for="ea-hp">Leave this empty</label>
        <input id="ea-hp" v-model="hpField" type="text" name="ea_hp_field" tabindex="-1" autocomplete="off">
      </div>

      <p v-if="state === 'error'" role="alert" class="text-error">
        {{ message }}
      </p>

      <UButton
        type="submit"
        label="Get early access"
        size="xl"
        color="primary"
        :loading="state === 'sending'"
        class="self-start"
      />

      <p class="text-sm text-muted">
        We keep your email, and your community's name and kind of group if you
        give them, only to send you launch news. Every email has an unsubscribe
        link, so you can leave the list any time.
        <ULink to="#privacy" class="text-primary underline underline-offset-2">How we handle your details</ULink>.
      </p>
    </form>
  </div>
</template>
