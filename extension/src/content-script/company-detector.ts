/**
 * Best-effort detection of WHICH company's form is open, so narrative answers
 * can be synthesized to name the right employer ("why do you want to work at
 * <company>?"). Heuristic, ordered most→least reliable:
 *
 *   1. JSON-LD JobPosting.hiringOrganization.name / Organization.name
 *   2. <meta property="og:site_name">
 *   3. Known ATS URL shapes (greenhouse / lever / workday / workable / …)
 *   4. cleaned <title>
 *   5. hostname label
 *
 * Returns { name: '', confidence: 0 } when nothing is determinable — callers
 * must treat an empty name as "unknown" and synthesize generically.
 *
 * Cached per page load (company doesn't change within a document).
 */

export interface CompanyGuess {
  name: string;
  confidence: number;
}

let _cached: CompanyGuess | null = null;

export function detectCompany(): CompanyGuess {
  if (_cached) return _cached;
  _cached = computeCompany();
  return _cached;
}

function capitalize(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

/** Strip ATS/careers boilerplate from a title or site name. */
function clean(name: string): string {
  return name
    .replace(/\s*[|\-–—:•·]\s*(careers?|jobs?|job\s+application|apply|hiring|workday|greenhouse|lever|workable|smartrecruiters|icims|ashby|jobvite)\b.*$/i, '')
    .replace(/\b(careers?|jobs?|hiring|apply\s+now)\b/ig, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s|\-–—:•·]+|[\s|\-–—:•·]+$/g, '')
    .trim();
}

