import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'line',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3010',
    browserName: 'chromium',
    headless: true,
    launchOptions: {
      executablePath: process.env.E2E_CHROME_PATH ?? '/usr/bin/google-chrome',
    },
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  outputDir: '/tmp/duelodev-playwright-results',
});
