/**
 * T11 — Regression & edge cases
 * T12 — Stability, performance, console health
 */

import path from 'path';
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

const SHOTS_DIR = path.resolve(__dirname, 'screenshots');

test.describe('T11: Regression & edge cases', () => {
  test('T11.1 — clicking Fill twice does not double-fill or error', async ({ context, popupPage, fixtureServer }) => {
    test.setTimeout(240_000);
    await clearProfile(popupPage);
    await seedProfile(popupPage);

    const formPage = await context.newPage();
    const errors: string[] = [];
    formPage.on('pageerror', err => errors.push(`PAGE: ${err.message}`));
    formPage.on('console', msg => {
      if (msg.type() === 'error') errors.push(`CONSOLE: ${msg.text()}`);
    });

    await formPage.goto(`${fixtureServer.baseUrl}/greenhouse-like.html`);
    await formPage.evaluate(() => { (window as any).__SFA_DEBUG = true; });
    await formPage.waitForTimeout(4_000);

    // First fill
    await formPage.evaluate(() => {
      const host = document.getElementById('smartfillai-overlay-host');
      host?.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="fill"]')?.click();
    });
    await formPage.waitForTimeout(8_000);

    const firstSnap = await formPage.evaluate(() => ({
      first_name: (document.getElementById('first_name') as HTMLInputElement).value,
      email: (document.getElementById('email') as HTMLInputElement).value,
      city: (document.getElementById('city') as HTMLInputElement).value,
    }));
    console.log('First-fill snapshot:', firstSnap);

    // Second fill (banner may have hidden; trigger via runtime message)
    await formPage.evaluate(() => {
      const host = document.getElementById('smartfillai-overlay-host');
      const btn = host?.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="fill"]');
      if (btn) {
        btn.click();
      } else {
        // Banner already auto-dismissed — directly dispatch internal event
        window.dispatchEvent(new CustomEvent('sfa:fill-request'));
      }
    });
    await formPage.waitForTimeout(8_000);

    const secondSnap = await formPage.evaluate(() => ({
      first_name: (document.getElementById('first_name') as HTMLInputElement).value,
      email: (document.getElementById('email') as HTMLInputElement).value,
      city: (document.getElementById('city') as HTMLInputElement).value,
    }));
    console.log('Second-fill snapshot:', secondSnap);

    // Values should be identical (no concat / double-fill)
    expect(secondSnap.first_name).toBe(firstSnap.first_name);
    expect(secondSnap.email).toBe(firstSnap.email);
    expect(secondSnap.city).toBe(firstSnap.city);

    // No critical errors
    const critical = errors.filter(e =>
      !e.includes('favicon') && !e.includes('Failed to load resource') && !e.toLowerCase().includes('extension context')
    );
    console.log('Critical errors during double-fill:', critical.length);
    critical.forEach(e => console.log('  ', e));
    expect(critical.length).toBe(0);

    await formPage.screenshot({ path: path.join(SHOTS_DIR, 't11-1-double-fill.png'), fullPage: true });
    await formPage.close();
  });

  test('T11.2 — hidden / disabled fields are NOT filled', async ({ context, popupPage, fixtureServer }) => {
    test.setTimeout(180_000);
    await clearProfile(popupPage);
    await seedProfile(popupPage);

    const formPage = await context.newPage();
    await formPage.goto(`${fixtureServer.baseUrl}/greenhouse-like.html`);

    // Inject a hidden + disabled field to test
    await formPage.evaluate(() => {
      const form = document.getElementById('application_form');
      if (!form) return;
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.id = 'should_not_fill_hidden';
      hidden.name = 'should_not_fill_hidden';
      form.appendChild(hidden);

      const disabled = document.createElement('input');
      disabled.type = 'text';
      disabled.id = 'should_not_fill_disabled';
      disabled.name = 'first_name'; // tempts the matcher
      disabled.disabled = true;
      form.appendChild(disabled);
    });

    await formPage.waitForTimeout(4_000);

    await formPage.evaluate(() => {
      const host = document.getElementById('smartfillai-overlay-host');
      host?.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="fill"]')?.click();
    });
    await formPage.waitForTimeout(8_000);

    const guardCheck = await formPage.evaluate(() => ({
      hidden_value: (document.getElementById('should_not_fill_hidden') as HTMLInputElement).value,
      disabled_value: (document.getElementById('should_not_fill_disabled') as HTMLInputElement).value,
      regular_value: (document.getElementById('first_name') as HTMLInputElement).value,
    }));
    console.log('Hidden/disabled guard check:', guardCheck);

    expect(guardCheck.hidden_value).toBe('');     // not filled
    expect(guardCheck.disabled_value).toBe('');   // not filled
    expect(guardCheck.regular_value).toBe('Prasanna'); // regular IS filled

    await formPage.close();
  });
});

test.describe('T12: Stability & console health', () => {
  test('T12.1 — no JS exceptions thrown during full fill cycle', async ({ context, popupPage, fixtureServer }) => {
    test.setTimeout(180_000);
    await clearProfile(popupPage);
    await seedProfile(popupPage);

    const formPage = await context.newPage();
    const exceptions: string[] = [];
    formPage.on('pageerror', err => exceptions.push(err.message));

    await formPage.goto(`${fixtureServer.baseUrl}/greenhouse-like.html`);
    await formPage.waitForTimeout(4_000);

    await formPage.evaluate(() => {
      const host = document.getElementById('smartfillai-overlay-host');
      host?.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="fill"]')?.click();
    });
    await formPage.waitForTimeout(10_000);

    console.log(`Page exceptions during fill: ${exceptions.length}`);
    exceptions.forEach(e => console.log('  EXCEPTION:', e));
    expect(exceptions.length).toBe(0);

    await formPage.close();
  });

  test('T12.2 — fill completes within 12s (target ≤8s + buffer)', async ({ context, popupPage, fixtureServer }) => {
    test.setTimeout(180_000);
    await clearProfile(popupPage);
    await seedProfile(popupPage);

    const formPage = await context.newPage();
    await formPage.goto(`${fixtureServer.baseUrl}/greenhouse-like.html`);
    await formPage.waitForTimeout(4_000);

    const start = await formPage.evaluate(() => {
      const t0 = performance.now();
      const host = document.getElementById('smartfillai-overlay-host');
      host?.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="fill"]')?.click();
      return t0;
    });

    // Wait until the audit banner shows (signals fill complete) — poll
    let elapsed = 0;
    const startReal = Date.now();
    let done = false;
    while (Date.now() - startReal < 12_000) {
      const audit = await formPage.evaluate(() => {
        const host = document.getElementById('smartfillai-overlay-host');
        const banner = host?.shadowRoot?.getElementById('sfa-banner');
        const text = banner?.textContent ?? '';
        return text.includes('by SmartFillAI') || text.includes('by ATS') || text.includes('empty');
      });
      if (audit) {
        elapsed = Date.now() - startReal;
        done = true;
        break;
      }
      await formPage.waitForTimeout(250);
    }

    console.log(`Fill cycle elapsed: ${elapsed}ms (target ≤8000ms + buffer)`);
    expect(done).toBe(true);
    expect(elapsed).toBeLessThan(12_000);

    await formPage.close();
  });
});
