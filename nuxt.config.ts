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
