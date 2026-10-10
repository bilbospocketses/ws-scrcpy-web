// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigEnvelope, FirstRunStatus } from '../../../common/ConfigEvents';
import { authClient } from '../AuthClient';
import { SettingsModal } from '../SettingsModal';
import { SettingsSummaryModal } from '../settings/SettingsSummaryModal';
import { tabAlertIn } from '../settings/settingsLayout';

/**
 * The Settings dialog's side of the tab status lines (0.5.5): every tab has
 * one, a save's result goes to the line of the tab on screen, and closing the
 * dialog stops every line's clock. Plus the Users tab's remote-admin item,
 * which the dialog feeds from /api/config, and what happens after a save that
 * ends this device's admin access.
 */

const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function envelope(runtime: Partial<FirstRunStatus>, allowRemoteAdmin = false): AppConfigEnvelope {
    return {
        config: {
            installMode: null,
            firstRunComplete: true,
            autoUpdate: true,
            updateCheckIntervalMinutes: 60,
            channel: 'stable',
            githubOwner: 'bilbospocketses',
            webPort: 8000,
            allowRemoteAdmin,
        },
        runtime: {
            firstRunComplete: true,
            portWasAutoShifted: false,
            webPort: 8000,
            docker: false,
            adminScope: 'local',
            callerIsLocal: true,
            ...runtime,
        },
    };
}

/**
 * A server: /api/config answers `config()` (read at call time, so a test can
 * change the policy after a save), the batch answers `batch`, and everything
 * else hangs, so no other tab's read fills in underneath.
 */
function stubServer(config: () => AppConfigEnvelope, batch: () => unknown = () => ({ ok: true, applied: [] })) {
    const f = vi.fn((url: string) => {
        if (url === '/api/config') {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(config()) });
        }
        if (url === '/api/settings/batch') {
            const body = batch() as { ok?: boolean };
            return Promise.resolve({
                ok: body.ok !== false,
                status: body.ok === false ? 400 : 200,
                json: () => Promise.resolve(body),
            });
        }
        return new Promise(() => undefined);
    });
    vi.stubGlobal('fetch', f);
    return f;
}

function sections(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('dialog.settings-modal .settings-tab-panel section')];
}

function tabButton(label: string): HTMLButtonElement {
    return [...document.querySelectorAll<HTMLButtonElement>('dialog.settings-modal [role="tab"]')].find(
        (b) => b.textContent === label,
    )!;
}

function activeBody(): HTMLElement {
    return document.querySelector<HTMLElement>('dialog.settings-modal .settings-tab-panel > :not([hidden])')!;
}

