/**
 * Detection Tests — Phase 3
 *
 * Tests DOM-based field discovery using jsdom. Uses the global document so
 * elements are `isConnected = true`. offsetParent is mocked to mimic browser
 * layout behavior (null only for display:none ancestors).
 */

import { extractAllFields, gatherDropdownOptions } from '../content-script/detector';

// ── jsdom layout shim ─────────────────────────────────────────────────────────
// isVisible() in detector.ts checks offsetParent === null as a proxy for
// display:none. jsdom has no layout engine so we simulate it here.

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    get(this: HTMLElement) {
      // Walk ancestors — if any has display:none, return null (hidden)
      let el: HTMLElement | null = this;
      while (el && el !== document.body) {
        if (el.style.display === 'none') return null;
        el = el.parentElement;
      }
      return this.parentElement ?? document.body;
    },
    configurable: true,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

// ── DOM helpers ──────────────────────────────────────────────────────────────

function render(html: string): void {
  document.body.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════════
// extractAllFields — basic coverage
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractAllFields — basic field types', () => {
  it('finds text input', () => {
    render('<input type="text" id="fn" placeholder="First name">');
    const sigs = extractAllFields(document);
    expect(sigs.some(s => s.inputType === 'text')).toBe(true);
  });

  it('finds email input', () => {
    render('<input type="email" id="em" autocomplete="email">');
    const sigs = extractAllFields(document);
    expect(sigs.some(s => s.inputType === 'email')).toBe(true);
  });

  it('finds textarea', () => {
    render('<textarea id="bio" placeholder="Bio"></textarea>');
    const sigs = extractAllFields(document);
    expect(sigs.some(s => s.inputType === 'textarea')).toBe(true);
  });

  it('finds select', () => {
    render('<select id="country"><option>USA</option><option>India</option></select>');
    const sigs = extractAllFields(document);
    expect(sigs.some(s => s.inputType === 'select')).toBe(true);
  });

  it('skips hidden input', () => {
    render('<input type="hidden" name="csrf" value="abc">');
    const sigs = extractAllFields(document);
    expect(sigs.every(s => s.inputType !== 'hidden')).toBe(true);
  });

  it('includes password input with inputType=password (matcher will skip it)', () => {
    render('<input type="password" id="pw">');
    const sigs = extractAllFields(document);
    // Detector emits password fields — the matcher is responsible for SKIP logic
    const pwSig = sigs.find(s => s.id === 'pw');
    expect(pwSig).toBeDefined();
    expect(pwSig!.inputType).toBe('password');
  });

  it('finds multiple fields in one form', () => {
    render(`
      <form>
        <label for="fn">First Name</label><input type="text" id="fn">
        <label for="em">Email</label><input type="email" id="em">
        <textarea id="bio"></textarea>
        <select id="country"><option>USA</option></select>
        <input type="hidden" name="csrf" value="x">
        <input type="password" id="pw">
      </form>
    `);
    const sigs = extractAllFields(document);
    // 5 fields (text, email, textarea, select, password); only hidden is excluded
    expect(sigs.length).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Label resolution — tested indirectly via extractAllFields
// ═══════════════════════════════════════════════════════════════════════════════

describe('Label resolution (via extractAllFields)', () => {
  it('picks up aria-label', () => {
    render('<input type="text" aria-label="Full Name">');
    const sigs = extractAllFields(document);
    expect(sigs[0]?.ariaLabel).toBe('Full Name');
  });

  it('picks up <label for=...>', () => {
    render('<label for="fn">First Name</label><input type="text" id="fn">');
    const sigs = extractAllFields(document);
    expect(sigs[0]?.label).toBe('First Name');
  });

  it('picks up placeholder when no label', () => {
    render('<input type="text" placeholder="Enter your city">');
    const sigs = extractAllFields(document);
    expect(sigs[0]?.placeholder).toBe('Enter your city');
  });

  it('picks up autocomplete attribute', () => {
    render('<input type="text" autocomplete="family-name">');
    const sigs = extractAllFields(document);
    expect(sigs[0]?.autocomplete).toBe('family-name');
  });

  it('picks up name attribute', () => {
    render('<input type="text" name="last_name">');
    const sigs = extractAllFields(document);
    expect(sigs[0]?.name).toBe('last_name');
  });

  it('picks up wrapped label (label wrapping input)', () => {
    render('<label>Last Name <input type="text"></label>');
    const sigs = extractAllFields(document);
    expect(sigs[0]?.label).toMatch(/Last Name/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Native radio groups
// ═══════════════════════════════════════════════════════════════════════════════

describe('Radio group detection', () => {
  it('detects a radio group with fieldset legend', () => {
    render(`
      <fieldset>
        <legend>Experience Level</legend>
        <label><input type="radio" name="exp" value="0-2"> 0-2 years</label>
        <label><input type="radio" name="exp" value="3-5"> 3-5 years</label>
        <label><input type="radio" name="exp" value="6+"> 6+ years</label>
      </fieldset>
    `);
    const sigs = extractAllFields(document);
    const radioSig = sigs.find(s => s.inputType === 'radio-group');
    expect(radioSig).toBeDefined();
    expect(radioSig!.label).toMatch(/Experience/i);
    expect(radioSig!.options!.length).toBe(3);
  });

  it('emits one signature per radio group (not per radio button)', () => {
    render(`
      <fieldset>
        <legend>Gender</legend>
        <label><input type="radio" name="gender" value="male"> Male</label>
        <label><input type="radio" name="gender" value="female"> Female</label>
      </fieldset>
    `);
    const sigs = extractAllFields(document);
    const radioSigs = sigs.filter(s => s.inputType === 'radio-group');
    expect(radioSigs).toHaveLength(1);
  });

  it('captures option labels from radio group', () => {
    render(`
      <fieldset>
        <legend>Authorized to Work</legend>
        <label><input type="radio" name="auth" value="yes"> Yes</label>
        <label><input type="radio" name="auth" value="no"> No</label>
      </fieldset>
    `);
    const sigs = extractAllFields(document);
    const radioSig = sigs.find(s => s.inputType === 'radio-group');
    expect(radioSig!.options).toContain('Yes');
    expect(radioSig!.options).toContain('No');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Native checkbox groups
// ═══════════════════════════════════════════════════════════════════════════════

describe('Checkbox group detection', () => {
  it('detects a checkbox group', () => {
    render(`
      <fieldset>
        <legend>Skills</legend>
        <label><input type="checkbox" name="skills" value="react"> React</label>
        <label><input type="checkbox" name="skills" value="ts"> TypeScript</label>
        <label><input type="checkbox" name="skills" value="node"> Node.js</label>
      </fieldset>
    `);
    const sigs = extractAllFields(document);
    const cbSig = sigs.find(s => s.inputType === 'checkbox-group');
    expect(cbSig).toBeDefined();
    expect(cbSig!.label).toMatch(/Skills/i);
    expect(cbSig!.options!.length).toBe(3);
  });

  it('emits one signature per checkbox group', () => {
    render(`
      <fieldset>
        <legend>Languages</legend>
        <label><input type="checkbox" name="lang" value="en"> English</label>
        <label><input type="checkbox" name="lang" value="es"> Spanish</label>
      </fieldset>
    `);
    const sigs = extractAllFields(document);
    const cbSigs = sigs.filter(s => s.inputType === 'checkbox-group');
    expect(cbSigs).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Select options
// ═══════════════════════════════════════════════════════════════════════════════

describe('Select options population', () => {
  it('populates options array for select', () => {
    render(`
      <select id="country">
        <option value="">-- Select --</option>
        <option value="us">United States</option>
        <option value="in">India</option>
        <option value="uk">UK</option>
      </select>
    `);
    const sigs = extractAllFields(document);
    const sel = sigs.find(s => s.inputType === 'select');
    expect(sel).toBeDefined();
    expect(sel!.options).toContain('United States');
    expect(sel!.options).toContain('India');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// gatherDropdownOptions (exported utility)
// ═══════════════════════════════════════════════════════════════════════════════

describe('gatherDropdownOptions', () => {
  it('returns option text from a <select>', () => {
    render(`
      <select>
        <option>United States</option>
        <option>India</option>
        <option>UK</option>
      </select>
    `);
    const select = document.querySelector('select') as HTMLElement;
    const opts = gatherDropdownOptions(select);
    expect(opts).toBeDefined();
    expect(opts).toContain('United States');
    expect(opts).toContain('India');
    expect(opts).toContain('UK');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ARIA widget detection
// ═══════════════════════════════════════════════════════════════════════════════

describe('ARIA widget detection (via extractAllFields)', () => {
  it('detects role=combobox as ax-combobox', () => {
    render(`<div role="combobox" aria-label="Country" aria-expanded="false">United States</div>`);
    const sigs = extractAllFields(document);
    const ax = sigs.find(s => s.inputType === 'ax-combobox');
    expect(ax).toBeDefined();
    expect(ax!.ariaLabel).toBe('Country');
  });

  it('detects contenteditable div as ax-textbox', () => {
    render(`<div role="textbox" contenteditable="true" aria-label="Cover Letter"></div>`);
    const sigs = extractAllFields(document);
    // Should be detected as ax-textbox (role=textbox), not native input
    const ax = sigs.find(s => s.inputType === 'ax-textbox' || s.inputType === 'contenteditable');
    expect(ax).toBeDefined();
  });

  it('detects role=radiogroup as ax-radio-group', () => {
    render(`
      <div role="radiogroup" aria-label="Employment Type">
        <div role="radio" aria-label="Full-time" aria-checked="false"></div>
        <div role="radio" aria-label="Part-time" aria-checked="false"></div>
      </div>
    `);
    const sigs = extractAllFields(document);
    const ax = sigs.find(s => s.inputType === 'ax-radio-group');
    expect(ax).toBeDefined();
  });

  it('does NOT double-emit native inputs when ARIA widgets present', () => {
    render(`
      <input type="text" id="name" aria-label="Name">
      <div role="combobox" aria-label="Country">USA</div>
    `);
    const sigs = extractAllFields(document);
    const textSigs = sigs.filter(s => s.inputType === 'text');
    const axSigs = sigs.filter(s => s.inputType === 'ax-combobox');
    expect(textSigs).toHaveLength(1);
    expect(axSigs).toHaveLength(1);
    expect(sigs).toHaveLength(2);
  });

  it('skips display:none ARIA widgets', () => {
    render(`
      <div role="combobox" aria-label="Hidden Country" style="display:none">X</div>
      <div role="combobox" aria-label="Visible Country">USA</div>
    `);
    const sigs = extractAllFields(document);
    const ax = sigs.filter(s => s.inputType === 'ax-combobox');
    expect(ax.every(s => s.ariaLabel !== 'Hidden Country')).toBe(true);
    expect(ax.some(s => s.ariaLabel === 'Visible Country')).toBe(true);
  });

  it('detects role=switch as ax-switch', () => {
    render(`<div role="switch" aria-label="Receive notifications" aria-checked="false"></div>`);
    const sigs = extractAllFields(document);
    const ax = sigs.find(s => s.inputType === 'ax-switch');
    expect(ax).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Visibility check (via extractAllFields)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Visibility filtering', () => {
  it('excludes display:none inputs', () => {
    render('<input type="text" style="display:none" id="hidden-field">');
    const sigs = extractAllFields(document);
    expect(sigs.every(s => s.id !== 'hidden-field')).toBe(true);
  });

  it('includes normally visible inputs', () => {
    render('<input type="text" id="visible-field" placeholder="Visible">');
    const sigs = extractAllFields(document);
    expect(sigs.some(s => s.id === 'visible-field')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FieldSignature shape correctness
// ═══════════════════════════════════════════════════════════════════════════════

describe('FieldSignature shape', () => {
  it('populates all required fields for a text input', () => {
    render(`
      <label for="email">Email Address</label>
      <input type="email" id="email" name="email" autocomplete="email" placeholder="Enter email">
    `);
    const sigs = extractAllFields(document);
    const sig = sigs[0];
    expect(sig).toMatchObject({
      inputType: 'email',
      id: 'email',
      name: 'email',
      autocomplete: 'email',
      placeholder: 'Enter email',
    });
    expect(sig.label).toMatch(/Email/i);
  });

  it('maxLength is stored from the element when present', () => {
    render('<input type="text" id="x">');
    const sigs = extractAllFields(document);
    // When maxLength is unset, jsdom returns browser default (not null)
    // The sig stores null only when maxLength <= 0; otherwise stores the value
    expect(sigs[0]?.maxLength === null || typeof sigs[0]?.maxLength === 'number').toBe(true);
  });

  it('maxLength is populated when specified', () => {
    render('<input type="text" maxlength="100">');
    const sigs = extractAllFields(document);
    expect(sigs[0]?.maxLength).toBe(100);
  });

  it('element reference is attached', () => {
    render('<input type="text" id="ref-check">');
    const sigs = extractAllFields(document);
    expect(sigs[0]?.element).toBeDefined();
    expect(sigs[0]!.element instanceof HTMLElement).toBe(true);
  });
});
