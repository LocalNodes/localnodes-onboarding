<template>
  <div>
    <HeroSection id="hero" />
    <HowItWorks id="how-it-works" />
    <FeaturesSection id="features" />
    <PricingSection id="pricing" />
    <SocialProof id="communities" />
    <LandingCTA id="get-started" />
  </div>
</template>

<script setup lang="ts">
useSeoMeta({
  title: 'LocalNodes - AI-Powered Knowledge Gardens for Communities',
  description: 'Give your community an AI-powered knowledge garden. Groups, events, topics, and an AI assistant that understands your community. $29/month, everything included.',
  ogTitle: 'LocalNodes - AI-Powered Knowledge Gardens for Communities',
  ogDescription: 'Give your community an AI-powered knowledge garden. Groups, events, topics, and an AI assistant that understands your community.',
  ogImage: '/og-image.png',
  twitterCard: 'summary_large_image'
})
</script>
