// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@nuxt/content'],

  css: ['~/assets/css/main.css'],

  colorMode: {
    preference: 'dark'
  },

  runtimeConfig: {
    // Private keys (server-only, set via NUXT_* env vars)
    coolifyApiUrl: 'https://coolify.localnodes.xyz/api/v1',
    coolifyApiToken: '',  // Set via NUXT_COOLIFY_API_TOKEN env var

    // Stripe (server-only, set via NUXT_STRIPE_* env vars)
    stripeSecretKey: '',        // NUXT_STRIPE_SECRET_KEY
    stripeWebhookSecret: '',    // NUXT_STRIPE_WEBHOOK_SECRET
    stripePriceId: '',          // NUXT_STRIPE_PRICE_ID

    // Upstash Redis (server-only, set via NUXT_UPSTASH_* env vars)
    upstashRedisUrl: '',        // NUXT_UPSTASH_REDIS_URL
    upstashRedisToken: '',      // NUXT_UPSTASH_REDIS_TOKEN

    // GitHub Actions (server-only, set via NUXT_GITHUB_* env vars)
    githubToken: '',            // NUXT_GITHUB_TOKEN (fine-grained PAT)
    githubRepo: 'LocalNodes/os-knowledge-garden',  // NUXT_GITHUB_REPO

    // Provisioning callback (server-only)
    provisionCallbackSecret: '', // NUXT_PROVISION_CALLBACK_SECRET
  },

  routeRules: {
    '/': { prerender: true },
    '/onboarding': { ssr: true },
    '/success': { ssr: true },
    '/cancel': { prerender: true }
  },

  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      link: [
        { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }
      ]
    }
  },

  compatibilityDate: '2025-07-15',
  devtools: { enabled: true }
})
