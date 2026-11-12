<script setup lang="ts">
// "Who it's for": the kinds of community a LocalNodes site fits, each with how its
// site and groups are set up and what it would do in its first week. A public page,
// not a sign-up page: it is prerendered (nuxt.config.ts) and the pre-launch gate
// does not list it. Every word comes from app/data/who-its-for.json, which the
// claims check reads along with the built page.
import data from '~/data/who-its-for.json'

definePageMeta({ colorMode: 'light' })

const title = 'Who it\'s for - LocalNodes'
const description = 'The kinds of group LocalNodes is for: housing co-ops, markets, neighborhood associations, makerspaces, clubs and more. Each gets a site with groups inside it.'

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogImage: '/og-image.png',
  twitterCard: 'summary_large_image'
})
</script>

<template>
  <UContainer class="max-w-3xl py-16">
    <h1 class="text-[28px] leading-tight font-semibold text-highlighted mb-4">
      Who it's for
    </h1>
    <p class="text-base leading-normal text-default max-w-[72ch]">
      {{ data.intro }}
    </p>

    <WhoItsForKind v-for="kind in data.kinds" :key="kind.id" :kind="kind" />

    <p class="text-base leading-normal text-default max-w-[72ch] mt-12">
      {{ data.closing }}
    </p>

    <div class="mt-8 flex flex-wrap items-center gap-x-4 gap-y-3">
      <p data-prelaunch class="text-sm font-semibold text-muted">
        Launching soon.
      </p>
      <UButton to="/#early-access" color="primary" variant="solid" class="min-h-11">
        Get early access
      </UButton>
    </div>
  </UContainer>
</template>
