/**
 * Unit tests for the Phase AK sensitive-domain blocklist regex and the
 * per-domain override behavior. The regex+override logic lives inside
 * content-script/index.ts as module-level helpers; we re-implement the
 * exact same logic here to test it standalone (the module itself can't be
 * imported into Jest because it touches `chrome.*` globals).
 */

const SENSITIVE_HOSTNAME_RE = /\b(bank(ing)?|paypal|chase|wellsfargo|capitalone|citibank|usbank|fidelity|vanguard|schwab|etrade|robinhood|brokerage|mychart|hospital|healthcare|health\.|insurance|pension|medicare|medicaid|tax\b|police|courthouse|courts)\b|\.gov(\.|$)/;

function isSensitive(
  hostname: string,
  overrides: Record<string, { enabled: boolean; autoFill: boolean }> = {}
): boolean {
  const o = overrides[hostname];
  if (o !== undefined) return !o.enabled;
  return SENSITIVE_HOSTNAME_RE.test(hostname);
}

describe('Phase AK — sensitive-domain blocklist regex', () => {
  describe('blocks expected hosts', () => {
    const blocked = [
      'chase.com',
      'banking.chase.com',
      'wellsfargo.com',
      'bank.example.com',           // \b matches before "bank"
      'paypal.com',
      'fidelity.com',
      'vanguard.com',
      'robinhood.com',
      'mychart.epic.com',
      'hospital-stmarys.org',
      'health.aetna.com',
      'healthcare.gov',
      'insurance.allstate.com',
      'pensionauthority.gov.uk',
      'medicare.gov',
      'medicaid.gov',
      'tax.service.gov.uk',
      'police.uk',
      'courthouse.county.gov',
      'irs.gov',
      'ssa.gov',
    ];
    for (const host of blocked) {
      it(`blocks ${host}`, () => {
        expect(isSensitive(host)).toBe(true);
      });
    }
  });

  describe('does NOT block ordinary job-application hosts', () => {
    const allowed = [
      'boards.greenhouse.io',
      'jobs.lever.co',
      'jobs.ashbyhq.com',
      'careers.workday.com',
      'jobs.databricks.com',
      'apply.stripe.com',
      'careers.google.com',
      'company.com',
      'localhost',
      '127.0.0.1',
      // Borderline name; should still be allowed (no /bank/ word boundary hit)
      'jobsbankok.com', // contains "bankok" but no \b before "bank"
    ];
    for (const host of allowed) {
      it(`allows ${host}`, () => {
        expect(isSensitive(host)).toBe(false);
      });
    }
  });

  describe('per-domain override beats the regex', () => {
    it('user opts IN to a regex-blocked domain (e.g. their own bank careers site)', () => {
      const overrides = { 'careers.chase.com': { enabled: true, autoFill: true } };
      expect(isSensitive('careers.chase.com', overrides)).toBe(false);
    });

    it('user opts OUT of a normally-allowed domain (force block)', () => {
      const overrides = { 'jobs.example.com': { enabled: false, autoFill: false } };
      expect(isSensitive('jobs.example.com', overrides)).toBe(true);
    });

    it('override on a different hostname does not affect this one', () => {
      const overrides = { 'careers.chase.com': { enabled: true, autoFill: true } };
      // chase.com (not careers.chase.com) is still blocked by regex
      expect(isSensitive('chase.com', overrides)).toBe(true);
    });
  });
});
