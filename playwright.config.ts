import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e',
  use: {
    baseURL: 'http://127.0.0.1:7439',
    headless: true,
    viewport: { width: 1440, height: 1100 },
  },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:7439/api/health',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
