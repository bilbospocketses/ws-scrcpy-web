// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as AdminConfirmModalModule from '../AdminConfirmModal';
import * as ResetConfirmModalModule from '../ResetConfirmModal';
import {
    applySystemInstallGate,
    appSectionButtonsState,
    buildInstallAllUsersControl,
    buildResetControl,
    buildServiceInfoRow,
    buildUninstallControl,
    classifyInstallPoll,
    lockScopeRadioControl,
    resetPromptsPayload,
    resetPromptSettingsPayload,
    SettingsModal,
    scopeRadioState,
    stopServerButtonState,
    systemServiceInstallGate,
    uninstallFollowupMessage,
} from '../SettingsModal';
import * as UninstallConfirmModalModule from '../UninstallConfirmModal';

/** Flush microtasks + a macrotask so the awaited fetch handlers settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('uninstallFollowupMessage', () => {
    it('user scope -> reconnect/relaunch message', () => {
        expect(uninstallFollowupMessage('user')).toMatch(/relaunch|reconnect|local/i);
    });
    it('system scope -> service removed message', () => {
        expect(uninstallFollowupMessage('system')).toMatch(/removed|stopped/i);
    });
});

describe('classifyInstallPoll', () => {
    // The service identifies itself via servedByService=true (the WS_SCRCPY_SERVICE
    // env set on the systemd/Servy unit). Success REQUIRES that positive signal, so
    // a same-port hand-off no longer hinges on catching a transient dead window or a
    // config.json mtime change that never happens — the intermittent "port discovery
    // timed out" race (beta.47).
    const served = {
        reachable: true,
        servedByService: true,
        configMtime: 100,
        baselineMtime: 100,
        diskWebPort: 8000,
        iterations: 1,
        maxIterations: 30,
    };
    it('navigates when the service answers on a new port (mtime changed)', () => {
        expect(classifyInstallPoll({ ...served, configMtime: 200, diskWebPort: 8002 })).toEqual({
            kind: 'navigate',
            port: 8002,
        });
    });
    it('reconnects when the service answers on the SAME port, no mtime change (the race fix)', () => {
        expect(classifyInstallPoll(served)).toEqual({ kind: 'reconnect' });
    });
    it('keeps polling while the local instance is still answering (not yet the service)', () => {
        expect(classifyInstallPoll({ ...served, servedByService: false })).toEqual({ kind: 'keep-polling' });
    });
    it('keeps polling through the hand-off dead window (unreachable, before the cap)', () => {
        expect(
            classifyInstallPoll({
                ...served,
                reachable: false,
                servedByService: false,
                configMtime: null,
                diskWebPort: null,
                iterations: 2,
            }),
        ).toEqual({ kind: 'keep-polling' });
    });
    it('times out only when the service never takes over', () => {
        expect(classifyInstallPoll({ ...served, servedByService: false, iterations: 31 })).toEqual({ kind: 'timeout' });
    });
});

describe('resetPromptsPayload', () => {
    it('clears firstRunComplete (the boot-trio flag sent to /api/config)', () => {
        expect(resetPromptsPayload()).toEqual({ firstRunComplete: false });
    });
});

describe('resetPromptSettingsPayload', () => {
    it('clears the three per-user prompt flags sent to /api/settings', () => {
        expect(resetPromptSettingsPayload()).toEqual({
            serviceFirstRunSeen: false,
            bookmarkDismissedForPort: null,
            bookmarkDismissedGlobally: false,
        });
    });
});

describe('scopeRadioState', () => {
    it('not installed -> unlocked, user pre-selected as the default', () => {
        expect(scopeRadioState({ status: 'not-installed' })).toEqual({
            installedScope: null,
            locked: false,
            userChecked: true,
            systemChecked: false,
        });
    });

    it('installed user scope (authoritative resp.scope) -> locked, user checked', () => {
        expect(scopeRadioState({ status: 'running', scope: 'user' })).toEqual({
            installedScope: 'user',
            locked: true,
            userChecked: true,
            systemChecked: false,
        });
    });

    it('installed system scope (authoritative resp.scope) -> locked, system checked', () => {
        expect(scopeRadioState({ status: 'running', scope: 'system' })).toEqual({
            installedScope: 'system',
            locked: true,
            userChecked: false,
            systemChecked: true,
        });
    });

    it('falls back to installMode when resp.scope is absent: user-service form', () => {
        expect(scopeRadioState({ status: 'running', installMode: 'user-service' })).toMatchObject({
            installedScope: 'user',
            locked: true,
            userChecked: true,
        });
    });

    it('falls back to installMode when resp.scope is absent: bare system form', () => {
        expect(scopeRadioState({ status: 'running', installMode: 'system' })).toMatchObject({
            installedScope: 'system',
            locked: true,
            systemChecked: true,
        });
    });
});

describe('lockScopeRadioControl', () => {
    it('locks a scope radio readonly WITHOUT the disabled attribute, so accent-color still renders', () => {
        const label = document.createElement('label');
        label.className = 'settings-radio-label';
        const radio = document.createElement('input');
        radio.type = 'radio';
        label.appendChild(radio);

        lockScopeRadioControl(label, radio);

        // The bug was `radio.disabled = true`: Chromium desaturates accent-color
        // on :disabled controls, so the selected dot went invisible. The radio
        // must stay ENABLED and be locked via tabindex + a class (the CSS rule
        // applies pointer-events:none on the label).
        expect(radio.disabled).toBe(false);
        expect(radio.tabIndex).toBe(-1);
        expect(label.classList.contains('settings-radio-locked')).toBe(true);
    });
});

describe('stopServerButtonState', () => {
    it('not installed (local mode) -> enabled, no note', () => {
        expect(stopServerButtonState({ status: 'not-installed' })).toEqual({
            disabled: false,
            note: null,
        });
    });

    it('absent status (unknown) -> treated as not-installed -> enabled', () => {
        expect(stopServerButtonState({})).toEqual({ disabled: false, note: null });
    });

    it('running user-scope service -> disabled with a service-mode note', () => {
        const s = stopServerButtonState({ status: 'running', scope: 'user' });
        expect(s.disabled).toBe(true);
        expect(s.note).toMatch(/service/i);
    });

    it('running system-scope service -> disabled with a service-mode note', () => {
        const s = stopServerButtonState({ status: 'running', scope: 'system' });
        expect(s.disabled).toBe(true);
        expect(s.note).toMatch(/service/i);
    });
});

describe('systemServiceInstallGate', () => {
    it('disables system service install with explainer when not machine-wide', () => {
        expect(systemServiceInstallGate({ machineWideInstalled: false })).toEqual({
            enabled: false,
            note: 'system service install requires installing system-wide for all users first.',
        });
    });
    it('enables it (no note) once machine-wide installed', () => {
        expect(systemServiceInstallGate({ machineWideInstalled: true })).toEqual({ enabled: true, note: null });
    });
});

describe('applySystemInstallGate', () => {
    it('disables the install button + shows the gate note when system selected and not machine-wide', () => {
        const btn = document.createElement('button');
        const note = document.createElement('p');
        note.hidden = true;
        applySystemInstallGate(btn, note, /* systemSelected */ true, /* machineWideInstalled */ false);
        expect(btn.disabled).toBe(true);
        expect(note.hidden).toBe(false);
        expect(note.textContent).toMatch(/system-wide/i);
    });

    it('enables the button + hides the note when user scope is selected (gate only applies to system)', () => {
        const btn = document.createElement('button');
        const note = document.createElement('p');
        applySystemInstallGate(btn, note, /* systemSelected */ false, /* machineWideInstalled */ false);
        expect(btn.disabled).toBe(false);
        expect(note.hidden).toBe(true);
        expect(note.textContent).toBe('');
    });

    it('enables the button (no note) when machine-wide is installed even if system is selected', () => {
        const btn = document.createElement('button');
        const note = document.createElement('p');
        applySystemInstallGate(btn, note, /* systemSelected */ true, /* machineWideInstalled */ true);
        expect(btn.disabled).toBe(false);
        expect(note.hidden).toBe(true);
    });
});

