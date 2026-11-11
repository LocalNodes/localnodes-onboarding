<template>
  <UApp>
    <div class="min-h-screen flex items-center justify-center">
      <UPageHero
        :title="copy.title"
        :description="copy.body"
        :links="[
          { label: ERROR_COPY.home, to: '/', color: 'primary', size: 'xl' }
        ]"
      />
    </div>
  </UApp>
</template>

<script setup lang="ts">
import type { NuxtError } from '#app'
import { ERROR_COPY, errorCopy } from '~/utils/error-copy'
import { pageTitle } from '~/utils/reason-copy'

const props = defineProps<{
  error: NuxtError
}>()

// Only the wording for the kind of error reaches the page. The code and the
// server's message are not shown; while developing, the code goes to the console.
const copy = computed(() => errorCopy(props.error?.statusCode))
if (import.meta.dev) console.error('Error page shown:', props.error?.statusCode)

useHead({ title: pageTitle(copy.value.title) })
</script>
