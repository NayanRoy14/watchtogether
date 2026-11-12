import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Tests use the stand-in engine; the neko engine has its own test with a scripted server.
      miniflare: { bindings: { BROWSER_ENGINE: 'fake', OWNER_PASSPHRASE: 'open sesame' } },
    })],
});