describe('buildServiceInfoRow', () => {
    it('renders a neutral status line — no error styling, no retry button', () => {
        const row = buildServiceInfoRow('service removed. relaunch the app manually.');
        expect(row.textContent).toContain('service removed');
        expect(row.className).toContain('settings-status');
        expect(row.className).not.toContain('settings-status-error');
        expect(row.querySelector('button')).toBeNull();
    });
});

describe('appSectionButtonsState', () => {
    it('linux, not machine-wide -> both rows shown, install enabled with no note', () => {
        expect(appSectionButtonsState({ platform: 'linux', machineWideInstalled: false })).toEqual({
            showInstallAllUsers: true,
            installAllUsersDisabled: false,
            installAllUsersNote: null,
            showUninstall: true,
        });
    });

    it('linux, machine-wide -> install disabled with an "already installed" note, uninstall still shown', () => {
        const s = appSectionButtonsState({ platform: 'linux', machineWideInstalled: true });
        expect(s.showInstallAllUsers).toBe(true);
        expect(s.installAllUsersDisabled).toBe(true);
        expect(s.installAllUsersNote).toMatch(/already installed for all users/i);
        expect(s.showUninstall).toBe(true);
    });

    it('win32 -> install-all-users hidden, uninstall shown, nothing disabled, no note', () => {
        expect(appSectionButtonsState({ platform: 'win32', machineWideInstalled: false })).toEqual({
            showInstallAllUsers: false,
            installAllUsersDisabled: false,
            installAllUsersNote: null,
            showUninstall: true,
        });
    });

    // Part A: win32 should show uninstall but NOT install-all-users
    it('win32 -> showUninstall=true, showInstallAllUsers=false', () => {
        const s = appSectionButtonsState({ platform: 'win32', machineWideInstalled: false });
        expect(s.showUninstall).toBe(true);
        expect(s.showInstallAllUsers).toBe(false);
    });

    it('linux -> showUninstall=true AND showInstallAllUsers=true', () => {
        const s = appSectionButtonsState({ platform: 'linux', machineWideInstalled: false });
        expect(s.showUninstall).toBe(true);
        expect(s.showInstallAllUsers).toBe(true);
    });
});

