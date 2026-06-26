/**
 * T2 diagnostic — capture service worker console output during resume upload
 * to find the silent failure in the parse pipeline.
 */

import { test, type BrowserContext, type Page } from '@playwright/test';
import path from 'path';

const EXTENSION_PATH = path.resolve(__dirname, '..', 'extension', 'dist');
const RESUME_PATH = path.resolve(__dirname, '..', 'Prasanna_Patil_Resume.pdf');

let context: BrowserContext;
let extensionId: string;
const swLogs: string[] = [];

test.beforeAll(async () => {
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

  let sw: any;
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    sw = context.serviceWorkers().find(w => w.url().includes('service-worker-loader'));
    if (sw) break;
    await new Promise(r => setTimeout(r, 300));
  }
  extensionId = sw.url().match(/chrome-extension:\/\/([^/]+)/)?.[1] ?? '';
  console.log(`Extension ID: ${extensionId}`);

  // Capture ALL console output from the service worker
  sw.on('console', (msg: any) => {
    swLogs.push(`[SW][${msg.type()}] ${msg.text()}`);
  });

  // Also catch unhandled errors
  context.on('weberror', (err: any) => {
    swLogs.push(`[SW][error] ${err.error().message}`);
  });
});

test.afterAll(async () => {
  await context?.close();
});

test('diagnose: upload resume and capture SW logs', async () => {
  test.setTimeout(120_000);

  const popupPage = await context.newPage();

  // Also collect popup-page console
  popupPage.on('console', (msg: any) => {
    swLogs.push(`[POPUP][${msg.type()}] ${msg.text()}`);
  });
  popupPage.on('pageerror', (err: any) => {
    swLogs.push(`[POPUP][pageerror] ${err.message}`);
  });

  await popupPage.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  await popupPage.waitForLoadState('domcontentloaded');
  await popupPage.waitForTimeout(1500);

  // Skip login if still on login screen
  const continueBtn = popupPage.locator('text=Continue without an account');
  const onLogin = await continueBtn.isVisible({ timeout: 2_000 }).catch(() => false);
  if (onLogin) {
    console.log('On login screen — clicking Continue');
    await continueBtn.click();
    await popupPage.waitForTimeout(1500);
  } else {
    console.log('Already past login (session persisted)');
  }

  // Navigate to Documents
  const docsLink = popupPage.locator('text=Documents').first();
  await docsLink.waitFor({ timeout: 5_000 });
  await docsLink.click();
  await popupPage.waitForTimeout(1500);

  console.log('\n========== SW logs BEFORE upload ==========');
  swLogs.forEach(l => console.log(l));
  swLogs.length = 0; // clear

  // Upload
  console.log('\n========== Uploading resume ==========');
  const fileInput = popupPage.locator('input[type="file"]').first();
  await fileInput.setInputFiles(RESUME_PATH);

  // Wait 60 seconds for parsing to either finish or error out
  await popupPage.waitForTimeout(60_000);

  console.log('\n========== SW + POPUP logs DURING/AFTER upload (60s) ==========');
  swLogs.forEach(l => console.log(l));

  // Capture final state
  const finalText = (await popupPage.textContent('body')) ?? '';
  console.log('\n========== Final popup body (first 800 chars) ==========');
  console.log(finalText.slice(0, 800));

  // Check network: examine fetch calls
  console.log('\n========== Total logs captured:', swLogs.length, '==========');
});
