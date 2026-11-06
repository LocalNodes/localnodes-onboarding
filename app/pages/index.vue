<template>
  <div>
    <HeroSection id="hero" />
    <ProblemSection id="the-problem" />
    <WhoItsFor id="who-its-for" />
    <FeaturesSection id="what-you-get" />
    <RoadmapSection id="whats-next" />
    <SocialProof id="see-it-in-action" />
    <HowItWorks id="how-it-works" />
    <OpenSourceSection id="open-source" />
    <LandingCTA id="early-access" />
  </div>
</template>

<script setup lang="ts">
// Section order: fresh3 LANDING.md section 2 (approved, Tom 2026-11-06).
// The page is light with dark bands (card 7); the bands scope `dark` themselves.
definePageMeta({ colorMode: 'light' })

// Headline chosen by Tom, 2026-11-06; the description matches the hero
// subline (pre-launch, PR #9).
const title = 'LocalNodes: where your community thinks, decides and funds together'
const description = 'Share posts, events and conversations, keep a library every member can ask, run a group fund, and vote on what happens next. Launching soon.'

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogImage: '/og-image.png',
  twitterCard: 'summary_large_image'
})
</script>