describe('buildInstallAllUsersControl', () => {
    it('clicking install POSTs /api/service/install-system-wide and reloads on ok', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        const reload = vi.fn();

        const { button } = buildInstallAllUsersControl({ reload });
        button.click();

        // fetch is invoked synchronously, before the first await in the handler.
        expect(fetchMock).toHaveBeenCalledWith('/api/service/install-system-wide', { method: 'POST' });

        await flush();
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('shows an inline error note and does NOT reload when the server rejects', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false });
        vi.stubGlobal('fetch', fetchMock);
        const reload = vi.fn();

        const { button, note } = buildInstallAllUsersControl({ reload });
        button.click();
        await flush();

        expect(reload).not.toHaveBeenCalled();
        expect(note.hidden).toBe(false);
        expect(note.textContent).toMatch(/install/i);
    });
});

describe('buildUninstallControl', () => {
    it('returns only { button } — no confirmPanel, keepCheckbox, confirmButton, cancelButton', () => {
        const result = buildUninstallControl({ onUninstalled: vi.fn() });
        expect(result).toHaveProperty('button');
        expect(result).not.toHaveProperty('confirmPanel');
        expect(result).not.toHaveProperty('keepCheckbox');
        expect(result).not.toHaveProperty('confirmButton');
        expect(result).not.toHaveProperty('cancelButton');
    });

    it('button click opens UninstallConfirmModal (calls confirm)', async () => {
        const confirmSpy = vi
            .spyOn(UninstallConfirmModalModule.UninstallConfirmModal, 'confirm')
            .mockResolvedValue({ confirmed: false, keep: true });
        const { button } = buildUninstallControl({ onUninstalled: vi.fn() });
        button.click();
        await flush();
        expect(confirmSpy).toHaveBeenCalledTimes(1);
    });

    it('on confirmed=true,keep=true POSTs /api/service/uninstall-app with {keep:true} and calls onUninstalled', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        const onUninstalled = vi.fn();
        vi.spyOn(UninstallConfirmModalModule.UninstallConfirmModal, 'confirm').mockResolvedValue({
            confirmed: true,
            keep: true,
        });

        const { button } = buildUninstallControl({ onUninstalled });
        button.click();
        await flush();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
        expect(url).toBe('/api/service/uninstall-app');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({ keep: true });
        expect(onUninstalled).toHaveBeenCalledTimes(1);
    });

    it('on confirmed=true,keep=false POSTs {keep:false} and calls onUninstalled', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        const onUninstalled = vi.fn();
        vi.spyOn(UninstallConfirmModalModule.UninstallConfirmModal, 'confirm').mockResolvedValue({
            confirmed: true,
            keep: false,
        });

        const { button } = buildUninstallControl({ onUninstalled });
        button.click();
        await flush();

        const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
        expect(JSON.parse(init.body as string)).toEqual({ keep: false });
        expect(onUninstalled).toHaveBeenCalledTimes(1);
    });

    it('on confirmed=false does NOT POST and does NOT call onUninstalled', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const onUninstalled = vi.fn();
        vi.spyOn(UninstallConfirmModalModule.UninstallConfirmModal, 'confirm').mockResolvedValue({
            confirmed: false,
            keep: true,
        });

        const { button } = buildUninstallControl({ onUninstalled });
        button.click();
        await flush();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(onUninstalled).not.toHaveBeenCalled();
    });
});

