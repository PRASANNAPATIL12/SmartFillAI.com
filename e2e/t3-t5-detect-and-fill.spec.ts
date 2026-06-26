/**
 * Combined T2-final + T3 (detection) + T4 (banner) + T5 (native input fill).
 *
 * Strategy: skip Gemini-dependent resume parse (quota exhausted), seed the
 * profile directly with the data Gemini would have produced, then exercise
 * detection + banner + fill across the local fixture form.
 */

import path from 'path';
import { test as base, expect } from './helpers/fixture';
import { seedProfile, clearProfile, PRASANNA_PROFILE } from './helpers/seed-profile';
import { startFixtureServer, type FixtureServer } from './helpers/static-server';

const SHOTS_DIR = path.resolve(__dirname, 'screenshots');

// Extend the base fixture with an HTTP server so the extension content script
// (which doesn't inject into file:// URLs) can load fixtures over http://.
const test = base.extend<{ fixtureServer: FixtureServer }>({
  // eslint-disable-next-line no-empty-pattern
  fixtureServer: async ({}, use) => {
    const server = await startFixtureServer();
    console.log(`Fixture server: ${server.baseUrl}`);
    await use(server);
    await server.close();
  },
});

test.describe('T2-final: seed profile (Gemini bypass)', () => {
  test('seeds 28 profile entries derived from Prasanna_Patil_Resume.pdf', async ({ popupPage }) => {
    await clearProfile(popupPage);
    const seeded = await seedProfile(popupPage);
    console.log(`Seeded ${seeded} / ${PRASANNA_PROFILE.length} profile entries`);
    expect(seeded).toBeGreaterThanOrEqual(20);

    // Navigate to Profile screen to visually confirm
    const profileLink = popupPage.locator('text=Profile').first();
    if (await profileLink.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await profileLink.click();
      await popupPage.waitForTimeout(1000);
    }
    await popupPage.screenshot({ path: path.join(SHOTS_DIR, 't2-final-profile-seeded.png'), fullPage: true });

    const body = (await popupPage.textContent('body')) ?? '';
    expect(body).toContain('Prasanna');
  });
});

test.describe('T3: Form field detection', () => {
  test('detector finds expected fields on Greenhouse-like fixture', async ({ context, popupPage, fixtureServer }) => {
    // Ensure profile is seeded so banner has data to match against
    await clearProfile(popupPage);
    await seedProfile(popupPage);

    // Open the test form in a new tab
    const formPage = await context.newPage();
    const fixtureLogs: string[] = [];
    formPage.on('console', msg => {
      const txt = msg.text();
      if (txt.includes('SmartFillAI') || txt.includes('sfa') || txt.includes('SFA')) {
        fixtureLogs.push(`[${msg.type()}] ${txt}`);
      }
    });

    await formPage.goto(`${fixtureServer.baseUrl}/greenhouse-like.html`);
    await formPage.waitForLoadState('domcontentloaded');

    // Enable debug logging in the content script
    await formPage.evaluate(() => { (window as any).__SFA_DEBUG = true; });

    await formPage.waitForTimeout(5_000); // Let scan complete

    // Inspect: how many DOM form fields exist?
    const domCounts = await formPage.evaluate(() => {
      const visible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const inputs = Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=submit])')).filter(visible);
      const textareas = Array.from(document.querySelectorAll('textarea')).filter(visible);
      const selects = Array.from(document.querySelectorAll('select')).filter(visible);
      return { inputs: inputs.length, textareas: textareas.length, selects: selects.length, total: inputs.length + textareas.length + selects.length };
    });
    console.log('DOM field counts:', domCounts);

    // Inspect: did SmartFillAI inject its overlay shadow host?
    const hasOverlay = await formPage.evaluate(() => !!document.getElementById('smartfillai-overlay-host'));
    console.log(`Overlay shadow host present: ${hasOverlay}`);

    // Inspect: is the banner visible inside shadow DOM?
    const bannerInfo = await formPage.evaluate(() => {
      const host = document.getElementById('smartfillai-overlay-host');
      if (!host?.shadowRoot) return { found: false };
      const banner = host.shadowRoot.getElementById('sfa-banner');
      if (!banner) return { found: false };
      return {
        found: true,
        text: banner.textContent?.trim() ?? '',
        className: banner.className,
      };
    });
    console.log('Banner info:', bannerInfo);

    await formPage.screenshot({ path: path.join(SHOTS_DIR, 't3-form-detected.png'), fullPage: true });

    console.log('\n=== SmartFillAI console output during T3 ===');
    fixtureLogs.forEach(l => console.log(l));
    console.log('=== End console ===\n');

    // Asserts
    expect(domCounts.total).toBeGreaterThanOrEqual(10);
    expect(hasOverlay).toBe(true);
    // Banner should appear with profile data seeded
    expect(bannerInfo.found).toBe(true);

    await formPage.close();
  });
});

test.describe('T4 + T5: Banner click → fill native inputs', () => {
  test('clicking Fill button populates name/email/phone/etc.', async ({ context, popupPage, fixtureServer }) => {
    await clearProfile(popupPage);
    await seedProfile(popupPage);

    const formPage = await context.newPage();
    const logs: string[] = [];
    formPage.on('console', msg => {
      const txt = msg.text();
      if (txt.includes('SmartFillAI') || txt.includes('sfa') || txt.includes('SFA')) {
        logs.push(`[${msg.type()}] ${txt}`);
      }
    });

    await formPage.goto(`${fixtureServer.baseUrl}/greenhouse-like.html`);
    await formPage.waitForLoadState('domcontentloaded');
    await formPage.evaluate(() => { (window as any).__SFA_DEBUG = true; });
    await formPage.waitForTimeout(4_000); // wait for banner

    // Find and click the Fill button inside Shadow DOM
    await formPage.evaluate(() => {
      const host = document.getElementById('smartfillai-overlay-host');
      const fillBtn = host?.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="fill"]');
      if (fillBtn) {
        fillBtn.click();
      } else {
        console.warn('SmartFillAI fill button not found in shadow DOM');
      }
    });

    // Wait for the fill pass + ATS settle + audit banner (max ~10s)
    await formPage.waitForTimeout(10_000);

    await formPage.screenshot({ path: path.join(SHOTS_DIR, 't5-after-fill.png'), fullPage: true });

    // Inspect: which fields got filled?
    const filled = await formPage.evaluate(() => {
      const fields = ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'state', 'country',
                      'current_company', 'current_title', 'years_experience'];
      const result: Record<string, string> = {};
      for (const id of fields) {
        const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
        if (el) result[id] = el.value ?? '';
      }
      return result;
    });
    console.log('Filled values:', filled);

    // Check audit banner
    const auditInfo = await formPage.evaluate(() => {
      const host = document.getElementById('smartfillai-overlay-host');
      const banner = host?.shadowRoot?.getElementById('sfa-banner');
      return banner ? { text: banner.textContent?.trim() ?? '' } : { text: '' };
    });
    console.log('Audit banner:', auditInfo.text);

    console.log('\n=== SmartFillAI console output during T5 ===');
    logs.slice(0, 50).forEach(l => console.log(l));
    console.log('=== End console (showing first 50) ===\n');

    // Asserts on the critical fields
    expect(filled.first_name).toBe('Prasanna');
    expect(filled.last_name).toBe('Patil');
    expect(filled.email).toBe('pspatil77888@gmail.com');
    expect(filled.current_company).toContain('Verifone');

    await formPage.close();
  });
});
