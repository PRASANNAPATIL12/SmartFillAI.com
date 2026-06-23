/**
 * Embedded ATS Detection Tests — Phase AE.1
 *
 * Validates each of the 7 detection layers in isolation and verifies that the
 * priority ordering (direct hostname > query param > iframe > form action >
 * script src > DOM signature > hostname fallback) produces the right answer
 * when multiple signals coexist on the same page.
 *
 * The Databricks failure that motivated this phase — `databricks.com` page
 * with `?gh_jid=...` query param — is the primary test case.
 */

import { detectAts, getAtsId, invalidateAtsCache } from '../content-script/company-detector';

function freshDoc(html: string = '<html><body></body></html>'): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

beforeEach(() => {
  invalidateAtsCache();
});

// ── Layer 1: Direct hostname ────────────────────────────────────────────────

describe('Layer 1 — direct hostname', () => {
  test('boards.greenhouse.io → greenhouse (confidence 1.0)', () => {
    const result = detectAts('https://boards.greenhouse.io/databricks', freshDoc());
    expect(result.atsId).toBe('greenhouse');
    expect(result.confidence).toBe(1.0);
    expect(result.method).toBe('direct_hostname');
  });

  test('jobs.lever.co → lever', () => {
    const result = detectAts('https://jobs.lever.co/anthropic', freshDoc());
    expect(result.atsId).toBe('lever');
    expect(result.method).toBe('direct_hostname');
  });

  test('<co>.myworkdayjobs.com → workday (subdomain pattern)', () => {
    const result = detectAts('https://stripe.wd5.myworkdayjobs.com/Stripe/...', freshDoc());
    expect(result.atsId).toBe('workday');
    expect(result.method).toBe('direct_hostname');
  });

  test('ashbyhq.com → ashby', () => {
    const result = detectAts('https://jobs.ashbyhq.com/anthropic', freshDoc());
    expect(result.atsId).toBe('ashby');
  });
});

// ── Layer 2: Query-param signature ──────────────────────────────────────────

describe('Layer 2 — query-param signature (the Databricks fix)', () => {
  test('databricks.com/...?gh_jid=... → greenhouse', () => {
    const result = detectAts(
      'https://www.databricks.com/company/careers/field-engineering---other/specialist-solutions-architect---ai-ml-8585164002?gh_jid=8585164002',
      freshDoc(),
    );
    expect(result.atsId).toBe('greenhouse');
    expect(result.confidence).toBe(0.95);
    expect(result.method).toBe('query_param');
  });

  test('?gh_src= → greenhouse', () => {
    const result = detectAts('https://example.com/careers?gh_src=referral', freshDoc());
    expect(result.atsId).toBe('greenhouse');
  });

  test('?lever_source= → lever', () => {
    const result = detectAts('https://example.com/jobs?lever_source=careers', freshDoc());
    expect(result.atsId).toBe('lever');
  });

  test('?iis= → icims (embedded iCIMS marker)', () => {
    const result = detectAts('https://example.com/careers?iis=Iframe', freshDoc());
    expect(result.atsId).toBe('icims');
  });

  test('unrelated query params → fall through to fallback', () => {
    const result = detectAts('https://example.com/?utm_source=google', freshDoc());
    expect(result.method).toBe('hostname_fallback');
  });
});

// ── Layer 3: Iframe src inspection ──────────────────────────────────────────

describe('Layer 3 — iframe src', () => {
  test('iframe pointing at boards.greenhouse.io → greenhouse', () => {
    const doc = freshDoc(
      '<html><body><iframe src="https://boards.greenhouse.io/embed/job_app?for=acme&token=42"></iframe></body></html>',
    );
    const result = detectAts('https://acme.com/careers', doc);
    expect(result.atsId).toBe('greenhouse');
    expect(result.confidence).toBe(0.95);
    expect(result.method).toBe('iframe');
  });

  test('iframe with data-src lazy loader → greenhouse', () => {
    const doc = freshDoc(
      '<html><body><iframe data-src="https://app.greenhouse.io/embed"></iframe></body></html>',
    );
    const result = detectAts('https://acme.com/careers', doc);
    expect(result.atsId).toBe('greenhouse');
  });

  test('iframe pointing at jobs.lever.co → lever', () => {
    const doc = freshDoc(
      '<html><body><iframe src="https://jobs.lever.co/anthropic/abc/embed"></iframe></body></html>',
    );
    const result = detectAts('https://anthropic.com/careers', doc);
    expect(result.atsId).toBe('lever');
  });

  test('unrelated iframes do not trigger', () => {
    const doc = freshDoc(
      '<html><body><iframe src="https://www.youtube.com/embed/abc"></iframe></body></html>',
    );
    const result = detectAts('https://acme.com/careers', doc);
    expect(result.method).toBe('hostname_fallback');
  });
});

// ── Layer 4: Form action URL ────────────────────────────────────────────────

describe('Layer 4 — form action URL', () => {
  test('<form action="...greenhouse.io..."> → greenhouse', () => {
    const doc = freshDoc(
      '<html><body><form action="https://boards-api.greenhouse.io/v1/applications" method="POST"></form></body></html>',
    );
    const result = detectAts('https://acme.com/careers', doc);
    expect(result.atsId).toBe('greenhouse');
    expect(result.confidence).toBe(0.90);
    expect(result.method).toBe('form_action');
  });

  test('relative form action does not falsely trigger', () => {
    const doc = freshDoc('<html><body><form action="/submit"></form></body></html>');
    const result = detectAts('https://acme.com/careers', doc);
    expect(result.method).toBe('hostname_fallback');
  });
});

// ── Layer 5: Script src inspection ──────────────────────────────────────────

