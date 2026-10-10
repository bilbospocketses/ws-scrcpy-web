// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigEnvelope, FirstRunStatus } from '../../../common/ConfigEvents';
import { authClient } from '../AuthClient';
import { ADMIN_ACCESS_LOST_EVENT } from '../adminAccess';
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
        expect(line.textContent).not.toBe('');
        expect(line.textContent).toBe("couldn't save Remote admin without sign-in: nope");
        const users = sections().find((s) => s.querySelector('h3')?.textContent === 'Users')!;
        expect(users.querySelector<HTMLElement>('[data-settings-alert]')!.textContent).toBe('');
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

describe('where the admin API will not answer this page', () => {
    it('holds back every admin control and read, and says why on each tab', async () => {
        const f = stubServer(() => envelope({ adminScope: 'local', callerIsLocal: false }, false));
        new SettingsModal();
        await flush();

        // Nothing the server would refuse was asked.
        const urls = f.mock.calls.map((c) => String(c[0]));
        expect(urls.filter((u) => /^\/api\/(service|updates|tls|dependencies|embed-origins|users)/.test(u))).toEqual(
            [],
        );

        const byTitle = (t: string) => sections().find((s) => s.querySelector('h3')?.textContent === t);
        // Users: manage users and enable login disabled.
        for (const b of byTitle('Users')!.querySelectorAll<HTMLButtonElement>('.settings-card button')) {
            expect(b.disabled, b.textContent ?? '').toBe(true);
        }
        // Server: the ports and stop & exit disabled.
        const server = byTitle('Server')!;
        for (const input of server.querySelectorAll<HTMLInputElement>('input[type="number"]')) {
            expect(input.disabled).toBe(true);
        }
        const stop = [...server.querySelectorAll('button')].find((b) => b.textContent === 'stop server & exit');
        expect(stop?.disabled).toBe(true);
        // Every affected tab says why, once.
        for (const t of ['Users', 'Embedding', 'Updates', 'Service', 'Dependencies', 'Server', 'Local HTTPS']) {
            const s =
                t === 'Dependencies' ? sections().find((x) => x.dataset['settingsTab'] === 'dependencies') : byTitle(t);
            const shown = [...(s?.querySelectorAll<HTMLElement>('[data-admin-unreachable-note]') ?? [])].filter(
                (n) => !n.hidden,
            );
            expect(shown, t).toHaveLength(1);
            expect(shown[0]!.textContent, t).toBe('admin changes are limited to the machine running the server.');
        }
    });

    it('where it answers, the Embedding list is read and no tab shows the note', async () => {
        const f = stubServer(() => envelope({ adminScope: 'local', callerIsLocal: true }, false));
        new SettingsModal();
        await flush();
        expect(f.mock.calls.map((c) => String(c[0]))).toContain('/api/embed-origins');
        expect(
            [...document.querySelectorAll<HTMLElement>('[data-admin-unreachable-note]')].filter((n) => !n.hidden),
        ).toEqual([]);
    });

    // 0.5.6: the dialog's own check fails open when /api/config cannot be
    // read, so the tabs read anyway; the server's refusal then does what the
    // check would have done, instead of "couldn't reach server" and a retry.
    it('when the check could not be made and the server refuses a read, holds everything back the same way', async () => {
        const operator403 = () =>
            Promise.resolve({
                ok: false,
                status: 403,
                json: () => Promise.resolve({ error: 'admin actions are limited to this machine' }),
            });
        const f = vi.fn((url: string) => {
            if (url === '/api/config')
                return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
            if (url === '/api/updates/status' || url === '/api/service/status') return operator403();
            // The Dependencies panel mounts and starts its 15 s poll.
            if (url === '/api/dependencies') {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
            }
            return new Promise(() => undefined);
        });
        vi.stubGlobal('fetch', f);
        const depsReads = () => f.mock.calls.filter((c) => c[0] === '/api/dependencies').length;
        const lost = vi.fn();
        window.addEventListener(ADMIN_ACCESS_LOST_EVENT, lost);
        // Only the intervals are faked: `flush` still runs on real timeouts.
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        try {
            new SettingsModal();
            await flush();
            // The panel's poll is stopped with it (§36): no read follows the refusal.
            const before = depsReads();
            expect(before).toBeGreaterThan(0);
            vi.advanceTimersByTime(31_000);
            await flush();
            expect(depsReads()).toBe(before);
        } finally {
            vi.useRealTimers();
            window.removeEventListener(ADMIN_ACCESS_LOST_EVENT, lost);
        }

        expect(lost).toHaveBeenCalledTimes(1);
        const byTitle = (t: string) => sections().find((s) => s.querySelector('h3')?.textContent === t);
        for (const t of ['Updates', 'Service', 'Dependencies', 'Local HTTPS']) {
            const s =
                t === 'Dependencies' ? sections().find((x) => x.dataset['settingsTab'] === 'dependencies') : byTitle(t);
            const shown = [...(s?.querySelectorAll<HTMLElement>('[data-admin-unreachable-note]') ?? [])].filter(
                (n) => !n.hidden,
            );
            expect(shown, t).toHaveLength(1);
            expect(s!.textContent, t).not.toContain("couldn't reach server");
            expect(s!.querySelectorAll('.settings-card button'), t).toHaveLength(0);
        }
        for (const b of byTitle('Users')!.querySelectorAll<HTMLButtonElement>('.settings-card button')) {
            expect(b.disabled, b.textContent ?? '').toBe(true);
        }
        const server = byTitle('Server')!;
        const stop = [...server.querySelectorAll('button')].find((b) => b.textContent === 'stop server & exit');
        expect(stop?.disabled).toBe(true);
        for (const input of server.querySelectorAll<HTMLInputElement>('input[type="number"]')) {
            expect(input.disabled).toBe(true);
        }
        // Embedding: its list held back with the note, and nothing to add.
        const embedding = byTitle('Embedding')!;
        const embedNote = embedding.querySelector<HTMLElement>('[data-embed-list] [data-admin-unreachable-note]');
        expect(embedNote?.textContent).toBe('admin changes are limited to the machine running the server.');
        expect(embedding.querySelector<HTMLElement>('[data-embed-add]')!.hidden).toBe(true);
    });

    it('on another machine with remote admin on, Embedding is not read: it answers this machine only', async () => {
        const f = stubServer(() => envelope({ adminScope: 'remote', callerIsLocal: false }, true));
        new SettingsModal();
        await flush();
        expect(f.mock.calls.map((c) => String(c[0]))).not.toContain('/api/embed-origins');
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

    it("tells the page's pollers to stop BEFORE the batch goes out", async () => {
        const order: string[] = [];
        window.addEventListener(ADMIN_ACCESS_LOST_EVENT, () => order.push('lost'));
        let saved = false;
        const f = stubServer(
            () =>
                saved
                    ? envelope({ adminScope: 'local', callerIsLocal: false }, false)
                    : envelope({ adminScope: 'remote', callerIsLocal: false }, true),
            () => {
                order.push('batch');
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
        document.querySelector<HTMLButtonElement>('dialog.settings-modal button.settings-save')!.click();
        await flush();
        await flush();
        expect(order[0]).toBe('lost');
        expect(order[1]).toBe('batch');
        expect(f.mock.calls.filter((c) => c[0] === '/api/settings/batch')).toHaveLength(1);
    });

    it('does not tell them for a save that leaves this device an admin', async () => {
        const order: string[] = [];
        window.addEventListener(ADMIN_ACCESS_LOST_EVENT, () => order.push('lost'));
        stubServer(
            () => envelope({ adminScope: 'remote', callerIsLocal: true }, true),
            () => ({ ok: true, applied: ['allowRemoteAdmin'] }),
        );
        vi.spyOn(SettingsSummaryModal, 'confirm').mockResolvedValue(true);
        new SettingsModal();
        await flush();
        const box = document.querySelector<HTMLInputElement>('input[data-remote-admin]')!;
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector<HTMLButtonElement>('dialog.settings-modal button.settings-save')!.click();
        await flush();
        await flush();
        expect(order).toEqual([]);
    });

    it('does nothing more when this device can still administer (sign-in or this machine)', async () => {
        await turnItOffFromAnotherDevice(() => envelope({ adminScope: 'authenticated', callerIsLocal: false }, false));
        const open = [...document.querySelectorAll('dialog.settings-modal')].filter((d) => d.hasAttribute('open'));
        expect(open).toHaveLength(0);
    });
});
