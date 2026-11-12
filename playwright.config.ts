import { defineConfig } from '@playwright/test';

// Runs against the real Worker (wrangler dev) serving the built web app.
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:8787',
    trace: 'off',
    // A pretend microphone and camera, so the call can be tested without hardware.
    permissions: ['microphone', 'camera'],
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  },
  webServer: {
    // The stand-in engine replaces neko, so the tests need no browser server.
    command: 'pnpm build && pnpm --filter @wt/worker dev --var BROWSER_ENGINE:fake --var OWNER_PASSPHRASE:e2e-passphrase --var ROOM_CREATE_LIMIT:1000',
    url: 'http://localhost:8787',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
