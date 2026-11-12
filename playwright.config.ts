import { defineConfig } from '@playwright/test';

// Runs against the real Worker (wrangler dev) serving the built web app.
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  use: { baseURL: 'http://localhost:8787', trace: 'off' },
  webServer: {
    command: 'pnpm build && pnpm --filter @wt/worker dev',
    url: 'http://localhost:8787',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
