// @vitest-environment jsdom

/**
 * SP4 E4 — the Settings gating for container mode.
 *
 * Each assertion runs in BOTH states. The second half is the one that matters:
 * a gate that hides a section unconditionally passes every "it is absent in
 * Docker" check and is still completely broken on the desktop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authClient } from '../AuthClient';
import {
    buildDockerDependenciesNote,
    buildDockerServiceNote,
    buildDockerUpdatesNote,
    SettingsModal,
} from '../SettingsModal';

// The locked copy. Service is verbatim from SP4 design §8 / todo_ws_scrcpy_web
// item 2 decision 4; Updates and Dependencies are item 135's (2026-09-15).
// Written out here rather than imported so a silent reword of the source string
// fails this test instead of travelling with it.
const SERVICE_COPY = 'service install not applicable — this instance runs in a container.';
const UPDATES_COPY = 'app updates not applicable — this instance runs in a container; pull a newer image to update.';
const DEPENDENCIES_COPY =
    'dependency updates not applicable — this instance runs in a container; pull a newer image to update.';

// Item 135: the Updates note must survive the 1.0 release without a second copy
// change, which it can only do by naming no tag. `:latest` 404s for the whole
// pre-1.0 window (docker-publish.yml refuses to move it onto a beta) and starts
// resolving at the first stable release — so ANY tag in this string is wrong in
// one era or the other. This is the assertion that fails if one creeps back in.
const TAGLESS = [UPDATES_COPY, DEPENDENCIES_COPY];

describe('container replacements for Service, Updates and Dependencies', () => {
    beforeEach(() => {
        document.body.replaceChildren();
    });

    it('renders the Service note with the locked copy, in the shared note style', () => {
        const el = buildDockerServiceNote();
        document.body.appendChild(el);

        expect(el.dataset['dockerNote']).toBe('service');
        expect(el.querySelector('.settings-section-heading')?.textContent).toBe('Service');

        const note = el.querySelector('.settings-status');
        expect(note).not.toBeNull();
        expect(note?.textContent).toBe(SERVICE_COPY);
    });

    it('renders the Updates note with the locked copy, in the shared note style', () => {
        const el = buildDockerUpdatesNote();
        document.body.appendChild(el);

        expect(el.dataset['dockerNote']).toBe('updates');
        expect(el.querySelector('.settings-section-heading')?.textContent).toBe('Updates');

        const note = el.querySelector('.settings-status');
        expect(note).not.toBeNull();
        expect(note?.textContent).toBe(UPDATES_COPY);
    });

    it('renders the Dependencies note with the locked copy, in the shared note style', () => {
        const el = buildDockerDependenciesNote();
        document.body.appendChild(el);

        expect(el.dataset['dockerNote']).toBe('dependencies');
        expect(el.querySelector('.settings-section-heading')?.textContent).toBe('Dependencies');

        const note = el.querySelector('.settings-status');
        expect(note).not.toBeNull();
        expect(note?.textContent).toBe(DEPENDENCIES_COPY);
    });

    it('answers to the data-settings-tab hook, which is the ONLY way anything finds this tab', () => {
        // The gap CI caught, and the reason it got past 2,258 green unit tests:
        // the unit suite asserted the note RENDERS and the e2e asserted it is
        // FINDABLE, and nothing asserted the attribute that joins them.
        //
        // Dependencies is the one tab with no `<h3>` of its own — it wraps
        // DependencyPanel, which brings its own `<h2>` — so `settingsSection()`
        // in tests/e2e/support/auth.ts special-cases it to
        // `section[data-settings-tab="dependencies"]`. Without this attribute
        // `openSettingsTab(settings, 'Dependencies')` cannot resolve the note at
        // all, and the container tier fails with `element(s) not found`.
        const el = buildDockerDependenciesNote();
        expect(el.dataset['settingsTab']).toBe('dependencies');
        // Both hooks on ONE element: the e2e finds the tab by the first and
        // identifies it as the note by the second.
        expect(el.dataset['dockerNote']).toBe('dependencies');
        expect(el.matches('section[data-settings-tab="dependencies"]')).toBe(true);
    });

    it('does not put that hook on the Service or Updates notes', () => {
        // The other half, and the reason this is not "every note gets every
        // hook": neither real body carries `data-settings-tab` either
        // (DependenciesTab.ts is the only place in src/ that sets it), and both
        // are found by their headings. A note answers to the hooks ITS real body
        // answers to — no more.
        expect(buildDockerServiceNote().dataset['settingsTab']).toBeUndefined();
        expect(buildDockerUpdatesNote().dataset['settingsTab']).toBeUndefined();
        // ...and they are still findable the way the e2e actually finds them.
        expect(buildDockerServiceNote().querySelector('h3.settings-section-heading')?.textContent).toBe('Service');
        expect(buildDockerUpdatesNote().querySelector('h3.settings-section-heading')?.textContent).toBe('Updates');
    });

    it('names no image tag, so the copy stays true across the 1.0 boundary', () => {
        // The item-135 bug in one line. `:latest` 404s today and resolves after
        // the first stable release; `:beta` is the reverse. A note that names
        // either is wrong in one of the two eras, and the era it is wrong in is
        // the one nobody re-reads the copy for.
        const rendered = [
            buildDockerUpdatesNote().querySelector('.settings-status')?.textContent ?? '',
            buildDockerDependenciesNote().querySelector('.settings-status')?.textContent ?? '',
        ];
        expect(rendered).toEqual(TAGLESS);
        for (const text of rendered) {
            expect(text).not.toContain(':latest');
            expect(text).not.toContain(':beta');
            expect(text).not.toContain('ws-scrcpy-web:');
            // And it still tells the user what to actually DO.
            expect(text).toContain('pull a newer image');
        }
    });

    it('carries none of the interactive affordances the real sections have', () => {
        // The point of replacing rather than hiding: nothing here can be clicked,
        // so nothing triggers refreshService()/refreshUpdates()/the dependency
        // panel and no "couldn't reach server" error can render under the copy.
        // Dependencies is the sharpest case: the real panel it replaces carries a
        // "check for updates" button and a per-dependency update button apiece.
        for (const el of [buildDockerServiceNote(), buildDockerUpdatesNote(), buildDockerDependenciesNote()]) {
            expect(el.querySelectorAll('button').length).toBe(0);
            expect(el.querySelectorAll('input').length).toBe(0);
            expect(el.querySelectorAll('select').length).toBe(0);
        }
    });

    it('uses the settings-status class, which is what supplies the indent and bold-italic', () => {
        // modal.css gives .settings-status padding-left 1.25rem / italic / 600.
        // Asserting the class rather than computed style keeps this a contract
        // about the convention (730e521) rather than about jsdom's CSS support.
        for (const el of [buildDockerServiceNote(), buildDockerUpdatesNote(), buildDockerDependenciesNote()]) {
            const note = el.querySelector('p');
            expect(note?.className).toContain('settings-status');
        }
    });

    it('produces three DISTINCT sections, so one gate cannot stand in for another', () => {
        // Updates and Dependencies are the pair at risk: both now end in the same
        // clause, and a copy-paste that gave them the same first clause too would
        // make either note able to satisfy the other's assertion.
        const notes = [buildDockerServiceNote(), buildDockerUpdatesNote(), buildDockerDependenciesNote()];
        const kinds = notes.map((el) => el.dataset['dockerNote']);
        const texts = notes.map((el) => el.querySelector('.settings-status')?.textContent);
        expect(new Set(kinds).size).toBe(3);
        expect(new Set(texts).size).toBe(3);
    });
});

/**
 * The gating as the modal actually applies it. The builder tests above prove the
 * copy; these prove the SWAP — and, more importantly, that it happens only in a
 * container and that a container issues no inapplicable request.
 */
