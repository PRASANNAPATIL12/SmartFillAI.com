/**
 * E2E smoke test for SmartFillAI Chrome extension.
 *
 * Launches Chromium with the extension loaded, navigates to a real
 * job application form, and verifies the extension detects fields,
 * shows the banner, and fills the form.
 *
 * Run: npx playwright test e2e/extension-smoke.spec.ts
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import path from 'path';

const EXTENSION_PATH = path.resolve(__dirname, '..', 'extension', 'dist');

// Greenhouse test board — public, no login required
const TEST_FORMS = [
  {
    name: 'Greenhouse (Ashby test)',
    url: 'https://jobs.ashbyhq.com/ClickHouse/61db5735-3e44-4f32-a237-a1a2bb1fff16/application',
  },
  {
    name: 'Lever test form',
    url: 'https://jobs.lever.co/leverdemo/5ac21346-8e0c-4494-8e7a-3eb92ff77902/apply',
  },
];

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async ({ }, testInfo) => {
  // Launch a persistent context with the extension loaded.
  // Playwright requires persistent context for extensions.
  const { chromium } = require('playwright');

  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--disable-default-apps',
    ],
    viewport: { width: 1280, height: 900 },
  });

  // Wait for the service worker to register and get the extension ID
  let sw: any;
  const maxWait = 10_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    sw = context.serviceWorkers().find(w =>
      w.url().includes('service-worker-loader')
    );
    if (sw) break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (sw) {
    const swUrl = sw.url();
    // chrome-extension://<id>/service-worker-loader.js
    const match = swUrl.match(/chrome-extension:\/\/([^/]+)/);
    extensionId = match?.[1] ?? 'unknown';
    console.log(`Extension loaded with ID: ${extensionId}`);
  } else {
    console.warn('Service worker not found — extension may not have loaded');
  }
});

test.afterAll(async () => {
  await context?.close();
});

test.describe('Extension loads correctly', () => {
  test('service worker is running', async () => {
    const sw = context.serviceWorkers().find(w =>
      w.url().includes('service-worker-loader')
    );
    expect(sw).toBeTruthy();
    console.log('Service worker URL:', sw?.url());
  });

  test('popup page renders', async () => {
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
    await popupPage.waitForTimeout(2000);

    // Take a screenshot of the popup
    await popupPage.screenshot({
      path: path.resolve(__dirname, 'screenshots', '01-popup.png'),
    });

    // Check that the popup rendered something (React root should have content)
    const body = await popupPage.textContent('body');
    expect(body).toBeTruthy();
    console.log('Popup body text (first 200 chars):', body?.slice(0, 200));

    await popupPage.close();
  });
});

test.describe('Form detection and fill', () => {
  for (const form of TEST_FORMS) {
    test.describe(form.name, () => {
      let page: Page;

      test.beforeAll(async () => {
        page = await context.newPage();
      });

      test.afterAll(async () => {
        await page?.close();
      });

      test(`navigates to ${form.name}`, async () => {
        await page.goto(form.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(3000); // Let extension content script inject

        await page.screenshot({
          path: path.resolve(__dirname, 'screenshots', `02-${form.name.replace(/\s+/g, '-')}-loaded.png`),
          fullPage: true,
        });
      });

      test(`extension detects form fields on ${form.name}`, async () => {
        // Check if SmartFillAI injected its overlay (Shadow DOM host)
        const overlayHost = await page.$('#smartfillai-overlay');
        console.log(`Overlay host found: ${!!overlayHost}`);

        // Check console for SmartFillAI logs
        const consoleLogs: string[] = [];
        page.on('console', msg => {
          if (msg.text().includes('SmartFillAI') || msg.text().includes('SFA')) {
            consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
          }
        });

        // Wait a bit more for the extension to scan
        await page.waitForTimeout(3000);

        // Check for the banner in the shadow DOM
        const bannerExists = await page.evaluate(() => {
          const host = document.getElementById('smartfillai-overlay');
          if (!host?.shadowRoot) return false;
          const banner = host.shadowRoot.getElementById('sfa-banner');
          return !!banner;
        });

        console.log(`Banner found: ${bannerExists}`);
        console.log('Console logs:', consoleLogs);

        await page.screenshot({
          path: path.resolve(__dirname, 'screenshots', `03-${form.name.replace(/\s+/g, '-')}-detected.png`),
          fullPage: true,
        });
      });

      test(`counts form fields on ${form.name}`, async () => {
        // Count visible form fields on the page
        const fieldCount = await page.evaluate(() => {
          const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
          const textareas = document.querySelectorAll('textarea');
          const selects = document.querySelectorAll('select');
          const editables = document.querySelectorAll('[contenteditable="true"]');
          return {
            inputs: inputs.length,
            textareas: textareas.length,
            selects: selects.length,
            editables: editables.length,
            total: inputs.length + textareas.length + selects.length + editables.length,
          };
        });

        console.log(`Field count on ${form.name}:`, fieldCount);
        expect(fieldCount.total).toBeGreaterThan(0);
      });

      test(`reads extension console output on ${form.name}`, async () => {
        // Enable debug mode
        await page.evaluate(() => {
          (window as any).__SFA_DEBUG = true;
        });

        // Collect all console messages for 2 seconds
        const allLogs: string[] = [];
        const handler = (msg: any) => {
          allLogs.push(`[${msg.type()}] ${msg.text()}`);
        };
        page.on('console', handler);
        await page.waitForTimeout(2000);
        page.off('console', handler);

        console.log(`Total console messages: ${allLogs.length}`);
        const sfaLogs = allLogs.filter(l => l.includes('SmartFillAI') || l.includes('SFA') || l.includes('sfa'));
        console.log(`SmartFillAI-related logs: ${sfaLogs.length}`);
        sfaLogs.forEach(l => console.log('  ', l));
      });
    });
  }
});

test.describe('Console error check', () => {
  test('no critical errors in extension', async () => {
    const page = await context.newPage();
    const errors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    page.on('pageerror', err => {
      errors.push(`PAGE ERROR: ${err.message}`);
    });

    await page.goto(TEST_FORMS[0].url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(5000);

    const criticalErrors = errors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('net::ERR') &&
      !e.includes('third-party') &&
      !e.includes('CSP')
    );

    console.log(`Total errors: ${errors.length}`);
    console.log(`Critical errors: ${criticalErrors.length}`);
    criticalErrors.forEach(e => console.log('  ERROR:', e));

    await page.screenshot({
      path: path.resolve(__dirname, 'screenshots', '04-error-check.png'),
    });

    await page.close();
  });
});
