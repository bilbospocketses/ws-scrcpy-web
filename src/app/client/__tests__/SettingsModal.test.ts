// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    uninstallFollowupMessage,
    classifyInstallPoll,
    resetPromptsPayload,
    scopeRadioState,
    lockScopeRadioControl,
    stopServerButtonState,
    buildServiceInfoRow,
    systemServiceInstallGate,
    applySystemInstallGate,
    migrationNotice,
    appSectionButtonsState,
    buildInstallAllUsersControl,
    buildUninstallControl,
} from '../SettingsModal';

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
        expect(classifyInstallPoll({ ...served, configMtime: 200, diskWebPort: 8002 })).toEqual({ kind: 'navigate', port: 8002 });
    });
    it('reconnects when the service answers on the SAME port, no mtime change (the race fix)', () => {
        expect(classifyInstallPoll(served)).toEqual({ kind: 'reconnect' });
    });
    it('keeps polling while the local instance is still answering (not yet the service)', () => {
        expect(classifyInstallPoll({ ...served, servedByService: false })).toEqual({ kind: 'keep-polling' });
    });
    it('keeps polling through the hand-off dead window (unreachable, before the cap)', () => {
        expect(classifyInstallPoll({ ...served, reachable: false, servedByService: false, configMtime: null, diskWebPort: null, iterations: 2 })).toEqual({ kind: 'keep-polling' });
    });
    it('times out only when the service never takes over', () => {
        expect(classifyInstallPoll({ ...served, servedByService: false, iterations: 31 })).toEqual({ kind: 'timeout' });
    });
});

describe('resetPromptsPayload', () => {
    it('clears all four first-run / bookmark flags', () => {
        expect(resetPromptsPayload()).toEqual({
            firstRunComplete: false,
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

describe('migrationNotice', () => {
    it('show=true with reinstall text when serviceMigrationNeeded=true', () => {
        const result = migrationNotice({ serviceMigrationNeeded: true });
        expect(result.show).toBe(true);
        expect(result.text).toMatch(/old layout|reinstall|new layout/i);
    });
    it('show=false with empty text when serviceMigrationNeeded=false', () => {
        expect(migrationNotice({ serviceMigrationNeeded: false })).toEqual({ show: false, text: '' });
    });
    it('show=false with empty text when serviceMigrationNeeded is undefined', () => {
        expect(migrationNotice({})).toEqual({ show: false, text: '' });
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

    it('non-linux (win32) -> both rows hidden, nothing disabled, no note', () => {
        expect(appSectionButtonsState({ platform: 'win32', machineWideInstalled: false })).toEqual({
            showInstallAllUsers: false,
            installAllUsersDisabled: false,
            installAllUsersNote: null,
            showUninstall: false,
        });
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
    it('clicking the trigger expands the inline confirm panel', () => {
        const { button, confirmPanel } = buildUninstallControl({ onUninstalled: vi.fn() });
        expect(confirmPanel.classList.contains('settings-confirm-panel')).toBe(true);
        expect(confirmPanel.classList.contains('expanded')).toBe(false);
        button.click();
        expect(confirmPanel.classList.contains('expanded')).toBe(true);
    });

    it('confirm with "keep" checked POSTs /api/service/uninstall-app with {keep:true}', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);

        const { button, keepCheckbox, confirmButton } = buildUninstallControl({ onUninstalled: vi.fn() });
        button.click();
        keepCheckbox.checked = true;
        confirmButton.click();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
        expect(url).toBe('/api/service/uninstall-app');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({ keep: true });
        await flush();
    });

    it('confirm with "keep" unchecked POSTs {keep:false}', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);

        const { button, confirmButton } = buildUninstallControl({ onUninstalled: vi.fn() });
        button.click();
        confirmButton.click();

        const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
        expect(JSON.parse(init.body as string)).toEqual({ keep: false });
        await flush();
    });

    it('invokes onUninstalled (the terminal message) after a successful uninstall', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        const onUninstalled = vi.fn();

        const { button, confirmButton } = buildUninstallControl({ onUninstalled });
        button.click();
        confirmButton.click();
        await flush();

        expect(onUninstalled).toHaveBeenCalledTimes(1);
    });
});
