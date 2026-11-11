import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true
  },
  resolve: {
    alias: {
      '~': resolve(__dirname, 'app'),
      '#app': resolve(__dirname, '.nuxt/imports'),
      '#shared': resolve(__dirname, 'shared')
    }
  }
})