describe('Layer 5 — script src', () => {
  test('<script src="boards-api.greenhouse.io/..."> → greenhouse', () => {
    const doc = freshDoc(
      '<html><body><script src="https://boards-api.greenhouse.io/v1/boards/acme/embed.js"></script></body></html>',
    );
    const result = detectAts('https://acme.com/careers', doc);
    expect(result.atsId).toBe('greenhouse');
    expect(result.confidence).toBe(0.90);
    expect(result.method).toBe('script_src');
  });

  test('Workday CDN script → workday', () => {
    const doc = freshDoc(
      '<html><body><script src="https://www.myworkday.com/js/wd-applicant.js"></script></body></html>',
    );
    const result = detectAts('https://acme.com/careers', doc);
    expect(result.atsId).toBe('workday');
  });
});

// ── Layer 6: DOM signature ──────────────────────────────────────────────────

describe('Layer 6 — DOM signature', () => {
  test('#greenhouse_application root → greenhouse', () => {
    const doc = freshDoc(
      '<html><body><div id="greenhouse_application"></div></body></html>',
    );
    const result = detectAts('https://acme.com/careers', doc);
    expect(result.atsId).toBe('greenhouse');
    expect(result.confidence).toBe(0.85);
    expect(result.method).toBe('dom_signature');
  });

  test('[data-automation-id] → workday', () => {
    const doc = freshDoc(
      '<html><body><div data-automation-id="job-application-form"></div></body></html>',
    );
    const result = detectAts('https://acme.com/careers', doc);
    expect(result.atsId).toBe('workday');
  });

  test('[data-ashby-job-posting-id] → ashby', () => {
    const doc = freshDoc(
      '<html><body><div data-ashby-job-posting-id="abc-123"></div></body></html>',
    );
    const result = detectAts('https://acme.com/careers', doc);
    expect(result.atsId).toBe('ashby');
  });
});

// ── Layer 7: Hostname fallback ──────────────────────────────────────────────

describe('Layer 7 — hostname fallback', () => {
  test('unknown host with no markers → host:<hostname>', () => {
    const result = detectAts('https://www.random-company.com/jobs/abc', freshDoc());
    expect(result.atsId).toBe('host:www.random-company.com');
    expect(result.confidence).toBe(0.3);
    expect(result.method).toBe('hostname_fallback');
  });
});

// ── Priority ordering ───────────────────────────────────────────────────────

describe('Priority ordering — first confident match wins', () => {
  test('direct hostname beats query param', () => {
    // hostname IS greenhouse, ALSO has lever_source param. Hostname wins.
    const result = detectAts(
      'https://boards.greenhouse.io/acme?lever_source=referral',
      freshDoc(),
    );
    expect(result.atsId).toBe('greenhouse');
    expect(result.method).toBe('direct_hostname');
  });

  test('query param beats iframe', () => {
    // gh_jid query param + a Lever iframe. Query param wins (higher priority).
    const doc = freshDoc(
      '<html><body><iframe src="https://jobs.lever.co/x"></iframe></body></html>',
    );
    const result = detectAts('https://acme.com/?gh_jid=42', doc);
    expect(result.atsId).toBe('greenhouse');
    expect(result.method).toBe('query_param');
  });

  test('iframe beats DOM signature', () => {
    // Workday DOM marker + Greenhouse iframe. Iframe wins (higher confidence).
    const doc = freshDoc(
      '<html><body>' +
      '<div data-automation-id="x"></div>' +
      '<iframe src="https://boards.greenhouse.io/acme"></iframe>' +
      '</body></html>',
    );
    const result = detectAts('https://acme.com/careers', doc);
    expect(result.atsId).toBe('greenhouse');
    expect(result.method).toBe('iframe');
  });
});

// ── Caching + invalidation ──────────────────────────────────────────────────

describe('Caching + invalidation', () => {
  test('confident result is cached across calls', () => {
    const a = detectAts('https://boards.greenhouse.io/acme', freshDoc());
    // Pass a DIFFERENT url — should still return the cached greenhouse hit
    // (real callers don't pass changing args mid-page-load; this proves cache hit).
    const b = detectAts('https://different.com', freshDoc());
    expect(b.atsId).toBe(a.atsId);
    expect(b.method).toBe(a.method);
  });

  test('hostname fallback (<0.85 confidence) is NOT cached so MO can retry', () => {
    const a = detectAts('https://acme.com/careers', freshDoc());
    expect(a.method).toBe('hostname_fallback');
    // After a "MutationObserver tick" mounts the Greenhouse application root:
    const docAfterMount = freshDoc(
      '<html><body><div id="greenhouse_application"></div></body></html>',
    );
    const b = detectAts('https://acme.com/careers', docAfterMount);
    expect(b.atsId).toBe('greenhouse');
    expect(b.method).toBe('dom_signature');
  });

  test('invalidateAtsCache() forces re-detection', () => {
    const a = detectAts('https://boards.greenhouse.io/x', freshDoc());
    invalidateAtsCache();
    const b = detectAts('https://acme.com/careers', freshDoc());
    expect(b.atsId).toBe('host:acme.com');
    expect(a.atsId).not.toBe(b.atsId);
  });
});

// ── Backward-compat wrapper ─────────────────────────────────────────────────

describe('getAtsId (backward-compat wrapper)', () => {
  test('returns greenhouse for a Greenhouse host', () => {
    expect(getAtsId('https://boards.greenhouse.io/acme')).toBe('greenhouse');
  });

  test('returns host:<hostname> for an unknown site', () => {
    // Invalidate so the previous test's confident hit (cached for the whole
    // page-load) doesn't leak into this assertion.
    invalidateAtsCache();
    expect(getAtsId('https://www.unknown.com/jobs')).toBe('host:www.unknown.com');
  });
});
