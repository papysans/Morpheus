/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: '/Volumes/Work/Projects/Morpheus/output/playwright/specs',
  testMatch: /pw_.*\.spec\.js/,
  reporter: 'line',
  use: {
    headless: true,
    viewport: { width: 1728, height: 1117 },
  },
  outputDir: '/Volumes/Work/Projects/Morpheus/output/playwright/test-results',
};
