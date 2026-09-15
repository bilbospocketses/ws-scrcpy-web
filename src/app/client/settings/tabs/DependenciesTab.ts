import { DependencyPanel } from '../../DependencyPanel';
import type { StagedSettingsStore } from '../StagedSettingsStore';
import type { TabContext } from './EmbeddingTab';

/**
 * Per-instance re-entry points, keyed by the section `buildDependenciesTab`
 * returned. Same shape — and the same reason — as UpdatesTab.ts's `refreshers`:
 * `SettingsModal` builds every tab eagerly, then decides LATER whether to let
 * this one talk to the server at all (held until the /api/config probe says
 * whether the admin API will answer this caller). These maps are what let it
 * drive a specific tab's internals from outside without `buildDependenciesTab`
 * returning anything other than the `HTMLElement` its signature promises.
 */
const refreshers = new WeakMap<HTMLElement, () => Promise<void>>();
const panels = new WeakMap<HTMLElement, DependencyPanel>();
/**
 * Tabs whose dialog has already closed. Checked on both sides of the panel's
 * first read, because `DependencyPanel.create()` starts the poll interval only
 * after that read resolves — a dialog dismissed while it is in flight would
 * otherwise acquire a 15 s interval with nothing left to stop it.
 */
const torndown = new WeakSet<HTMLElement>();
/**
 * Tabs whose panel is being created right now. `panels` is only set once
 * `DependencyPanel.create()` resolves, so two calls arriving before that both
 * get past a `panels`-only guard, build two panels, and leave the first one's
 * 15 s interval running with nothing holding a reference to stop it — the very
 * §36 leak this tab's teardown exists to prevent. Set synchronously, before the
 * first await, which is what makes it a guard at all. Never cleared:
 * `DependencyPanel.create()` cannot reject (its `load()` swallows its own
 * errors), so there is no failure path to reopen it for, and the only other
 * exit is teardown, which is terminal.
 */
const starting = new WeakSet<HTMLElement>();

/**
 * The Dependencies tab (admin-only) — the home page's dependency panel, moved
 * here whole.
 *
 * Wraps `DependencyPanel` unchanged: this tab owns where the panel lives and
 * when it starts, not what it renders. The panel brings its own `<h2>` header
 * and "check for updates" button, so the shell deliberately adds no section
 * heading of its own — a second "Dependencies" title directly above the
 * panel's own would say nothing the tab's label has not already said twice.
 *
 * Registers nothing with `store`: checking for and installing a dependency
 * update is an action that happens on click, not a value that can be staged
 * and saved later — the same reason Users, Embedding and Service register
 * nothing.
 *
 * Builds synchronously and fires no network request of its own. `TabStrip`
 * builds every tab body eagerly in its constructor, before `SettingsModal`'s
 * runtime probe has resolved, and GET /api/dependencies is admin-gated at the
 * top of its handler — a read fired at build time would 403-spam exactly the
 * caller item 81 exists to spare. `refreshDependencies()` below is what starts
 * the panel, once the modal knows the admin API will answer.
 */
export function buildDependenciesTab(_ctx: TabContext, _store: StagedSettingsStore): HTMLElement {
    const section = document.createElement('section');
    section.className = 'settings-section';
    // Stable hook for the tests that assert which tab body is showing, in the
    // spirit of `buildDockerNoteSection`'s `data-docker-note`.
    section.dataset['settingsTab'] = 'dependencies';

    const body = document.createElement('div');
    body.className = 'settings-section-body';
    const placeholder = document.createElement('p');
    placeholder.className = 'settings-status';
    placeholder.style.gridColumn = '1 / -1';
    placeholder.textContent = 'loading dependencies…';
    body.appendChild(placeholder);
    section.appendChild(body);

    async function runRefresh(): Promise<void> {
        if (torndown.has(section) || panels.has(section) || starting.has(section)) return;
        starting.add(section);
        const panel = await DependencyPanel.create();
        if (torndown.has(section)) {
            // Closed while the first read was in flight. `create()` has already
            // started the interval by the time it resolves, so stop it here —
            // `destroyDependenciesTab` had no panel to stop when it ran.
            panel.destroy();
            return;
        }
        panels.set(section, panel);
        const el = panel.getElement();
        // `.settings-section-body` is a two-column grid whose labels track is a
        // FIXED 20rem (modal.css). A child that does not span both columns lands
        // in that track, so a five-column dependency table renders ~280px wide
        // with every description wrapped a word per line. Same idiom the
        // placeholder above already uses. Measured, not guessed: without this the
        // panel's right edge misses its parent's by 512px in Chromium.
        el.style.gridColumn = '1 / -1';
        // The panel keeps `class="home-section"` because `home.css` also styles
        // `.home-section h2`, which is the panel's OWN heading — dropping the
        // class would leave that <h2> at the UA default size inside the dialog.
        // Nothing in dependencies.css keys off the class, so only the three box
        // properties meant for a home-page section are neutralised here: they
        // are a page-level card's frame, and the dialog draws its own.
        el.style.padding = '0';
        el.style.border = 'none';
        el.style.marginBottom = '0';
        body.replaceChildren(el);
    }

    refreshers.set(section, runRefresh);
    return section;
}

/**
 * Externally start the Dependencies tab `buildDependenciesTab` already built:
 * mounts the panel, which performs its first read and then polls. A no-op if
 * `section` was never built through `buildDependenciesTab`, or if its panel is
 * already mounted.
 */
export async function refreshDependencies(section: HTMLElement): Promise<void> {
    const run = refreshers.get(section);
    if (!run) return;
    await run();
}

/**
 * Stop the tab's polling. The panel polls every 15 s for as long as it lives,
 * and the dialog is opened and dismissed repeatedly — without this, every open
 * would leave another interval reading /api/dependencies forever (§36). Called
 * from `SettingsModal.onBeforeClose()`. Idempotent, and safe for a section that
 * never had a panel.
 */
export function destroyDependenciesTab(section: HTMLElement): void {
    torndown.add(section);
    panels.get(section)?.destroy();
}