describe('buildResetControl', () => {
    it('returns only { button } — no inline confirmPanel/note', () => {
        const result = buildResetControl({ reload: vi.fn() });
        expect(result).toHaveProperty('button');
        expect(result).not.toHaveProperty('confirmPanel');
        expect(result).not.toHaveProperty('note');
    });

    it('button is the primary "reset" button', () => {
        const { button } = buildResetControl({ reload: vi.fn() });
        expect(button.textContent).toBe('reset');
        expect(button.classList.contains('settings-btn')).toBe(true);
        expect(button.classList.contains('settings-btn-primary')).toBe(true);
    });

    it('button click opens ResetConfirmModal (calls confirm)', async () => {
        const confirmSpy = vi.spyOn(ResetConfirmModalModule.ResetConfirmModal, 'confirm').mockResolvedValue(false);
        const { button } = buildResetControl({ reload: vi.fn() });
        button.click();
        await flush();
        expect(confirmSpy).toHaveBeenCalledTimes(1);
    });

    it('on confirm=true PATCHes /api/config (firstRunComplete) and /api/settings (prompt flags) and reloads', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
        vi.stubGlobal('fetch', fetchMock);
        const reload = vi.fn();
        vi.spyOn(ResetConfirmModalModule.ResetConfirmModal, 'confirm').mockResolvedValue(true);

        const { button } = buildResetControl({ reload });
        button.click();
        await flush();

        // Two PATCHes: /api/config for firstRunComplete; /api/settings for the three prompt flags.
        const calls = fetchMock.mock.calls as [string, RequestInit][];
        const configCall = calls.find(([url]) => url === '/api/config');
        const settingsCall = calls.find(([url]) => url === '/api/settings');
        expect(configCall).toBeTruthy();
        expect(JSON.parse(configCall![1].body as string)).toEqual(resetPromptsPayload());
        expect(settingsCall).toBeTruthy();
        expect(JSON.parse(settingsCall![1].body as string)).toEqual(resetPromptSettingsPayload());
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('on confirm=false does NOT PATCH and does NOT reload', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const reload = vi.fn();
        vi.spyOn(ResetConfirmModalModule.ResetConfirmModal, 'confirm').mockResolvedValue(false);

        const { button } = buildResetControl({ reload });
        button.click();
        await flush();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
    });

    it('reloads even when both PATCHes reject (reset always reloads)', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error('network'));
        vi.stubGlobal('fetch', fetchMock);
        const reload = vi.fn();
        vi.spyOn(ResetConfirmModalModule.ResetConfirmModal, 'confirm').mockResolvedValue(true);

        const { button } = buildResetControl({ reload });
        button.click();
        await flush();

        expect(reload).toHaveBeenCalledTimes(1);
    });
});

describe('Server section row order (folded App, beta.62)', () => {
    /** Flush microtasks so SettingsModal.fillBody() runs (it is queued via queueMicrotask). */
    const flushMicrotasks = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

    it('Server-section rows appear in order: reset, install-for-all-users, stop-server, uninstall', async () => {
        // Stub fetch so the refresh* calls inside the constructor never settle
        // (we only need the base DOM structure, not service-status overlays).
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));
        // jsdom does not implement <dialog>.showModal(); polyfill it so Modal constructor
        // does not throw. The polyfill is a no-op — we only need the DOM tree, not the
        // native dialog open state.
        HTMLDialogElement.prototype.showModal = vi.fn();

        new SettingsModal();
        // Modal constructor appends to document.body already; wait for
        // queueMicrotask(() => fillBody(...)) to run.
        await flushMicrotasks();

        const labels = Array.from(document.body.querySelectorAll<HTMLElement>('.settings-row .settings-label')).map(
            (el) => el.textContent ?? '',
        );

        const resetIdx = labels.indexOf('reset welcome and bookmark prompts');
        const installIdx = labels.indexOf('install for all users');
        const stopIdx = labels.indexOf('stop the server and close the app');
        const uninstallIdx = labels.indexOf('uninstall ws-scrcpy-web');

        // All four rows must exist
        expect(resetIdx, 'reset row missing').toBeGreaterThanOrEqual(0);
        expect(installIdx, 'install-for-all-users row missing').toBeGreaterThanOrEqual(0);
        expect(stopIdx, 'stop-server row missing').toBeGreaterThanOrEqual(0);
        expect(uninstallIdx, 'uninstall row missing').toBeGreaterThanOrEqual(0);

        // Order: reset < install-for-all-users < stop < uninstall
        expect(resetIdx, 'reset must come before install-for-all-users').toBeLessThan(installIdx);
        expect(installIdx, 'install-for-all-users must come before stop').toBeLessThan(stopIdx);
        expect(stopIdx, 'stop must come before uninstall').toBeLessThan(uninstallIdx);
    });
});

