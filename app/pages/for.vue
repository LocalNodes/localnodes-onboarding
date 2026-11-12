<script setup lang="ts">
// "Who it's for": the kinds of community a LocalNodes site fits, each with how its
// site and groups are set up and what it would do in its first week. A public page,
// not a sign-up page: it is prerendered (nuxt.config.ts) and the pre-launch gate
// does not list it. Every word comes from app/data/who-its-for.json, which the
// claims check reads along with the built page.
// It reads as a page of the landing: the landing's stylesheet and its `ln-home`
// scope (teal, the landing's neutrals, its header and footer bands), its 1200px
// container, and the landing's section-heading size for the h1.
import '~/assets/css/home-v5.css'
import data from '~/data/who-its-for.json'

definePageMeta({ colorMode: 'light' })
useHead({ htmlAttrs: { class: 'ln-home' } })

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
  <div class="home-band-light text-default">
    <div class="home-wrap py-16">
      <h1 class="home-h2 text-highlighted mb-4">
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
    </div>
  </div>
</template>
