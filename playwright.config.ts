import { defineConfig } from '@playwright/test';
import path from 'path';

const extensionPath = path.resolve(__dirname, 'extension', 'dist');

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    headless: false,
    viewport: { width: 1280, height: 900 },
    screenshot: 'on',
    launchOptions: {
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--disable-default-apps',
      ],
    },
  },
  projects: [
    {
      name: 'chromium-with-extension',
      use: {
        browserName: 'chromium',
        channel: undefined,
      },
    },
  ],
  outputDir: './e2e/test-results',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './e2e/report' }],
  ],
});
