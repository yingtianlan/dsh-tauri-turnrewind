import { defineConfig } from 'vitest/config'

// The plugin is not a member of the repo's pnpm workspace; keep its test config
// local so vitest does not climb up and load the desktop shell's vite.config.ts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    testTimeout: 30000,
  },
})
