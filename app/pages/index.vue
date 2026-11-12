<template>
  <div
    class="home-page"
    :class="{
      'home-live': demos.state.mounted,
      'home-paused': demos.state.paused,
      'home-reduced': demos.state.reducedMotion
    }"
  >
    <HomeHero />
    <HomeScatter />
    <HomeTogether />
    <HomeDecide />
    <HomeFund />
    <HomeYours />
    <LandingCTA />
    <HomeKinds />
  </div>
</template>

<script setup lang="ts">
// The home page: a dark first screen,
// the six places, the group's home page, three acts (decide, fund, own), a dark close and,
// last above the footer, the kinds strip that links to /for. It is a light page whose
// dark bands scope `dark` themselves, so colorMode stays light.
//
// The stylesheet holds this page's colour contexts. It is scoped under the `ln-home` class,
// which this page puts on <html> while it is showing, so the header, the footer and anything
// Nuxt UI puts on <body> are inside it and the sign-up pages are not.
import { onBeforeUnmount, onMounted, provide } from 'vue'
import '~/assets/css/home-v5.css'
import { HOME_DEMOS_KEY, useHomeDemos } from '~/composables/useHomeDemos'

definePageMeta({ colorMode: 'light' })

// Headline chosen by Tom, 2026-11-06; the description matches the hero
// subline (pre-launch, PR #9; the subline is the ruling of 2026-11-09).
const title = 'LocalNodes: where your community shares, decides and funds together'
const description = 'Keep in touch, ask an assistant that answers from what your group has written down, decide fairly, and look after a fund together. Your community owns it, not a platform. Launching soon.'

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogImage: '/og-image.png',
  twitterCard: 'summary_large_image'
})

useHead({ htmlAttrs: { class: 'ln-home' } })

// One controller owns everything that moves; the sections read from it.
const demos = useHomeDemos()
provide(HOME_DEMOS_KEY, demos)
onMounted(() => demos.mount())
onBeforeUnmount(() => demos.unmount())
</script>
