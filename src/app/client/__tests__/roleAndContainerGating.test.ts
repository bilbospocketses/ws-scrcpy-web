import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_SECTIONS, canSeeSection } from '../adminGate';
import { appSectionButtonsState } from '../SettingsModal';

/**
 * Findings 9.6, 20.4 and 20.5 — two affordances offered where they cannot work.
 *
 * 9.6: the Dependencies panel rendered its heading and its table for every
 * role. The API answers 403 for a non-admin, so the panel showed
 * "Failed to load dependencies" — the smoke row's "doesn't see it" was the
 * panel failing, not the panel being gated. That reads as a bug to the user and
 * as coverage to the checklist.
 *
 * 20.4 / 20.5: Settings → Server still offered "install for all users" and
 * "uninstall" inside a container. The first POSTs a route that runs pkexec,
 * relocates the app to /opt and re-execs; the second tears down a service and
 * an install that do not exist there. A container has no polkit, and its
 * lifecycle belongs to `docker`, not to the app.
 */

describe('Dependencies panel visibility (finding 9.6)', () => {
    it('is an admin-only section, like every other surface whose API answers 403', () => {
        expect(ADMIN_ONLY_SECTIONS.has('dependencies')).toBe(true);
    });

    it('is hidden from a user-role account', () => {
        expect(canSeeSection('user', 'dependencies')).toBe(false);
    });

    it('is visible to an admin', () => {
        expect(canSeeSection('admin', 'dependencies')).toBe(true);
    });

    it('is visible when login is disabled, because /api/auth/me answers with the implicit admin', () => {
        // Not a special case in the gate — the server hands back role 'admin'
        // for the implicit user, so the ordinary admin path covers it. Pinned
        // here because getting it wrong hides the panel from every single-user
        // install.
        expect(canSeeSection('admin', 'dependencies')).toBe(true);
    });
});

describe('Settings → Server inside a container (findings 20.4, 20.5)', () => {
    it('offers install for all users on a Linux host', () => {
        const state = appSectionButtonsState({ platform: 'linux', machineWideInstalled: false });
        expect(state.showInstallAllUsers).toBe(true);
        expect(state.showUninstall).toBe(true);
    });

    it('offers neither inside a container', () => {
        const state = appSectionButtonsState({ platform: 'linux', machineWideInstalled: false, docker: true });
        expect(state.showInstallAllUsers).toBe(false);
        expect(state.showUninstall).toBe(false);
    });

    it('hides uninstall in a container on Windows too, where it is otherwise offered', () => {
        expect(appSectionButtonsState({ platform: 'win32' }).showUninstall).toBe(true);
        expect(appSectionButtonsState({ platform: 'win32', docker: true }).showUninstall).toBe(false);
    });

    it('treats an absent docker flag as "not a container", so a host is unaffected', () => {
        const state = appSectionButtonsState({ platform: 'linux', machineWideInstalled: true });
        expect(state.showInstallAllUsers).toBe(true);
        expect(state.installAllUsersDisabled).toBe(true);
        expect(state.installAllUsersNote).toBe('already installed for all users (/opt)');
    });
});
