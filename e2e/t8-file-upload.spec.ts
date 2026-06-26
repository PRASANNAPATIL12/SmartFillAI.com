/**
 * T8 — File upload (resume attachment).
 *
 * Flow:
 *   1. Seed profile + upload a resume PDF into the extension via UPLOAD_DOCUMENT
 *      (bypass the Gemini parse — that's a separate path tested in T2).
 *   2. Navigate to the Greenhouse-like fixture which has <input type=file id=resume>.
 *   3. Click Fill — the extension's file-upload tier should attach the stored
 *      resume PDF to the file input via DataTransfer.
 *   4. Verify resume.files.length > 0 and resume.files[0].name === 'Prasanna_Patil_Resume.pdf'.
 */

import path from 'path';
import fs from 'fs';
import { test as base, expect } from './helpers/fixture';
import { seedProfile, clearProfile } from './helpers/seed-profile';
import { startFixtureServer, type FixtureServer } from './helpers/static-server';

const test = base.extend<{ fixtureServer: FixtureServer }>({
  // eslint-disable-next-line no-empty-pattern
  fixtureServer: async ({}, use) => {
    const server = await startFixtureServer();
    await use(server);
    await server.close();
  },
});

const RESUME_PATH = path.resolve(__dirname, '..', 'Prasanna_Patil_Resume.pdf');
const SHOTS_DIR = path.resolve(__dirname, 'screenshots');

test('T8 — Resume PDF attaches to file input on Fill', async ({ context, popupPage, fixtureServer }) => {
  test.setTimeout(180_000);

  // 1. Seed profile + upload resume document (skip Gemini parse — we just need
  // the file in the documents store so the fill loop has something to attach)
  await clearProfile(popupPage);
  await seedProfile(popupPage);

  // Read the PDF and send to background as base64 to store as a document
  const pdfBytes = fs.readFileSync(RESUME_PATH);
  const pdfBase64 = pdfBytes.toString('base64');

  const uploadResult = await popupPage.evaluate(async (b64) => {
    return new Promise<any>((resolve, reject) => {
      // @ts-ignore
      chrome.runtime.sendMessage({
        type: 'UPLOAD_DOCUMENT',
        payload: {
          docType: 'resume',
          label: 'Prasanna_Patil_Resume',
          fileName: 'Prasanna_Patil_Resume.pdf',
          mimeType: 'application/pdf',
          fileDataBase64: b64,
        },
      }, (response: any) => {
        // @ts-ignore
        if (chrome.runtime.lastError) {
          // @ts-ignore
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response?.data);
      });
    });
  }, pdfBase64);

  console.log('Document uploaded (id):', uploadResult?.id);
  expect(uploadResult).toBeTruthy();

  // 2. Navigate to fixture form
  const formPage = await context.newPage();
  const logs: string[] = [];
  formPage.on('console', msg => {
    const txt = msg.text();
    if (txt.includes('SmartFillAI') || txt.includes('file') || txt.includes('FILE_UPLOAD')) {
      logs.push(`[${msg.type()}] ${txt}`);
    }
  });

  await formPage.goto(`${fixtureServer.baseUrl}/greenhouse-like.html`);
  await formPage.evaluate(() => { (window as any).__SFA_DEBUG = true; });
  await formPage.waitForTimeout(4_000);

  // 3. Click Fill
  await formPage.evaluate(() => {
    const host = document.getElementById('smartfillai-overlay-host');
    const btn = host?.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="fill"]');
    btn?.click();
  });

  await formPage.waitForTimeout(10_000);
  await formPage.screenshot({ path: path.join(SHOTS_DIR, 't8-after-fill.png'), fullPage: true });

  // 4. Verify the file input got the resume attached
  const fileState = await formPage.evaluate(() => {
    const input = document.getElementById('resume') as HTMLInputElement | null;
    if (!input) return { found: false };
    return {
      found: true,
      filesLength: input.files?.length ?? 0,
      firstFileName: input.files?.[0]?.name ?? null,
      firstFileSize: input.files?.[0]?.size ?? null,
      firstFileType: input.files?.[0]?.type ?? null,
    };
  });
  console.log('File input state after fill:', fileState);

  console.log('\n=== T8 console logs ===');
  logs.slice(0, 50).forEach(l => console.log(l));

  expect(fileState.found).toBe(true);
  expect(fileState.filesLength).toBe(1);
  expect(fileState.firstFileName).toBe('Prasanna_Patil_Resume.pdf');
  expect(fileState.firstFileType).toBe('application/pdf');
  expect(fileState.firstFileSize).toBeGreaterThan(10_000);

  await formPage.close();
});
