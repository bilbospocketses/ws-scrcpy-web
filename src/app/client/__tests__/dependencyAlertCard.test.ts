// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DependencyInfo, DependencyStatus } from '../../../common/DependencyTypes';
import { authClient } from '../AuthClient';
import { DependencyAlertCard } from '../DependencyAlertCard';

const dep = (over: Partial<DependencyInfo> = {}): DependencyInfo => ({
    name: 'scrcpy',
    displayName: 'scrcpy',
    installedVersion: '2.0',
    latestVersion: '2.1',
    status: DependencyStatus.UpdateAvailable,
    description: '',
    requiresRestart: false,
    canUpdate: true,
    ...over,
});

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('DependencyAlertCard', () => {
    it('makes no request when the admin API will not answer this caller', async () => {
        await DependencyAlertCard.create({ adminScope: 'local', callerIsLocal: false }, 'admin');
        expect(fetch).not.toHaveBeenCalled();
        vi.advanceTimersByTime(120_000);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('makes no request for a role that may not see dependencies', async () => {
        await DependencyAlertCard.create({ adminScope: 'local', callerIsLocal: true }, 'user');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('polls for a loopback admin', async () => {
        await DependencyAlertCard.create({ adminScope: 'local', callerIsLocal: true }, 'admin');
        expect(fetch).toHaveBeenCalled();
    });

    it('makes no request in a container, where the image owns the dependency set', async () => {
        // Item 135. Settings -> Dependencies is replaced by a note in a
        // container, so a card offering to open it would be a signpost to a dead
        // end -- its button lands on exactly that note. The caller here is a
        // loopback admin, i.e. the one case the two assertions above PASS, so
        // this can only be satisfied by the docker check itself.
        const card = await DependencyAlertCard.create(
            { adminScope: 'local', callerIsLocal: true, docker: true },
            'admin',
        );
        expect(fetch).not.toHaveBeenCalled();
        // Inert, not merely quiet on the first read: no interval either.
        vi.advanceTimersByTime(120_000);
        expect(fetch).not.toHaveBeenCalled();
        card.destroy();
    });

    it('shows nothing in a container even when an update is waiting', async () => {
        // The behaviour, not the request count. Without the gate this card would
        // render "adb has an update available" on a container home page, next to
        // a tab that says updating is not applicable.
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ ok: true, json: async () => [dep({ name: 'adb', displayName: 'adb' })] }),
        );
        const card = await DependencyAlertCard.create(
            { adminScope: 'local', callerIsLocal: true, docker: true },
            'admin',
        );
        expect(card.getElement().hidden).toBe(true);
        expect(card.getElement().textContent).not.toContain('adb');
        card.destroy();
    });

    it('polls when docker is false or absent, so the gate cannot be unconditional', async () => {
        // The half that matters (the file's own opening argument): a container
        // check that fired for everyone would pass both tests above and leave
        // every DESKTOP admin without the alert. `docker` is optional on the
        // envelope, so an old server that omits it must still poll -- fail-open,
        // like adminScope.
        await DependencyAlertCard.create({ adminScope: 'local', callerIsLocal: true, docker: false }, 'admin');
        expect(fetch).toHaveBeenCalled();

        vi.mocked(fetch).mockClear();
        await DependencyAlertCard.create({ adminScope: 'local', callerIsLocal: true }, 'admin');
        expect(fetch).toHaveBeenCalled();
    });
});

describe('DependencyAlertCard rendering', () => {
    it('stays hidden while every dependency is up to date', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [dep({ status: DependencyStatus.UpToDate, latestVersion: '2.0' })],
            }),
        );
        const card = await DependencyAlertCard.create({ adminScope: 'local', callerIsLocal: true }, 'admin');
        expect(card.getElement().hidden).toBe(true);
        card.destroy();
    });

    it('shows, and names what needs updating, once an update is available', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [
                    dep({ name: 'adb', displayName: 'adb' }),
                    dep({ status: DependencyStatus.UpToDate, latestVersion: '2.0' }),
                ],
            }),
        );
        const card = await DependencyAlertCard.create({ adminScope: 'local', callerIsLocal: true }, 'admin');
        expect(card.getElement().hidden).toBe(false);
        expect(card.getElement().textContent).toContain('adb');
        // The up-to-date one is not an alert: naming it here would make the card
        // a second dependency list rather than an alert about what needs doing.
        expect(card.getElement().textContent).not.toContain('scrcpy');
        card.destroy();
    });

    it('hides on a refused read, not merely on a malformed one', async () => {
        // The body is deliberately a WELL-FORMED array: a 403 whose body throws
        // in `.filter` would hide the card without the status ever being read,
        // so a realistic `{ error: 'forbidden' }` body could not tell a status
        // check from its absence. This one can.
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => [dep()] }));
        const card = await DependencyAlertCard.create({ adminScope: 'local', callerIsLocal: true }, 'admin');
        expect(card.getElement().hidden).toBe(true);
        card.destroy();
    });

    it('hides rather than rendering an error when a later read fails', async () => {
        // Driven from SHOWING into the failure on purpose. Asserting `hidden`
        // on a freshly created card proves nothing — it starts hidden, so that
        // assertion holds even if the catch does nothing at all.
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [dep()] });
        vi.stubGlobal('fetch', fetchMock);
        const card = await DependencyAlertCard.create({ adminScope: 'local', callerIsLocal: true }, 'admin');
        expect(card.getElement().hidden).toBe(false);

        fetchMock.mockRejectedValue(new Error('offline'));
        await vi.advanceTimersByTimeAsync(15_000);
        expect(card.getElement().hidden).toBe(true);
        card.destroy();
    });
});

