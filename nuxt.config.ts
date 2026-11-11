// https://nuxt.com/docs/api/configuration/nuxt-config

// Pre-launch gate flag (server/utils/launch.ts). One env var, NUXT_LAUNCH_OPEN,
// sets both the server value and the public value the client route middleware
// reads. The landing page is prerendered, so its public value is fixed at
// build time: change the flag, then redeploy.
const launchOpen = ['true', '1'].includes(process.env.NUXT_LAUNCH_OPEN ?? '')
export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@vueuse/motion/nuxt'],

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
    stripeCurrency: '',         // NUXT_STRIPE_CURRENCY: three-letter code of the Stripe price, lowercase (setup-mode checkout needs it)

    // Upstash Redis (server-only, set via NUXT_UPSTASH_* env vars)
    upstashRedisUrl: '',        // NUXT_UPSTASH_REDIS_URL
    upstashRedisToken: '',      // NUXT_UPSTASH_REDIS_TOKEN

    // GitHub Actions (server-only, set via NUXT_GITHUB_* env vars)
    githubToken: '',            // NUXT_GITHUB_TOKEN (fine-grained PAT)
    githubRepo: 'LocalNodes/os-knowledge-garden',  // NUXT_GITHUB_REPO

    // Provisioning callback (server-only)
    provisionCallbackSecret: '', // NUXT_PROVISION_CALLBACK_SECRET

    // Pre-launch gate (server-only): the paid sign-up flow opens only when
    // NUXT_LAUNCH_OPEN=true (server/utils/launch.ts). Default closed.
    launchOpen,                 // NUXT_LAUNCH_OPEN

    // Early-access list (server-only): Resend contacts, added to one segment
    // (Resend's "Audiences" are now "Segments").
    resendApiKey: '',           // NUXT_RESEND_API_KEY
    resendSegmentId: '',        // NUXT_RESEND_SEGMENT_ID

    // Self-serve sign-up (Phase 23). Every key here is server-only: none of
    // them may move into `public` below, and none reaches the browser.
    inviteHashSecret: '',       // NUXT_INVITE_HASH_SECRET: HMAC key for the invite list (server/utils/invites.ts)
    mailFrom: '',               // NUXT_MAIL_FROM: verified Resend sender for the sign-in mail
    provisionImageTag: '',      // NUXT_PROVISION_IMAGE_TAG: product image tag the provisioning workflow pins (empty = the workflow's default)
    // Server room (capacity decision): the numbers behind "is there room for one more site".
    capacityReportSecret: '',   // NUXT_CAPACITY_REPORT_SECRET: bearer for the server's metric push
    capacityMaxSites: 0,        // NUXT_CAPACITY_MAX_SITES: hard cap on running sites; 0 sells none until Tom sets a number
    capacityPerSiteMb: 2048,    // NUXT_CAPACITY_PER_SITE_MB: memory one site is counted at
    capacityHeadroomMb: 1024,   // NUXT_CAPACITY_HEADROOM_MB: memory kept free on top of the new site
    capacityMinDockerFreeGb: 10, // NUXT_CAPACITY_MIN_DOCKER_FREE_GB: least free disk for Docker
    coolifyServerUuid: '',      // NUXT_COOLIFY_SERVER_UUID: the server whose running apps are counted
    // The sweep's trigger (23-38): QStash's signed POST to /api/cron/sweep. Empty values refuse every call.
    qstashCurrentSigningKey: '', // NUXT_QSTASH_CURRENT_SIGNING_KEY: QStash current signing key (Upstash console, QStash, Signing keys)
    qstashNextSigningKey: '',   // NUXT_QSTASH_NEXT_SIGNING_KEY: QStash next signing key, accepted too so a key roll keeps working
    cronSweepUrl: '',           // NUXT_CRON_SWEEP_URL: the exact URL the QStash schedule posts to, https://<host>/api/cron/sweep, byte for byte
    // The B-2 gate (23-32): until pausing and removal for failed renewals ship, only 100%-off sign-ups get in.
    paidSignupsEnabled: false,  // NUXT_PAID_SIGNUPS_ENABLED: true opens paid sign-ups; keep false until B-2 ships
    // The bring-your-own OpenRouter choice (23-18 follow-up): hidden until a model passes the citation bar.
    // Server-only; app/plugins/ai-choice.server.ts copies it into page state for the form.
    openRouterChoiceEnabled: false, // NUXT_OPENROUTER_CHOICE_ENABLED: exactly true shows Option 3 and accepts openrouter
    // Topic-type suggestions and bring-your-own AI keys.
    geminiApiKey: '',           // NUXT_GEMINI_API_KEY: the paid key for suggestions
    geminiModel: '',            // NUXT_GEMINI_MODEL: model id for suggestions
    byoKeySecret: '',           // NUXT_BYO_KEY_SECRET: 32-byte key that seals a customer's own AI key

    public: {
      // Same flag, for the client route middleware (app/middleware/launch-gate.global.ts).
      launchOpen
    }
  },

  routeRules: {
    '/': { prerender: true },
    // The page carries the invited address in its payload (23-19), so it is never cached.
    '/onboarding': { ssr: true, headers: { 'Cache-Control': 'no-store' } },
    '/success': { ssr: true },
    // Server-rendered (not prerendered) so the pre-launch gate can see it.
    '/cancel': { ssr: true },
    // Invite pages (23-28, D-24). The link landing is never cached and sends no
    // Referer, so the sign-in token in the link can't leak (research Pitfall 2, T-23-59).
    '/invite': { ssr: true },
    '/invite/verify': {
      ssr: true,
      headers: {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer'
      }
    },
    // The unsubscribe page (23-19). Its token is in the query string, so the
    // page is never cached, sends no Referer and is kept out of search results.
    // The POST to the same path is server/routes/unsubscribe.post.ts.
    '/unsubscribe': {
      ssr: true,
      headers: {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex'
      }
    }
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
