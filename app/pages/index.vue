<template>
  <div>
    <HeroSection id="hero" />
    <ProblemSection id="the-problem" />
    <WhoItsFor id="who-its-for" />
    <FeaturesSection id="what-you-get-today" />
    <RoadmapSection id="whats-next" />
    <SocialProof id="see-it-in-action" />
    <HowItWorks id="how-it-works" />
    <OpenSourceSection id="open-source" />
    <LandingCTA id="get-started" />
  </div>
</template>

<script setup lang="ts">
// Section order: fresh3 LANDING.md section 2 (approved, Tom 2026-11-06).
// The page is light with dark bands (card 7); the bands scope `dark` themselves.
definePageMeta({ colorMode: 'light' })

const title = 'LocalNodes: your community\'s library, treasury and decisions, run by its members'
// The description matches the hero subline (Tom, 2026-11-06, PR #9).
const description = 'Your group\'s documents, minutes and decisions in one place, so any member can ask and get an answer from what your community actually wrote.'

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogImage: '/og-image.png',
  twitterCard: 'summary_large_image'
})
</script>