describe('DependencyAlertCard teardown', () => {
    it('stops polling after destroy(), so the interval makes no further reads', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [dep()] });
        vi.stubGlobal('fetch', fetchMock);

        const card = await DependencyAlertCard.create({ adminScope: 'local', callerIsLocal: true }, 'admin');
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Positive control. Without it, the assertion after destroy() would hold
        // just as well for a card that never polled at all.
        await vi.advanceTimersByTimeAsync(15_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        card.destroy();
        fetchMock.mockClear();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('DependencyAlertCard link', () => {
    /** Flush one macrotask tick — the modal fills its body behind `await me()`. */
    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

    // Direct prototype assignments, which `vi.restoreAllMocks()` does not undo
    // — jsdom implements neither method, so they have to be installed rather
    // than spied, and put back by hand or every later file in the worker
    // inherits them.
    const realShowModal = HTMLDialogElement.prototype.showModal;
    const realClose = HTMLDialogElement.prototype.close;

    beforeEach(() => {
        // The card's own polling is irrelevant here and the settings dialog
        // needs real timers to settle its async body fill.
        vi.useRealTimers();
        HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
            this.setAttribute('open', '');
        });
        HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
            this.removeAttribute('open');
        });
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: unknown) =>
                String(input) === '/api/dependencies'
                    ? ({ ok: true, json: async () => [dep()] } as unknown as Response)
                    : ({ ok: true, json: async () => ({}) } as unknown as Response),
            ),
        );
        vi.spyOn(authClient, 'me').mockResolvedValue({
            authEnabled: true,
            user: { username: 'root', role: 'admin' },
        });
    });

    afterEach(() => {
        HTMLDialogElement.prototype.showModal = realShowModal;
        HTMLDialogElement.prototype.close = realClose;
        document.body.replaceChildren();
        vi.restoreAllMocks();
    });

    it('opens the settings dialog ON the Dependencies tab', async () => {
        const card = await DependencyAlertCard.create({ adminScope: 'local', callerIsLocal: true }, 'admin');
        document.body.appendChild(card.getElement());
        card.destroy();

        const link = card.getElement().querySelector('button');
        expect(link).not.toBeNull();
        link!.click();
        await flush();
        await flush();

        const selected = [...document.querySelectorAll('.settings-tab')].filter(
            (b) => b.getAttribute('aria-selected') === 'true',
        );
        expect(selected.map((b) => b.textContent)).toEqual(['Dependencies']);

        // aria-selected alone would hold even if the panel still showed another
        // tab's body, which is the failure the user would actually see.
        const shown = [...document.querySelectorAll<HTMLElement>('.settings-tab-panel > *')].filter((el) => !el.hidden);
        expect(shown.map((el) => el.dataset['settingsTab'])).toEqual(['dependencies']);

        // Close it rather than leaving a real dialog open: the tab it just
        // opened mounts a DependencyPanel with its own 15 s interval, and only
        // the close path runs `onBeforeClose` → `destroyDependenciesTab`. The ×
        // is the LAST `.modal-close` — the theme toggle shares that class and
        // sits before it.
        const dialog = document.querySelector('dialog.settings-modal');
        const closeBtn = [...(dialog?.querySelectorAll<HTMLButtonElement>('.modal-close') ?? [])].at(-1);
        closeBtn?.click();
        await flush();
        await flush();
        expect(document.querySelector('dialog.settings-modal[open]')).toBeNull();
    });
});
