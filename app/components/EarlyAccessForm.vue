<script setup lang="ts">
import { GROUP_KINDS } from '~/utils/group-kinds'
// Early-access form (Tom, 2026-11-06, PR #9). Posts to /api/early-access
// (server/utils/early-access.ts): email, optional community name, optional
// kind of group, plus a honeypot field people never see. The server answers
// every accepted request the same way, so this form shows one thank-you
// whatever happened to the address.
// Accessibility (Codex P2): a live region that is always in the page (empty
// at first) announces the result; on success the confirmation takes focus;
// an email error is tied to the email field: UFormField's `error` sets the
// input's aria-describedby to the error text's id and aria-invalid (checked in
// the browser, 2026-11-06).
// The group-kind list opens in a popup that Nuxt UI puts on <body>, outside the band that
// carries the colour context. The home page's dark close passes its classes here so the
// popup is dark as well; other pages pass nothing.
defineProps<{ popupClass?: string }>()

const email = ref('')
const community = ref('')
const groupKind = ref<string | undefined>(undefined)
const hpField = ref('') // honeypot
const state = ref<'idle' | 'sending' | 'done' | 'error'>('idle')
const message = ref('')
const emailError = ref('')
const announce = ref('')
const confirmation = ref<HTMLElement | null>(null)

// Group kinds: D-14 applies here (a pre-launch interest form on the landing
// page, not the provisioning sign-up flow D-05 covers; orchestrator ruling,
// 2026-11-06). Neighborhood or tenant group and Mutual aid network added by
// Tom, 2026-11-06.
// Labels and stored values live in ~/utils/group-kinds.
const kinds: Array<{ label: string, value: string }> = GROUP_KINDS.map(k => ({ label: k.label, value: k.value }))

async function submit() {
  if (state.value === 'sending') return
  state.value = 'sending'
  message.value = ''
  emailError.value = ''
  announce.value = ''
  try {
    const res = await $fetch<{ ok: boolean, message: string }>('/api/early-access', {
      method: 'POST',
      body: { email: email.value, community: community.value, groupKind: groupKind.value ?? '', hpField: hpField.value }
    })
    state.value = 'done'
    message.value = res.message
    announce.value = res.message
    await nextTick()
    confirmation.value?.focus()
  } catch (err) {
    const e = err as { statusCode?: number, status?: number, data?: { message?: string } }
    const text = e?.data?.message ?? 'Something went wrong. Please try again.'
    state.value = 'error'
    if ((e?.statusCode ?? e?.status) === 400) emailError.value = text
    else message.value = text
    announce.value = text
  }
}
</script>

<template>
  <div class="w-full max-w-xl">
    <!-- Always present, empty at first, so screen readers announce changes. -->
    <p role="status" aria-live="polite" class="sr-only">{{ announce }}</p>

    <p
      v-if="state === 'done'"
      ref="confirmation"
      tabindex="-1"
      class="rounded-lg border border-default bg-elevated p-5 text-base text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      {{ message }}
    </p>

    <form v-else class="relative flex flex-col gap-4 text-left" novalidate @submit.prevent="submit">
      <UFormField label="Email" name="email" required :error="emailError || undefined">
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
        <USelect v-model="groupKind" :items="kinds" size="xl" class="w-full" placeholder="Choose one" :ui="{ content: popupClass }" />
      </UFormField>

      <!-- Honeypot: hidden from people and screen readers; bots fill it. -->
      <div aria-hidden="true" class="absolute -left-[9999px] w-px h-px overflow-hidden">
        <label for="ea-hp">Leave this empty</label>
        <input id="ea-hp" v-model="hpField" type="text" name="ea_hp_field" tabindex="-1" autocomplete="off">
      </div>

      <p v-if="message" id="ea-form-error" class="text-error">
        {{ message }}
      </p>

      <UButton
        type="submit"
        label="Get early access"
        size="xl"
        color="primary"
        :loading="state === 'sending'"
        :aria-describedby="message ? 'ea-form-error' : undefined"
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