describe('Settings section restructure (beta.62)', () => {
    const flushMicrotasks = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

    it('renders sections in order Updates, Service, Server — no standalone App section', async () => {
        document.body.replaceChildren();
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));
        HTMLDialogElement.prototype.showModal = vi.fn();

        new SettingsModal();
        await flushMicrotasks();

        const headings = Array.from(document.body.querySelectorAll<HTMLElement>('.settings-section-heading')).map(
            (el) => el.textContent ?? '',
        );
        expect(headings).toEqual(['Updates', 'Service', 'Server']);
    });

    it('places the web-port save button inline with the input in the same control cell', async () => {
        document.body.replaceChildren();
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));
        HTMLDialogElement.prototype.showModal = vi.fn();

        new SettingsModal();
        await flushMicrotasks();

        const rows = Array.from(document.body.querySelectorAll<HTMLElement>('.settings-row'));
        const portRow = rows.find((r) => r.querySelector('.settings-label')?.textContent === 'web port');
        expect(portRow, 'web port row missing').toBeTruthy();
        const control = portRow?.querySelector('.settings-control');
        expect(control?.querySelector('input'), 'port input missing').toBeTruthy();
        const inlineBtn = control?.querySelector('button');
        expect(inlineBtn?.textContent, 'inline save button missing').toBe('save');
    });
});

