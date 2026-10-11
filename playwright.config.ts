import { defineConfig, devices } from '@playwright/test';

// SITE_DIR / SITE_PORT let `npm run demo` serve a changed copy of the site
// on its own port; a plain `npm test` serves site/ on 4173.
const siteDir = process.env.SITE_DIR ?? 'site';
const port = Number(process.env.SITE_PORT ?? 4173);

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['@testivai/witness-playwright/reporter']],
  use: { baseURL: `http://localhost:${port}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx http-server "${siteDir}" -p ${port} -s -c-1`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI && !process.env.SITE_DIR,
    timeout: 30_000,
  },
});
