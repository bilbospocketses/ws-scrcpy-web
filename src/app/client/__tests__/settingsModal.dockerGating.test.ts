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
import { buildDockerServiceNote, buildDockerUpdatesNote, SettingsModal } from '../SettingsModal';

// The locked copy, verbatim from SP4 design §8 / todo_ws_scrcpy_web item 2
// decision 4. Written out here rather than imported so a silent reword of the
// source string fails this test instead of travelling with it.
const SERVICE_COPY = 'service install not applicable — this instance runs in a container.';
const UPDATES_COPY = 'update via `docker pull jchapz30/ws-scrcpy-web:latest`.';

describe('container replacements for Service and Updates', () => {
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

    it('carries none of the interactive affordances the real sections have', () => {
        // The point of replacing rather than hiding: nothing here can be clicked,
        // so nothing triggers refreshService()/refreshUpdates() and no
        // "couldn't reach server" error can render under the copy.
        for (const el of [buildDockerServiceNote(), buildDockerUpdatesNote()]) {
            expect(el.querySelectorAll('button').length).toBe(0);
            expect(el.querySelectorAll('input').length).toBe(0);
            expect(el.querySelectorAll('select').length).toBe(0);
        }
    });

    it('uses the settings-status class, which is what supplies the indent and bold-italic', () => {
        // modal.css gives .settings-status padding-left 1.25rem / italic / 600.
        // Asserting the class rather than computed style keeps this a contract
        // about the convention (730e521) rather than about jsdom's CSS support.
        for (const el of [buildDockerServiceNote(), buildDockerUpdatesNote()]) {
            const note = el.querySelector('p');
            expect(note?.className).toContain('settings-status');
        }
    });

    it('produces two DISTINCT sections, so one gate cannot stand in for the other', () => {
        const a = buildDockerServiceNote();
        const b = buildDockerUpdatesNote();
        expect(a.dataset['dockerNote']).not.toBe(b.dataset['dockerNote']);
        expect(a.querySelector('.settings-status')?.textContent).not.toBe(
            b.querySelector('.settings-status')?.textContent,
        );
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

    it('swaps both sections for the notes when runtime.docker is true', async () => {
        stubMeAsAdmin();
        const f = stubConfigFetch({ firstRunComplete: true, portWasAutoShifted: false, webPort: 8000, docker: true });
        new SettingsModal();
        await flush();

        expect(document.querySelector('[data-docker-note="service"]')).not.toBeNull();
        expect(document.querySelector('[data-docker-note="updates"]')).not.toBeNull();

        // And the inapplicable endpoints were never asked. This is the whole
        // reason the refreshes are held until docker mode is known: firing them
        // would draw "couldn't reach server" underneath the copy.
        const urls = f.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.startsWith('/api/service/status'))).toBe(false);
        expect(urls.some((u) => u.startsWith('/api/updates/status'))).toBe(false);
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

        const headings = Array.from(document.querySelectorAll<HTMLElement>('.settings-section-heading')).map(
            (el) => el.textContent ?? '',
        );
        expect(headings).toContain('Service');
        expect(headings).toContain('Updates');

        // And on the desktop those endpoints ARE asked.
        const urls = f.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.startsWith('/api/service/status'))).toBe(true);
        expect(urls.some((u) => u.startsWith('/api/updates/status'))).toBe(true);
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