beforeEach(() => {
    document.body.replaceChildren();
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
    vi.spyOn(authClient, 'me').mockResolvedValue({ authEnabled: false, user: { username: 'admin', role: 'admin' } });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('every tab has one status line', () => {
    it('one line per tab, the last thing in its section, and none in the footer', async () => {
        stubServer(() => envelope({}));
        new SettingsModal();
        await flush();

        const all = sections();
        expect(all.length).toBeGreaterThanOrEqual(6);
        for (const section of all) {
            const lines = section.querySelectorAll('[data-settings-alert]');
            expect(lines, section.querySelector('h3')?.textContent ?? 'dependencies').toHaveLength(1);
            expect(section.lastElementChild).toBe(lines[0]);
        }
        expect(document.querySelector('.modal-footer [data-settings-alert]')).toBeNull();
        expect(document.querySelector('.settings-save-status')).toBeNull();
    });

    it('closing the dialog stops every line: a result that arrives later shows nothing', async () => {
        stubServer(() => envelope({}));
        const modal = new SettingsModal();
        await flush();
        const lines = sections().map((s) => tabAlertIn(s)!);
        lines[0]!.show('error', 'before the close');

        modal.close();
        for (const line of lines) line.show('success', 'after the close');
        expect(lines.map((l) => l.element.textContent)).not.toContain('after the close');
        expect(lines[0]!.element.textContent).toBe('before the close');
    });
});

describe("a save's result goes to the tab on screen", () => {
    it('a refused save on the Server tab is reported on the Server tab', async () => {
        stubServer(
            () => envelope({}, true),
            () => ({ ok: false, applied: [], failed: { id: 'allowRemoteAdmin', error: 'nope' } }),
        );
        vi.spyOn(SettingsSummaryModal, 'confirm').mockResolvedValue(true);
        new SettingsModal();
        await flush();

        // Staged on Users, saved from Server.
        const box = document.querySelector<HTMLInputElement>('input[data-remote-admin]')!;
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        tabButton('Server').click();
        document.querySelector<HTMLButtonElement>('dialog.settings-modal button.settings-save')!.click();
        await flush();

        const line = activeBody().querySelector<HTMLElement>('[data-settings-alert]')!;
        expect(activeBody().querySelector('h3')?.textContent).toBe('Server');
        expect(line.hidden).toBe(false);
        expect(line.textContent).toBe("couldn't save Remote admin without sign-in: nope");
        const users = sections().find((s) => s.querySelector('h3')?.textContent === 'Users')!;
        expect(users.querySelector<HTMLElement>('[data-settings-alert]')!.hidden).toBe(true);
    });
});

describe('the Users tab hears /api/config', () => {
    it('shows the remote-admin item from the stored value once the envelope arrives', async () => {
        stubServer(() => envelope({ adminScope: 'remote' }, true));
        new SettingsModal();
        await flush();
        const box = document.querySelector<HTMLInputElement>('input[data-remote-admin]')!;
        expect(box.closest<HTMLElement>('.settings-item')!.hidden).toBe(false);
        expect(box.checked).toBe(true);
    });

    it('in a container too, where remote admin is allowed', async () => {
        stubServer(() => envelope({ adminScope: 'remote', docker: true, callerIsLocal: false }, true));
        new SettingsModal();
        await flush();
        const box = document.querySelector<HTMLInputElement>('input[data-remote-admin]')!;
        expect(box.closest<HTMLElement>('.settings-item')!.hidden).toBe(false);
    });
});

describe("a save that ends this device's admin access", () => {
    /**
     * Uncheck remote admin from another device and save it. Answers how many
     * requests had been made when the save went out.
     */
    async function turnItOffFromAnotherDevice(after: () => AppConfigEnvelope): Promise<number> {
        let saved = false;
        const f = stubServer(
            () => (saved ? after() : envelope({ adminScope: 'remote', callerIsLocal: false }, true)),
            () => {
                saved = true;
                return { ok: true, applied: ['allowRemoteAdmin'] };
            },
        );
        vi.spyOn(SettingsSummaryModal, 'confirm').mockResolvedValue(true);
        new SettingsModal();
        await flush();
        const box = document.querySelector<HTMLInputElement>('input[data-remote-admin]')!;
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        const before = f.mock.calls.length;
        document.querySelector<HTMLButtonElement>('dialog.settings-modal button.settings-save')!.click();
        await flush();
        await flush();
        return before;
    }

    it('reopens Settings on Users, where the admin reads are held back', async () => {
        const before = await turnItOffFromAnotherDevice(() =>
            envelope({ adminScope: 'local', callerIsLocal: false }, false),
        );

        const open = [...document.querySelectorAll('dialog.settings-modal')].filter((d) => d.hasAttribute('open'));
        expect(open).toHaveLength(1);
        expect(document.querySelectorAll('dialog.settings-modal')).not.toHaveLength(0);
        // The new dialog is on Users, and its remote-admin box cannot act from here.
        expect(activeBody().querySelector('h3')?.textContent).toBe('Users');
        const box = open[0]!.querySelector<HTMLInputElement>('input[data-remote-admin]')!;
        expect(box.disabled).toBe(true);
        expect(box.checked).toBe(false);
        // Since the save, nothing the server would refuse was asked: only the
        // batch, the re-read of the policy, and the reads any caller may make.
        const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
        const since = f.mock.calls.slice(before).map((c) => String(c[0]));
        expect(since).toContain('/api/settings/batch');
        expect(since.filter((u) => /^\/api\/(dependencies|service|updates|tls)/.test(u))).toEqual([]);
    });

    it('does nothing more when this device can still administer (sign-in or this machine)', async () => {
        await turnItOffFromAnotherDevice(() => envelope({ adminScope: 'authenticated', callerIsLocal: false }, false));
        const open = [...document.querySelectorAll('dialog.settings-modal')].filter((d) => d.hasAttribute('open'));
        expect(open).toHaveLength(0);
    });
});
