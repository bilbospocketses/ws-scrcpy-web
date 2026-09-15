export interface TabDef {
    id: string;
    label: string;
    build(): HTMLElement;
}

/**
 * The Settings tab strip and its panel.
 *
 * Every tab body is built ONCE, eagerly, in the constructor -- not lazily on
 * first activation. `activate()` never calls `build()`; it only toggles which
 * body is visible. Two reasons this matters, both found the hard way by
 * running the existing suite rather than assuming the lazy design was safe:
 *
 * 1. `SettingsModal.test.ts` has pre-tabs regression tests that query
 *    `document.body` for ALL sections' headings/rows after a single
 *    microtask flush, with no `activate()` call in sight. A lazy build only
 *    ever attaches the ACTIVE tab's body to the DOM, so those tests would
 *    find one section instead of five. Building everything up front keeps
 *    every section actually present in the DOM (as it always was), with
 *    inactive ones hidden via the `hidden` attribute rather than never
 *    attached -- so those tests keep asserting what they always asserted.
 * 2. `SettingsModal`'s constructor fires `refreshServer()` / `refreshService()`
 *    / `refreshUpdates()` unconditionally once, regardless of which tab is
 *    active, and `refreshService()` writes into `this.serviceSection`
 *    unconditionally. Under a lazy build that field is `undefined` until its
 *    tab is clicked, which throws. Eager build means every section (and every
 *    field a refresh method writes into) exists before any refresh call can
 *    run, matching the pre-tabs behaviour exactly.
 *
 * Building once (whether eager or lazy) is still what preserves in-progress
 * edits across tab switches without the store having to re-hydrate the DOM --
 * `activate()` only ever shows/hides, never rebuilds. Switching tabs never
 * prompts either: prompting between tabs of a single dialog is hostile and
 * trains people to click through.
 *
 * Building is synchronous by design -- `SettingsModal.fillBody` must render
 * without awaiting the /api/config probe, or a hung probe leaves a permanently
 * empty dialog (a test pins this). Eager-but-synchronous keeps that guarantee:
 * `new TabStrip(tabs)` never awaits anything, so it still cannot block on the
 * probe -- it just does more synchronous work up front than a lazy build would.
 */
export class TabStrip {
    private readonly strip: HTMLElement;
    private readonly panel: HTMLElement;
    private readonly built = new Map<string, HTMLElement>();
    private readonly buttons = new Map<string, HTMLButtonElement>();
    private active = '';

    constructor(private readonly tabs: TabDef[]) {
        this.strip = document.createElement('div');
        this.strip.className = 'settings-tabs';
        this.strip.setAttribute('role', 'tablist');
        this.panel = document.createElement('div');
        this.panel.className = 'settings-tab-panel';

        for (const tab of tabs) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'settings-tab';
            btn.textContent = tab.label;
            btn.setAttribute('role', 'tab');
            btn.addEventListener('click', () => this.activate(tab.id));
            this.buttons.set(tab.id, btn);
            this.strip.appendChild(btn);

            // Eager build (see class doc): every body is attached to the panel
            // now, hidden until its tab is active. `built` still exists so
            // `activate()` has an O(1) lookup instead of re-finding tabs' DOM.
            const body = tab.build();
            body.hidden = true;
            this.built.set(tab.id, body);
            this.panel.appendChild(body);
        }

        if (tabs.length > 0) this.activate(tabs[0]!.id);
    }

    getElement(): HTMLElement {
        return this.strip;
    }

    getPanel(): HTMLElement {
        return this.panel;
    }

    activeId(): string {
        return this.active;
    }

    activate(id: string): void {
        const tab = this.tabs.find((t) => t.id === id);
        if (!tab) return;
        this.active = id;
        for (const [tabId, body] of this.built) {
            body.hidden = tabId !== id;
        }
        for (const [tabId, btn] of this.buttons) {
            btn.setAttribute('aria-selected', tabId === id ? 'true' : 'false');
            btn.classList.toggle('settings-tab--active', tabId === id);
        }
    }

    /**
     * Swap a tab's body, preserving its visibility state and the cache.
     *
     * `applyDockerGating()` replaces whole sections after the /api/config probe
     * resolves, well after the first tab has already been shown. Replacing the
     * DOM node directly (bypassing TabStrip) left the replacement visible no
     * matter which tab was active -- a fresh node carries no `hidden` attribute
     * -- and orphaned the cached original, so that tab's button went dead: it
     * kept toggling `hidden` on a node no longer attached to the panel.
     *
     * A no-op if `id` was never built (e.g. a tab role-gated out of existence
     * entirely) -- same defensive shape as `activate()`.
     */
    replaceTabBody(id: string, body: HTMLElement): void {
        const old = this.built.get(id);
        if (!old) return;
        body.hidden = id !== this.active;
        old.replaceWith(body);
        this.built.set(id, body);
    }
}
