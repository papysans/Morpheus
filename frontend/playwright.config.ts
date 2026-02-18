import { defineConfig } from '@playwright/test'

const appBaseURL = process.env.E2E_APP_BASE_URL || 'http://localhost:3002'

export default defineConfig({
  testDir: './e2e',
  reporter: 'line',
  outputDir: '../output/playwright/test-results',
  use: {
    baseURL: appBaseURL,
    headless: true,
    viewport: { width: 1728, height: 1117 },
  },
})