describe('SettingsModal applies the gating only in a container', () => {
    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

    function stubMeAsAdmin(): void {
        vi.spyOn(authClient, 'me').mockResolvedValue({
            authEnabled: false,
            user: { username: 'admin', role: 'admin' },
        });
    }

    /** A fetch that answers /api/config with the given runtime, and stalls the rest. */
    function stubConfigFetch(runtime: Record<string, unknown>): ReturnType<typeof vi.fn> {
        const f = vi.fn((url: string) => {
            if (typeof url === 'string' && url.startsWith('/api/config')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ config: { webPort: 8000 }, runtime }),
                });
            }
            return new Promise(() => undefined); // never settles — nothing should need it
        });
        vi.stubGlobal('fetch', f);
        return f as unknown as ReturnType<typeof vi.fn>;
    }

    beforeEach(() => {
        document.body.replaceChildren();
        HTMLDialogElement.prototype.showModal = vi.fn();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('swaps all three sections for the notes when runtime.docker is true', async () => {
        stubMeAsAdmin();
        const f = stubConfigFetch({ firstRunComplete: true, portWasAutoShifted: false, webPort: 8000, docker: true });
        new SettingsModal();
        await flush();

        expect(document.querySelector('[data-docker-note="service"]')).not.toBeNull();
        expect(document.querySelector('[data-docker-note="updates"]')).not.toBeNull();
        expect(document.querySelector('[data-docker-note="dependencies"]')).not.toBeNull();
        // The real Dependencies body is GONE, not merely covered. This can no
        // longer be "the hook is absent" — the note deliberately carries the same
        // `data-settings-tab` hook, because in a container the note IS the tab
        // body and nothing could find it otherwise. So the assertion is that
        // exactly ONE element answers to the hook and that it is the NOTE: a
        // surviving real panel would make the count 2, and a swap that never
        // happened would leave the one match carrying no `data-docker-note`.
        const byHook = document.querySelectorAll('[data-settings-tab="dependencies"]');
        expect(byHook.length).toBe(1);
        expect((byHook[0] as HTMLElement).dataset['dockerNote']).toBe('dependencies');

        // And the inapplicable endpoints were never asked. This is the whole
        // reason the refreshes are held until docker mode is known: firing them
        // would draw "couldn't reach server" underneath the copy.
        const urls = f.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.startsWith('/api/service/status'))).toBe(false);
        expect(urls.some((u) => u.startsWith('/api/updates/status'))).toBe(false);
        // /api/dependencies is the one that matters most, and not because of the
        // error message. `refreshDependencies` mounts a DependencyPanel that
        // polls every 15 s, and `replaceTabBody` detaches the panel's ELEMENT
        // without stopping its interval -- so a single request here would mean a
        // poll running for the life of the page with no reference left to stop
        // it. This asserts the panel was never started at all, which is only
        // true while `applyDockerGating()` runs BEFORE the refresh (SettingsModal
        // constructor). Swap those two statements and this is the assertion that
        // catches it.
        expect(urls.some((u) => u.startsWith('/api/dependencies'))).toBe(false);
    });

    it('the note stays hidden behind whatever tab is active, and clicking through reveals it', async () => {
        // The bug this pins: applyDockerGating() runs well after first paint,
        // while Users (the first/default tab) is still active -- not
        // Updates/Service. Asserting presence alone (the test above) cannot
        // catch a note that swapped in VISIBLE regardless of the active tab,
        // nor a tab button left permanently dead because TabStrip's cache still
        // pointed at the replaced original.
        stubMeAsAdmin();
        stubConfigFetch({ firstRunComplete: true, portWasAutoShifted: false, webPort: 8000, docker: true });
        new SettingsModal();
        await flush();

        const serviceNote = document.querySelector<HTMLElement>('[data-docker-note="service"]');
        const updatesNote = document.querySelector<HTMLElement>('[data-docker-note="updates"]');
        expect(serviceNote, 'service note missing').not.toBeNull();
        expect(updatesNote, 'updates note missing').not.toBeNull();
        // Users is the default active tab, so both notes must be hidden, not
        // rendered visible beside it.
        expect(serviceNote?.hidden).toBe(true);
        expect(updatesNote?.hidden).toBe(true);

        const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('.settings-tab')];
        const updatesTabBtn = tabButtons.find((b) => b.textContent === 'Updates');
        const serviceTabBtn = tabButtons.find((b) => b.textContent === 'Service');
        expect(updatesTabBtn, 'Updates tab button missing').toBeTruthy();
        expect(serviceTabBtn, 'Service tab button missing').toBeTruthy();

        // Clicking through to Updates reveals ONLY the Updates note -- proving
        // TabStrip's cache was updated to the replacement node, not left
        // pointing at the detached original.
        updatesTabBtn?.click();
        expect(updatesNote?.hidden).toBe(false);
        expect(serviceNote?.hidden).toBe(true);

        // And Service, symmetrically.
        serviceTabBtn?.click();
        expect(serviceNote?.hidden).toBe(false);
        expect(updatesNote?.hidden).toBe(true);

        // Dependencies is the third swap (item 135) and gets the same treatment:
        // its note must be hidden behind the active tab and revealed by its own
        // button, which only holds if the swap went through TabStrip.
        const depsNote = document.querySelector<HTMLElement>('[data-docker-note="dependencies"]');
        expect(depsNote, 'dependencies note missing').not.toBeNull();
        expect(depsNote?.hidden).toBe(true);
        const depsTabBtn = tabButtons.find((b) => b.textContent === 'Dependencies');
        expect(depsTabBtn, 'Dependencies tab button missing').toBeTruthy();
        depsTabBtn?.click();
        expect(depsNote?.hidden).toBe(false);
        expect(serviceNote?.hidden).toBe(true);
    });

    it('leaves the real sections alone when runtime.docker is absent', async () => {
        // The half that matters: a gate that fires unconditionally passes the
        // test above and is completely broken on the desktop.
        stubMeAsAdmin();
        const f = stubConfigFetch({ firstRunComplete: true, portWasAutoShifted: false, webPort: 8000 });
        new SettingsModal();
        await flush();

        expect(document.querySelector('[data-docker-note="service"]')).toBeNull();
        expect(document.querySelector('[data-docker-note="updates"]')).toBeNull();
        expect(document.querySelector('[data-docker-note="dependencies"]')).toBeNull();

        const headings = Array.from(document.querySelectorAll<HTMLElement>('.settings-section-heading')).map(
            (el) => el.textContent ?? '',
        );
        expect(headings).toContain('Service');
        expect(headings).toContain('Updates');
        // Dependencies deliberately carries no section heading of its own (the
        // panel brings one), so it is checked by its own hook instead.
        expect(document.querySelector('[data-settings-tab="dependencies"]')).not.toBeNull();

        // And on the desktop those endpoints ARE asked. The dependency one is
        // the half of item 135 that keeps the gate honest: a container check
        // that fired unconditionally would leave a host admin with a tab that
        // says "not applicable" and a home page that never mentions an update.
        const urls = f.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.startsWith('/api/service/status'))).toBe(true);
        expect(urls.some((u) => u.startsWith('/api/updates/status'))).toBe(true);
        expect(urls.some((u) => u.startsWith('/api/dependencies'))).toBe(true);
    });

    it('still renders the body when /api/config never answers', async () => {
        // The guarantee the modal's own suite already pins, restated here because
        // this feature is what would have broken it: blocking the render on the
        // docker probe leaves a permanently EMPTY Settings dialog.
        stubMeAsAdmin();
        vi.stubGlobal(
            'fetch',
            vi.fn(() => new Promise(() => undefined)),
        );
        new SettingsModal();
        await flush();

        const headings = Array.from(document.querySelectorAll<HTMLElement>('.settings-section-heading')).map(
            (el) => el.textContent ?? '',
        );
        expect(headings.length).toBeGreaterThan(0);
        expect(headings).toContain('Server');
    });
});
