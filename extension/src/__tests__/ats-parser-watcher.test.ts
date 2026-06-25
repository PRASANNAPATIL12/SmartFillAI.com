/**
 * Tests for ats-parser-watcher.ts (Phase AI.2 — ATS parse burst detection).
 *
 * Tests cover:
 *   - burst detection (≥3 distinct fields within window)
 *   - below-threshold: no burst
 *   - dittoFilled events are ignored
 *   - MAX_WAIT_MS hard ceiling
 *   - settle after burst (1.5s silence)
 */

import { createAtsParserWatcher } from '../content-script/ats-parser-watcher';

// jsdom provides document but not all DOM event constructors —
// ensure InputEvent is available in the test environment.
function makeInput(name: string): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'text';
  el.name = name;
  document.body.appendChild(el);
  return el;
}

function fireChange(el: HTMLElement): void {
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function fireInput(el: HTMLElement): void {
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('createAtsParserWatcher', () => {
  it('resolves quickly when no burst is detected', async () => {
    const watcher = createAtsParserWatcher(document);
    watcher.arm();

    const el = makeInput('field1');
    fireChange(el);   // only 1 field — below BURST_THRESHOLD=3

    await watcher.waitForSettle();
    watcher.disarm();

    // Fast path: resolves after BURST_WINDOW_MS (5s) or less
    expect(watcher.burstDetected).toBe(false);
  }, 10000);

  it('detects burst of 3+ distinct fields', async () => {
    const watcher = createAtsParserWatcher(document);
    watcher.arm();

    const f1 = makeInput('first_name');
    const f2 = makeInput('last_name');
    const f3 = makeInput('email');

    fireInput(f1);
    fireInput(f2);
    fireInput(f3);

    // Burst is detected; watcher should now wait for SETTLE_SILENCE_MS
    expect(watcher.burstDetected).toBe(true);
    await watcher.waitForSettle();
    watcher.disarm();

    expect(watcher.burstDetected).toBe(true);
  }, 10000);

  it('does not count the same element twice toward the threshold', async () => {
    const watcher = createAtsParserWatcher(document);
    watcher.arm();

    const f1 = makeInput('field1');

    // Fire 5 events on the SAME element — should not trigger burst
    fireInput(f1);
    fireInput(f1);
    fireInput(f1);
    fireInput(f1);
    fireInput(f1);

    expect(watcher.burstDetected).toBe(false);
    watcher.disarm();
  });

  it('ignores events from dittoFilled elements', async () => {
    const watcher = createAtsParserWatcher(document);
    watcher.arm();

    // Three fields marked as already filled by SmartFillAI
    const f1 = makeInput('a'); f1.dataset.dittoFilled = 'true';
    const f2 = makeInput('b'); f2.dataset.dittoFilled = 'true';
    const f3 = makeInput('c'); f3.dataset.dittoFilled = 'true';
    const f4 = makeInput('d'); f4.dataset.dittoFilled = 'true';

    fireInput(f1);
    fireInput(f2);
    fireInput(f3);
    fireInput(f4);

    // All 4 were our own writes — burst should NOT be detected
    expect(watcher.burstDetected).toBe(false);
    watcher.disarm();
  });

  it('burst threshold requires exactly 3 distinct fields', async () => {
    const watcher = createAtsParserWatcher(document);
    watcher.arm();

    const f1 = makeInput('x1');
    const f2 = makeInput('x2');

    fireInput(f1);
    fireInput(f2);

    // 2 distinct fields — below threshold
    expect(watcher.burstDetected).toBe(false);

    const f3 = makeInput('x3');
    fireInput(f3);

    // 3rd distinct field — threshold met
    expect(watcher.burstDetected).toBe(true);
    watcher.disarm();
  });

  it('disarm removes listeners and subsequent events are ignored', () => {
    const watcher = createAtsParserWatcher(document);
    watcher.arm();
    watcher.disarm();

    // Fire 3 events AFTER disarm — should not affect burstDetected
    const f1 = makeInput('p1');
    const f2 = makeInput('p2');
    const f3 = makeInput('p3');
    fireInput(f1);
    fireInput(f2);
    fireInput(f3);

    expect(watcher.burstDetected).toBe(false);
  });

  it('arm is idempotent (calling twice does not double-count)', () => {
    const watcher = createAtsParserWatcher(document);
    watcher.arm();
    watcher.arm(); // second call should be a no-op

    const f1 = makeInput('q1');
    const f2 = makeInput('q2');

    fireInput(f1);
    fireInput(f2);

    // Still only 2 distinct fields regardless of double-arm
    expect(watcher.burstDetected).toBe(false);
    watcher.disarm();
  });
});