describe('onInstallService takeover copy (§7 system-service hand-off)', () => {
    /**
     * Drain all pending microtasks (Promise chains, queueMicrotask) without
     * touching macrotask/timer queues — safe under vi.useFakeTimers().
     * Multiple rounds handle chained awaits (fetch → .json() → handler body).
     */
    const drainMicrotasks = async (rounds = 8): Promise<void> => {
        for (let i = 0; i < rounds; i++) {
            await Promise.resolve();
            await new Promise<void>((r) => queueMicrotask(r));
        }
    };

    /** Build a resolved-JSON fetch response. */
    const jsonResponse = (body: unknown, ok = true): Response =>
        ({ ok, json: () => Promise.resolve(body), status: ok ? 200 : 500 }) as unknown as Response;

    /** Linux not-installed status response — sets platform + scope radios. */
    const linuxNotInstalled = {
        supported: true,
        status: 'not-installed',
        platform: 'linux',
        machineWideInstalled: true, // enables system-scope install gate
    };

    /** Successful install response (system-service scope). */
    const installOkResponse = {
        ok: true,
        status: 'shutting-down',
        installMode: 'system-service',
        configMtime: 100,
        diskWebPort: 8000,
    };

    /** Status poll response — service not yet serving. */
    const statusNotYetServed = {
        configMtime: 100,
        diskWebPort: 8000,
        servedByService: false,
    };

    /**
     * Build a URL-dispatched fetch mock.
     * - GET /api/service/status  → linuxNotInstalled (initial) or statusNotYetServed (poll)
     * - POST /api/service/install → the given install response
     * - All other URLs           → ok:false (refreshServer/refreshUpdates errors are harmless)
     */
    const makeInstallFetchMock = (installResponse: unknown, pollResponse: unknown = statusNotYetServed) => {
        let installFired = false;
        return vi.fn((url: string, init?: RequestInit): Promise<Response> => {
            if (url === '/api/service/install' && init?.method === 'POST') {
                installFired = true;
                return Promise.resolve(jsonResponse(installResponse));
            }
            if (url === '/api/service/status') {
                // Before install fires, return the initial not-installed state.
                // After, return the poll response.
                const body = installFired ? pollResponse : linuxNotInstalled;
                return Promise.resolve(jsonResponse(body));
            }
            // /api/config, /api/updates/status — let them fail gracefully.
            return Promise.resolve(jsonResponse(null, false));
        });
    };

    beforeEach(() => {
        document.body.replaceChildren();
        HTMLDialogElement.prototype.showModal = vi.fn();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /** Spin up a SettingsModal and drain until the service section is rendered. */
    const buildModal = async (): Promise<void> => {
        new SettingsModal();
        // Drain the constructor's queueMicrotask (fillBody + three refresh* calls start).
        await drainMicrotasks();
        // Drain the fetch chains for refreshService (the one that matters for our DOM).
        await drainMicrotasks();
    };

    it('system-scope install shows "switching to the system service…" on the install button while polling', async () => {
        const fetchMock = makeInstallFetchMock(installOkResponse);
        vi.stubGlobal('fetch', fetchMock);

        // AdminConfirmModal.confirm is called for system scope; make it approve.
        vi.spyOn(AdminConfirmModalModule.AdminConfirmModal, 'confirm').mockResolvedValue(true);

        await buildModal();

        // After renderServiceState, the install button should exist.
        const installBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button.settings-btn')).find(
            (b) => b.textContent === 'not installed — install?',
        );
        expect(installBtn, 'install button not found after initial render').toBeTruthy();

        // Select system scope radio.
        const systemRadio = document.body.querySelector<HTMLInputElement>('input[type="radio"][value="system"]');
        expect(systemRadio, 'system scope radio not found').toBeTruthy();
        systemRadio!.checked = true;

        // Click install. For system scope, onInstallService awaits
        // AdminConfirmModal.confirm (mocked → resolves true), then POSTs
        // /api/service/install, then sets the takeover copy, then starts the poll.
        installBtn!.click();
        // Drain: confirm resolves → fetch POST called → response .json() → handler runs.
        await drainMicrotasks(12);

        // Install fetch must have fired.
        const postCalls = fetchMock.mock.calls.filter(
            (args) => args[0] === '/api/service/install' && args[1]?.method === 'POST',
        );
        expect(postCalls.length, 'install POST not called').toBeGreaterThanOrEqual(1);

        // Takeover copy must be set before the first poll tick.
        expect(installBtn!.textContent).toBe('switching to the system service…');

        // Advance one poll interval (keep-polling outcome) — copy must persist.
        await vi.advanceTimersByTimeAsync(2000);
        await drainMicrotasks(8);
        expect(installBtn!.textContent).toBe('switching to the system service…');
    });

    it('user-scope install does NOT show takeover copy — button stays "installing…" while polling', async () => {
        const userInstallOk = { ...installOkResponse, installMode: 'user-service' };
        const fetchMock = makeInstallFetchMock(userInstallOk);
        vi.stubGlobal('fetch', fetchMock);

        // User scope on Linux skips AdminConfirmModal entirely — no spy needed.

        await buildModal();

        const installBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button.settings-btn')).find(
            (b) => b.textContent === 'not installed — install?',
        );
        expect(installBtn, 'install button not found').toBeTruthy();

        // Ensure user radio is checked, system radio is not.
        const userRadio = document.body.querySelector<HTMLInputElement>('input[type="radio"][value="user"]');
        expect(userRadio, 'user scope radio not found').toBeTruthy();
        userRadio!.checked = true;
        const systemRadio = document.body.querySelector<HTMLInputElement>('input[type="radio"][value="system"]');
        if (systemRadio) systemRadio.checked = false;

        // Click install — Linux + user scope skips AdminConfirmModal.
        installBtn!.click();
        await drainMicrotasks(12);

        const postCalls = fetchMock.mock.calls.filter(
            (args) => args[0] === '/api/service/install' && args[1]?.method === 'POST',
        );
        expect(postCalls.length, 'install POST not called').toBeGreaterThanOrEqual(1);

        // Button should show 'installing…' — NOT the takeover copy.
        expect(installBtn!.textContent).toBe('installing…');

        // After one poll tick, still 'installing…'.
        await vi.advanceTimersByTimeAsync(2000);
        await drainMicrotasks(8);
        expect(installBtn!.textContent).toBe('installing…');
    });
});
