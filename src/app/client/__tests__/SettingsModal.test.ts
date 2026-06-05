// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import {
    uninstallFollowupMessage,
    classifyInstallPoll,
    resetPromptsPayload,
    scopeRadioState,
    lockScopeRadioControl,
    stopServerButtonState,
    buildServiceInfoRow,
    systemServiceInstallGate,
} from '../SettingsModal';

describe('uninstallFollowupMessage', () => {
    it('user scope -> reconnect/relaunch message', () => {
        expect(uninstallFollowupMessage('user')).toMatch(/relaunch|reconnect|local/i);
    });
    it('system scope -> service removed message', () => {
        expect(uninstallFollowupMessage('system')).toMatch(/removed|stopped/i);
    });
});

describe('classifyInstallPoll', () => {
    const base = { reachable: true, configMtime: 100, baselineMtime: 100, diskWebPort: null, iterations: 1, maxIterations: 30 };
    it('navigates when config mtime changed + port known (the existing Windows path)', () => {
        expect(classifyInstallPoll({ ...base, configMtime: 200, diskWebPort: 8002 })).toEqual({ kind: 'navigate', port: 8002 });
    });
    it('reconnects (not errors) when the local server becomes unreachable - same-port handoff', () => {
        expect(classifyInstallPoll({ ...base, reachable: false })).toEqual({ kind: 'reconnect' });
    });
    it('keeps polling while reachable + no config change', () => {
        expect(classifyInstallPoll(base)).toEqual({ kind: 'keep-polling' });
    });
    it('times out after maxIterations', () => {
        expect(classifyInstallPoll({ ...base, iterations: 31 })).toEqual({ kind: 'timeout' });
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

describe('buildServiceInfoRow', () => {
    it('renders a neutral status line — no error styling, no retry button', () => {
        const row = buildServiceInfoRow('service removed. relaunch the app manually.');
        expect(row.textContent).toContain('service removed');
        expect(row.className).toContain('settings-status');
        expect(row.className).not.toContain('settings-status-error');
        expect(row.querySelector('button')).toBeNull();
    });
});
