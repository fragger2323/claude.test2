import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/support/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    pool: 'forks',
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'file:../tests/.tmp/vitest.db',
      DATA_DIR: 'tests/.tmp/vitest-data',
      ALLOW_PRIVATE_NETWORK_TARGETS: 'true',
      APP_ENCRYPTION_KEY: 'a'.repeat(64),
      LOG_LEVEL: 'silent',
      AI_PROVIDER: 'none',
      ANTHROPIC_API_KEY: '',
      GOOGLE_PLACES_API_KEY: '',
      FOURSQUARE_API_KEY: '',
      YELP_API_KEY: '',
      BRAVE_SEARCH_API_KEY: '',
      GOOGLE_CSE_API_KEY: '',
      GOOGLE_CSE_CX: '',
      OSM_ENABLED: 'false',
      SCHEDULER_ENABLED: 'false',
      EMAIL_MX_CHECK: 'false',
      HTTPS_PROXY: '',
      HTTP_PROXY: '',
      https_proxy: '',
      http_proxy: '',
    },
  },
});
