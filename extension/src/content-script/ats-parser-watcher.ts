/**
 * Phase AI.2 — Native ATS resume-parser burst detection.
 *
 * Many ATSes (Greenhouse, Workday, Lever, Ashby) parse an uploaded resume
 * and auto-fill form fields via their own React/Angular state. These fills
 * arrive as a burst of `input`/`change` events within a few seconds.
 *
 * Detection: if ≥3 distinct fields fire input/change events within
 * BURST_WINDOW_MS of arming → ATS parser is running. We wait for 1.5s of
 * silence after the last event before proceeding with our own fill pass.
 *
 * MutationObserver is NOT used here: it does not fire on `.value` property
 * changes, only on DOM attribute/structure changes. Event listeners are the
 * only reliable signal for value updates driven by ATS state machines.
 *
 * The watcher is scoped to the document (or any Element) so it works in
 * both the top frame and embedded iframes that run their own content script.
 */

const BURST_THRESHOLD   = 3;     // ≥N distinct fields = ATS parser detected
const BURST_WINDOW_MS   = 5000;  // observation window after arm()
const SETTLE_SILENCE_MS = 1500;  // silence after last event = settled
const MAX_WAIT_MS       = 8000;  // hard ceiling — never block indefinitely

export interface AtsParserWatcher {
  /** Start listening for field-change bursts across the scoped document. */
  arm(): void;
  /**
   * Returns a Promise that resolves when:
   *   - No burst was detected within BURST_WINDOW_MS (fast path)
   *   - A burst WAS detected AND SETTLE_SILENCE_MS of silence elapsed
   *   - MAX_WAIT_MS has elapsed regardless of activity
   */
  waitForSettle(): Promise<void>;
  /** Remove all event listeners added by arm(). Call after waitForSettle(). */
  disarm(): void;
  /** True if a burst of ≥BURST_THRESHOLD distinct fields was observed. */
  readonly burstDetected: boolean;
}

export function createAtsParserWatcher(scope: Document | HTMLElement): AtsParserWatcher {
  const affectedEls = new Set<EventTarget>();
  let burstDetected = false;
  let armed = false;
  let resolveSettle: (() => void) | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let fastPathTimer: ReturnType<typeof setTimeout> | undefined;

  type StoredListener = [EventTarget, string, EventListener, AddEventListenerOptions];
  const listeners: StoredListener[] = [];

  function onFieldEvent(e: Event): void {
    if (!armed) return;
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    // Ignore events we dispatched ourselves (dittoFilled marks our writes)
    if (target.dataset.dittoFilled === 'true') return;

    // Only watch genuine form field elements
    const role = target.getAttribute('role') ?? '';
    const isFormField =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      /^(combobox|listbox|option|textbox|searchbox)$/.test(role);
    if (!isFormField) return;

    affectedEls.add(target);

    if (affectedEls.size >= BURST_THRESHOLD) {
      if (!burstDetected) {
        burstDetected = true;
        // Cancel fast-path no-burst timer — we have a burst now
        clearTimeout(fastPathTimer);
      }
      // Reset the settle timer on each new event (debounce)
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        resolveSettle?.();
      }, SETTLE_SILENCE_MS);
    }
  }

  return {
    get burstDetected() { return burstDetected; },

    arm() {
      if (armed) return;
      armed = true;
      affectedEls.clear();
      burstDetected = false;

      const handler = onFieldEvent as EventListener;
      const opts: AddEventListenerOptions = { capture: true, passive: true };

      scope.addEventListener('input',  handler, opts);
      scope.addEventListener('change', handler, opts);
      listeners.push(
        [scope, 'input',  handler, opts],
        [scope, 'change', handler, opts],
      );
    },

    async waitForSettle(): Promise<void> {
      return new Promise<void>((resolve) => {
        resolveSettle = resolve;

        // Hard ceiling — never block indefinitely
        maxTimer = setTimeout(resolve, MAX_WAIT_MS);

        // Fast path: if no burst detected within BURST_WINDOW_MS, resolve immediately.
        // This covers forms without a native ATS parser (no-op path).
        fastPathTimer = setTimeout(() => {
          if (!burstDetected) resolve();
        }, BURST_WINDOW_MS);
      }).finally(() => {
        clearTimeout(settleTimer);
        clearTimeout(maxTimer);
        clearTimeout(fastPathTimer);
      });
    },

    disarm() {
      armed = false;
      for (const [target, type, fn, opts] of listeners) {
        target.removeEventListener(type, fn, opts);
      }
      listeners.length = 0;
      clearTimeout(settleTimer);
      clearTimeout(maxTimer);
      clearTimeout(fastPathTimer);
    },
  };
}
