<template>
  <footer class="border-t border-zinc-800 bg-zinc-950">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
        <!-- Brand -->
        <div>
          <NuxtLink to="/" class="font-bold text-xl text-teal-400">
            LocalNodes
          </NuxtLink>
          <p class="mt-2 text-sm text-zinc-400">
            AI-powered knowledge gardens for communities.
          </p>
        </div>

        <!-- Navigation -->
        <div>
          <h3 class="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Navigate</h3>
          <ul class="mt-3 space-y-2">
            <li>
              <NuxtLink to="#how-it-works" class="text-sm text-zinc-400 hover:text-teal-400 transition-colors">
                How it Works
              </NuxtLink>
            </li>
            <li>
              <NuxtLink to="#features" class="text-sm text-zinc-400 hover:text-teal-400 transition-colors">
                Features
              </NuxtLink>
            </li>
            <li>
              <NuxtLink to="#pricing" class="text-sm text-zinc-400 hover:text-teal-400 transition-colors">
                Pricing
              </NuxtLink>
            </li>
            <li>
              <NuxtLink to="#communities" class="text-sm text-zinc-400 hover:text-teal-400 transition-colors">
                Communities
              </NuxtLink>
            </li>
          </ul>
        </div>

        <!-- Explore -->
        <div>
          <h3 class="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Explore</h3>
          <ul class="mt-3 space-y-2">
            <li>
              <a
                href="https://cascadia.localnodes.xyz"
                target="_blank"
                rel="noopener noreferrer"
                class="text-sm text-zinc-400 hover:text-teal-400 transition-colors"
              >
                Live Demo (Cascadia)
              </a>
            </li>
            <li>
              <NuxtLink to="/onboarding" class="text-sm text-zinc-400 hover:text-teal-400 transition-colors">
                Get Started
              </NuxtLink>
            </li>
          </ul>
        </div>
      </div>

      <!-- Bottom bar -->
      <div class="mt-8 pt-8 border-t border-zinc-800 flex flex-col sm:flex-row justify-between items-center gap-4">
        <p class="text-sm text-zinc-500">
          &copy; {{ new Date().getFullYear() }} LocalNodes. All rights reserved.
        </p>
        <p class="text-sm text-zinc-600 italic">
          Built for communities, by communities.
        </p>
      </div>
    </div>
  </footer>
</template>
