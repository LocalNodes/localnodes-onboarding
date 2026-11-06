<template>
  <div>
    <HeroSection id="hero" />
    <FeaturesSection id="what-you-get-today" />
    <SocialProof id="see-it-in-action" />
    <HowItWorks id="how-it-works" />
    <LandingCTA id="get-started" />
  </div>
</template>

<script setup lang="ts">
// Section order: fresh3 LANDING.md section 2 (approved, Tom 2026-11-06).
// The page is light with dark bands (card 7); the bands scope `dark` themselves.
definePageMeta({ colorMode: 'light' })

const title = 'LocalNodes: your community\'s library, treasury and decisions, run by its members'
const description = 'Start with the library: a home for your group\'s documents that members can search and ask, with every answer pointing to the page it came from. The treasury and shared decisions come next.'

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogImage: '/og-image.png',
  twitterCard: 'summary_large_image'
})
</script>