function companyFromAtsUrl(): string | null {
  const host = location.hostname.toLowerCase();
  const seg = location.pathname.split('/').filter(Boolean);

  // greenhouse.io/<co>, jobs.lever.co/<co>, apply.workable.com/<co>, ashbyhq.com/<co>
  if (/(greenhouse\.io|lever\.co|workable\.com|ashbyhq\.com|smartrecruiters\.com|jobvite\.com)$/.test(host)) {
    if (seg[0] && !/^(embed|j|o|jobs|careers)$/i.test(seg[0])) return capitalize(decodeURIComponent(seg[0]));
    if (seg[1]) return capitalize(decodeURIComponent(seg[1]));
  }

  // <co>.myworkdayjobs.com, <co>.applytojob.com, <co>.bamboohr.com, <co>.recruitee.com
  const sub = host.match(/^([a-z0-9-]+)\.(myworkdayjobs|applytojob|bamboohr|recruitee|breezy|freshteam)\.com/);
  if (sub && sub[1] && sub[1] !== 'www') return capitalize(sub[1]);

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ATS family detection — Phase AD.1 (direct hostname) + AE.1 (embedded)
// ─────────────────────────────────────────────────────────────────────────────
//
// Returns a stable family token like "greenhouse", "workday", "lever". Used
// by form-fingerprinter to scope fingerprints across all companies on the
// same ATS (one Greenhouse fingerprint generalizes across all Greenhouse-
// hosted employers because the form structure is identical).
//
// Detection priority (first confident match wins):
//   1. Direct hostname     (confidence 1.0)  — boards.greenhouse.io, jobs.lever.co
//   2. Query-param signal  (0.95)            — ?gh_jid=, ?lever_source=, ?iis=
//   3. Iframe src           (0.95)            — <iframe src="...greenhouse.io...">
//   4. Form action URL      (0.90)            — <form action="...greenhouse.io...">
//   5. Script src           (0.90)            — <script src="boards-api.greenhouse.io">
//   6. DOM signature        (0.85)            — #greenhouse_application, [data-automation-id]
//   7. Hostname fallback    (0.30)            — host:<hostname>
//
// Layers 2–6 catch the common case where a large company embeds an ATS form
// on their own domain (databricks.com runs Greenhouse, stripe.com runs
// Greenhouse, etc) — the Databricks failure we hit in real testing.

const ATS_HOST_PATTERNS: ReadonlyArray<{ id: string; rx: RegExp }> = [
  { id: 'greenhouse',      rx: /(?:^|\.)greenhouse\.io$/ },
  { id: 'greenhouse',      rx: /(?:^|\.)boards\.greenhouse\.io$/ },
  { id: 'greenhouse',      rx: /(?:^|\.)job-boards\.greenhouse\.io$/ },
  { id: 'lever',           rx: /(?:^|\.)lever\.co$/ },
  { id: 'workable',        rx: /(?:^|\.)workable\.com$/ },
  { id: 'ashby',           rx: /(?:^|\.)ashbyhq\.com$/ },
  { id: 'smartrecruiters', rx: /(?:^|\.)smartrecruiters\.com$/ },
  { id: 'jobvite',         rx: /(?:^|\.)jobvite\.com$/ },
  { id: 'icims',           rx: /(?:^|\.)icims\.com$/ },
];

// Subdomain-style ATSes (each employer gets `<co>.ats.com`).
const ATS_SUBDOMAIN_PATTERNS: ReadonlyArray<{ id: string; rx: RegExp }> = [
  { id: 'workday',         rx: /\.myworkdayjobs\.com$/ },
  { id: 'applytojob',      rx: /\.applytojob\.com$/ },
  { id: 'bamboohr',        rx: /\.bamboohr\.com$/ },
  { id: 'recruitee',       rx: /\.recruitee\.com$/ },
  { id: 'breezy',          rx: /\.breezy\.hr$/ },
  { id: 'breezy',          rx: /\.breezy\.com$/ },
  { id: 'freshteam',       rx: /\.freshteam\.com$/ },
];

/**
 * Query parameters that uniquely identify an embedded ATS. Conservative list
 * — only include params with a near-zero false-positive rate. `gh_jid` is the
 * Greenhouse job ID, `lever_source` is Lever's referral tracker, etc.
 */
const ATS_QUERY_PARAMS: ReadonlyArray<{ param: string; atsId: string }> = [
  { param: 'gh_jid',        atsId: 'greenhouse' },
  { param: 'gh_src',        atsId: 'greenhouse' },
  { param: 'gh_token',      atsId: 'greenhouse' },
  { param: 'lever_source',  atsId: 'lever' },
  { param: 'lever_origin',  atsId: 'lever' },
  { param: 'iis',           atsId: 'icims' },
  { param: 'in_iframe',     atsId: 'icims' },
];

/**
 * URL substrings appearing in script srcs / form actions / iframe srcs that
 * uniquely identify the underlying ATS even when the parent page is on a
 * company-owned domain. Subset matches against full URL.
 */
const ATS_URL_SUBSTRINGS: ReadonlyArray<{ substring: string; atsId: string }> = [
  { substring: 'boards.greenhouse.io',     atsId: 'greenhouse' },
  { substring: 'boards-api.greenhouse.io', atsId: 'greenhouse' },
  { substring: 'app.greenhouse.io',        atsId: 'greenhouse' },
  { substring: 'job-boards.greenhouse.io', atsId: 'greenhouse' },
  { substring: 'jobs.lever.co',            atsId: 'lever' },
  { substring: 'myworkday.com',            atsId: 'workday' },
  { substring: 'myworkdayjobs.com',        atsId: 'workday' },
  { substring: 'smartrecruiters.com',      atsId: 'smartrecruiters' },
  { substring: 'icims.com',                atsId: 'icims' },
  { substring: 'ashbyhq.com',              atsId: 'ashby' },
  { substring: 'workable.com',             atsId: 'workable' },
];

/**
 * CSS selectors that uniquely identify an ATS's rendered form. Found on the
 * parent page even when the form itself is in an iframe. Use ATS-specific IDs
 * and data attributes only — generic class names like `.form` are excluded.
 */
const ATS_DOM_SIGNATURES: ReadonlyArray<{ selector: string; atsId: string }> = [
  { selector: '#greenhouse_application',         atsId: 'greenhouse' },
  { selector: '#grnhse_app',                     atsId: 'greenhouse' },
  { selector: 'iframe#grnhse_iframe',            atsId: 'greenhouse' },
  { selector: '[data-greenhouse]',               atsId: 'greenhouse' },
  { selector: '[data-automation-id]',            atsId: 'workday' },
  { selector: '[data-automation-widget]',        atsId: 'workday' },
  { selector: '.lever-application-form',         atsId: 'lever' },
  { selector: 'form[data-qa="application-form"]', atsId: 'lever' },
  { selector: '[data-ashby-job-posting-id]',     atsId: 'ashby' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface AtsDetection {
  atsId: string;       // "greenhouse" | "workday" | … | "host:<hostname>"
  confidence: number;  // 1.0 (direct) → 0.30 (fallback)
  method:
    | 'direct_hostname'
    | 'query_param'
    | 'iframe'
    | 'form_action'
    | 'script_src'
    | 'dom_signature'
    | 'hostname_fallback';
}

// Cache the result per page load. Sub-0.85 detections aren't cached so a
// MutationObserver tick can pick up late-injected iframes/scripts.
let _atsDetectionCache: AtsDetection | null = null;

/**
 * Detect the underlying ATS family for the current page. Pass an explicit URL
 * and Document for testing; both default to the live page context.
 *
 * Returns the highest-confidence detection from the 7 layers.
 */
export function detectAts(url?: string, doc?: Document): AtsDetection {
  if (_atsDetectionCache && _atsDetectionCache.confidence >= 0.85) {
    return _atsDetectionCache;
  }
  const result = resolveAtsDetection(url, doc);
  if (result.confidence >= 0.85) {
    _atsDetectionCache = result;
  }
  return result;
}

/**
 * Bust the cached detection so the next detectAts() call re-runs every layer.
 * Called from the content-script's MutationObserver when new iframe or script
 * tags appear — late-injected ATS scripts then get picked up on the next scan.
 */
export function invalidateAtsCache(): void {
  _atsDetectionCache = null;
}

/**
 * Backward-compatible wrapper — returns just the atsId token. New callers
 * should prefer detectAts() so they can log the detection method.
 */
export function getAtsId(urlOrHost?: string): string {
  const docArg = typeof document !== 'undefined' ? document : undefined;
  return detectAts(urlOrHost, docArg).atsId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection layers
// ─────────────────────────────────────────────────────────────────────────────

function resolveAtsDetection(url?: string, doc?: Document): AtsDetection {
  const host = resolveHost(url);

  // Layer 1 — direct hostname (existing AD.1 logic)
  const direct = atsFromHostname(host);
  if (direct) {
    return { atsId: direct, confidence: 1.0, method: 'direct_hostname' };
  }

  // Layer 2 — query parameter signature
  const fromQuery = detectFromQueryParams(url);
  if (fromQuery) {
    return { atsId: fromQuery, confidence: 0.95, method: 'query_param' };
  }

  // Layers 3–6 require a Document
  if (doc) {
    const fromIframe = detectFromIframes(doc);
    if (fromIframe) return { atsId: fromIframe, confidence: 0.95, method: 'iframe' };

    const fromFormAction = detectFromFormActions(doc);
    if (fromFormAction) return { atsId: fromFormAction, confidence: 0.90, method: 'form_action' };

    const fromScript = detectFromScripts(doc);
    if (fromScript) return { atsId: fromScript, confidence: 0.90, method: 'script_src' };

    const fromDom = detectFromDomSignatures(doc);
    if (fromDom) return { atsId: fromDom, confidence: 0.85, method: 'dom_signature' };
  }

  // Layer 7 — hostname fallback
  return { atsId: `host:${host}`, confidence: 0.3, method: 'hostname_fallback' };
}

function resolveHost(urlOrHost?: string): string {
  try {
    if (urlOrHost && urlOrHost.includes('://')) {
      return new URL(urlOrHost).hostname.toLowerCase();
    }
    if (urlOrHost) return urlOrHost.toLowerCase();
    if (typeof location !== 'undefined') return location.hostname.toLowerCase();
  } catch { /* fall through */ }
  return '';
}

/** Match a hostname against the direct ATS host/subdomain patterns. */
function atsFromHostname(host: string): string | null {
  if (!host) return null;
  for (const p of ATS_HOST_PATTERNS) if (p.rx.test(host)) return p.id;
  for (const p of ATS_SUBDOMAIN_PATTERNS) if (p.rx.test(host)) return p.id;
  return null;
}

function detectFromQueryParams(url?: string): string | null {
  const target = url ?? (typeof location !== 'undefined' ? location.href : '');
  if (!target) return null;
  let params: URLSearchParams;
  try {
    params = new URL(target, 'http://localhost').searchParams;
  } catch { return null; }
  for (const sig of ATS_QUERY_PARAMS) {
    if (params.has(sig.param)) return sig.atsId;
  }
  return null;
}

function detectFromIframes(doc: Document): string | null {
  let iframes: NodeListOf<HTMLIFrameElement>;
  try {
    iframes = doc.querySelectorAll('iframe');
  } catch { return null; }
  const baseHref = (() => {
    try { return (doc as unknown as { location?: Location }).location?.href ?? 'http://localhost'; }
    catch { return 'http://localhost'; }
  })();
  for (const iframe of Array.from(iframes)) {
    const src = iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
    if (!src) continue;
    let host = '';
    try { host = new URL(src, baseHref).hostname.toLowerCase(); } catch { continue; }
    const hit = atsFromHostname(host);
    if (hit) return hit;
    // Also accept URL-substring match for paths like data-src="/embed/greenhouse"
    for (const sig of ATS_URL_SUBSTRINGS) {
      if (src.toLowerCase().includes(sig.substring)) return sig.atsId;
    }
  }
  return null;
}

function detectFromFormActions(doc: Document): string | null {
  let forms: NodeListOf<HTMLFormElement>;
  try {
    forms = doc.querySelectorAll('form[action]');
  } catch { return null; }
  for (const form of Array.from(forms)) {
    const action = (form.getAttribute('action') || '').toLowerCase();
    if (!action) continue;
    for (const sig of ATS_URL_SUBSTRINGS) {
      if (action.includes(sig.substring)) return sig.atsId;
    }
  }
  return null;
}

function detectFromScripts(doc: Document): string | null {
  let scripts: NodeListOf<HTMLScriptElement>;
  try {
    scripts = doc.querySelectorAll('script[src]');
  } catch { return null; }
  for (const script of Array.from(scripts)) {
    const src = (script.getAttribute('src') || '').toLowerCase();
    if (!src) continue;
    for (const sig of ATS_URL_SUBSTRINGS) {
      if (src.includes(sig.substring)) return sig.atsId;
    }
  }
  return null;
}

function detectFromDomSignatures(doc: Document): string | null {
  for (const sig of ATS_DOM_SIGNATURES) {
    try {
      if (doc.querySelector(sig.selector)) return sig.atsId;
    } catch { continue; }
  }
  return null;
}

function fromJsonLd(): string | null {
  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  for (const s of scripts) {
    let data: unknown;
    try { data = JSON.parse(s.textContent || 'null'); } catch { continue; }
    const nodes = Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      const n = node as Record<string, any> | null;
      const org = n?.hiringOrganization?.name
        ?? ((n?.['@type'] === 'Organization' || n?.['@type'] === 'Corporation') ? n?.name : null);
      if (typeof org === 'string' && org.trim()) return org.trim();
    }
  }
  return null;
}

function computeCompany(): CompanyGuess {
  const jsonld = fromJsonLd();
  if (jsonld) return { name: clean(jsonld) || jsonld.trim(), confidence: 0.95 };

  const og = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content');
  if (og && og.trim()) {
    const c = clean(og);
    if (c) return { name: c, confidence: 0.8 };
  }

  const ats = companyFromAtsUrl();
  if (ats) return { name: ats, confidence: 0.75 };

  const title = clean(document.title || '');
  if (title && title.length >= 2 && title.length <= 60) return { name: title, confidence: 0.5 };

  const host = location.hostname.replace(/^www\./, '').split('.')[0];
  if (host && !/^(jobs|careers|apply|boards|app|talent|recruiting)$/i.test(host)) {
    return { name: capitalize(host), confidence: 0.3 };
  }

  return { name: '', confidence: 0 };
}
