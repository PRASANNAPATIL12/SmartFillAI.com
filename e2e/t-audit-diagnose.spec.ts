/**
 * Diagnose the audit count discrepancy: banner reports
 * "2 by ATS · 13 empty" but ~11 fields actually got filled.
 *
 * Counts: dittoFilled flags, ditto-status values, matchMap size,
 * and audit numbers side-by-side.
 */

import path from 'path';
import { test as base } from './helpers/fixture';
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

test('audit diagnostic — DOM dataset vs banner counts', async ({ context, popupPage, fixtureServer }) => {
  test.setTimeout(180_000);
  await clearProfile(popupPage);
  await seedProfile(popupPage);

  const formPage = await context.newPage();
  const allLogs: string[] = [];
  formPage.on('console', msg => {
    const txt = msg.text();
    if (txt.includes('SmartFillAI') || txt.includes('sfa') || txt.includes('SFA') || txt.includes('audit')) {
      allLogs.push(`[${msg.type()}] ${txt}`);
    }
  });

  await formPage.goto(`${fixtureServer.baseUrl}/greenhouse-like.html`);
  await formPage.evaluate(() => { (window as any).__SFA_DEBUG = true; });
  await formPage.waitForTimeout(4_000);

  await formPage.evaluate(() => {
    const host = document.getElementById('smartfillai-overlay-host');
    const btn = host?.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="fill"]');
    btn?.click();
  });

  await formPage.waitForTimeout(10_000);

  // Count all dataset flags
  const stats = await formPage.evaluate(() => {
    const all = Array.from(document.querySelectorAll('input, select, textarea, [contenteditable]')) as HTMLElement[];
    const dittoFilled = all.filter(e => e.dataset.dittoFilled === 'true');
    const atsFilled = all.filter(e => e.dataset.atsFilledNative === 'true');
    const fillFailed = all.filter(e => e.dataset.dittoStatus === 'FILL_FAILED');
    const withValue = all.filter(e => {
      const v = (e as HTMLInputElement).value;
      return v && v.trim() !== '';
    });
    const checked = (Array.from(document.querySelectorAll('input[type=radio]:checked, input[type=checkbox]:checked')) as HTMLInputElement[]);

    return {
      total: all.length,
      dittoFilled: dittoFilled.length,
      dittoFilledDetails: dittoFilled.map(e => ({ id: e.id || e.getAttribute('name'), value: (e as HTMLInputElement).value, status: e.dataset.dittoStatus })),
      atsFilled: atsFilled.length,
      atsFilledDetails: atsFilled.map(e => ({ id: e.id || e.getAttribute('name'), value: (e as HTMLInputElement).value })),
      fillFailed: fillFailed.length,
      withValue: withValue.length,
      withValueDetails: withValue.map(e => ({ id: e.id || e.getAttribute('name'), value: (e as HTMLInputElement).value })),
      checked: checked.length,
      checkedDetails: checked.map(e => ({ name: e.name, value: e.value })),
    };
  });

  console.log('\n=== DOM Statistics ===');
  console.log('Total form elements:', stats.total);
  console.log('Elements with dittoFilled=true:', stats.dittoFilled);
  console.log('  Details:', JSON.stringify(stats.dittoFilledDetails, null, 2));
  console.log('Elements with atsFilledNative=true:', stats.atsFilled);
  console.log('  Details:', JSON.stringify(stats.atsFilledDetails, null, 2));
  console.log('Elements with FILL_FAILED status:', stats.fillFailed);
  console.log('Elements with non-empty value:', stats.withValue);
  console.log('  Details:', JSON.stringify(stats.withValueDetails, null, 2));
  console.log('Radio/Checkbox checked:', stats.checked);
  console.log('  Details:', JSON.stringify(stats.checkedDetails, null, 2));

  // Get banner content
  const banner = await formPage.evaluate(() => {
    const host = document.getElementById('smartfillai-overlay-host');
    const b = host?.shadowRoot?.getElementById('sfa-banner');
    return b?.textContent?.trim() ?? '';
  });
  console.log('\n=== Banner ===');
  console.log(banner);

  console.log('\n=== Console logs (last 30) ===');
  allLogs.slice(-30).forEach(l => console.log(l));

  await formPage.screenshot({ path: path.resolve(__dirname, 'screenshots', 't-audit-diagnose.png'), fullPage: true });
  await formPage.close();
});
