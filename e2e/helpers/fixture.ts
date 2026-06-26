/**
 * Shared E2E test fixture — launches Chromium with the extension loaded,
 * waits for the service worker, exposes the extension ID, and provides
 * a helper to open the popup past the login screen.
 */

import { test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import path from 'path';

const EXTENSION_PATH = path.resolve(__dirname, '..', '..', 'extension', 'dist');

export type ExtensionFixtures = {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  popupPage: Page;
};

export const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const { chromium } = await import('playwright');
    const ctx = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--disable-default-apps',
      ],
      viewport: { width: 1280, height: 900 },
    });
    await use(ctx);
    await ctx.close();
  },

  serviceWorker: async ({ context }, use) => {
    let sw: Worker | undefined;
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      sw = context.serviceWorkers().find(w => w.url().includes('service-worker-loader'));
      if (sw) break;
      await new Promise(r => setTimeout(r, 200));
    }
    if (!sw) throw new Error('Service worker did not register within 10s');
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    const match = serviceWorker.url().match(/chrome-extension:\/\/([^/]+)/);
    if (!match) throw new Error('Could not extract extension ID from SW URL');
    await use(match[1]);
  },

  popupPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    // Skip login if shown
    const continueBtn = page.locator('text=Continue without an account');
    const onLogin = await continueBtn.isVisible({ timeout: 2_000 }).catch(() => false);
    if (onLogin) {
      await continueBtn.click();
      await page.waitForTimeout(1200);
    }

    await use(page);
    await page.close();
  },
});

export { expect } from '@playwright/test';
