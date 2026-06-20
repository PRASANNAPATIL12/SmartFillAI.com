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
