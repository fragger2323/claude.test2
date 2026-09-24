import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end: builds the SPA, then starts tests/support/e2e-server.ts (fixture websites,
 * mock provider APIs, fresh SQLite DB, API + in-process worker). No network or API keys needed.
 */
const port = Number(process.env.E2E_PORT ?? 4412);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'tests/.tmp/e2e-results',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npm run build:web --silent && npx tsx tests/support/e2e-server.ts`,
    url: `http://127.0.0.1:${port}/api/health`,
    env: { E2E_PORT: String(port), LOG_LEVEL: 'warn' },
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: 'ignore',
  },
});
