// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigEnvelope, FirstRunStatus } from '../../../../common/ConfigEvents';
import { REMOTE_ADMIN_FORCED_MESSAGE, REMOTE_ADMIN_ID } from '../../../../common/remoteAdmin';
import { authClient } from '../../AuthClient';
import { RemoteAdminWarningModal } from '../../RemoteAdminWarningModal';
import { SettingsSummaryModal } from '../SettingsSummaryModal';
import { StagedSettingsStore } from '../StagedSettingsStore';
import { type AskChild, askUnbound, type TabContext } from '../tabs/EmbeddingTab';
import {
    applyUsersConfig,
    buildUsersTab,
    REMOTE_ADMIN_LABEL,
    REMOTE_ADMIN_OFF_BOX_WARNING,
    REMOTE_ADMIN_OFF_NOTE,
    REMOTE_ADMIN_ON_NOTE,
    REMOTE_ADMIN_ON_TITLE,
    REMOTE_ADMIN_SIGN_IN_NOTE,
    REMOTE_ADMIN_STAGED_TITLE,
} from '../tabs/UsersTab';

/**
 * Settings → Users (0.5.5): the login toggle's results on the tab's line, and
 * remote admin without sign-in as a STAGED checkbox, moved here from the home
 * page's banner.
 */

const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
    // The manage-users dialog reads who is signed in; nothing here needs it to answer.
    vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise(() => undefined)),
    );
});

afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function ctx(over: Partial<TabContext> = {}): TabContext {
    return {
        role: 'admin',
        authEnabled: false,
        reload: () => undefined,
        askChild: askUnbound,
        openChild: <T>(open: () => T) => open(),
        ...over,
    };
}

function envelope(runtime: Partial<FirstRunStatus>, allowRemoteAdmin?: boolean): AppConfigEnvelope {
    return {
        config: {
            installMode: null,
            firstRunComplete: true,
            autoUpdate: true,
            updateCheckIntervalMinutes: 60,
            channel: 'stable',
            githubOwner: 'bilbospocketses',
            webPort: 8000,
            ...(allowRemoteAdmin === undefined ? {} : { allowRemoteAdmin }),
        },
        runtime: {
            firstRunComplete: true,
            portWasAutoShifted: false,
            webPort: 8000,
            adminScope: 'local',
            callerIsLocal: true,
            ...runtime,
        },
    };
}

function mount(context: TabContext = ctx()) {
    const store = new StagedSettingsStore();
    const section = buildUsersTab(context, store);
    document.body.appendChild(section);
    const checkbox = section.querySelector<HTMLInputElement>('input[data-remote-admin]')!;
    const note = section.querySelector<HTMLElement>('[data-remote-admin-note]')!;
    const title = section.querySelector<HTMLElement>('[data-remote-admin-title]')!;
    const item = checkbox.closest<HTMLElement>('.settings-item')!;
    const line = section.querySelector<HTMLElement>(':scope > [data-settings-alert]')!;
    const toggle = (checked: boolean): void => {
        checkbox.checked = checked;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    };
    return { store, section, checkbox, note, title, item, line, toggle };
}

describe('the login toggle', () => {
    it('a refused enable says why on the tab line, below the card', async () => {
        vi.spyOn(authClient, 'enableAuth').mockResolvedValue({ ok: false, status: 409 } as Response);
        const ui = mount();
        const btn = [...ui.section.querySelectorAll('button')].find((b) => b.textContent === 'enable login')!;
        btn.click();
        await flush();

        expect(ui.line.textContent).not.toBe('');
        expect(ui.line.textContent).toBe('Add a user with an admin password first (Users → manage users)');
        expect(ui.line.classList.contains('settings-status-error')).toBe(true);
        expect(ui.section.querySelector('.settings-card')!.contains(ui.line)).toBe(false);
        expect(btn.disabled).toBe(false);
    });

    it('an enable that never reached the server says so on the tab line', async () => {
        vi.spyOn(authClient, 'enableAuth').mockRejectedValue(new TypeError('Failed to fetch'));
        const ui = mount();
        [...ui.section.querySelectorAll('button')].find((b) => b.textContent === 'enable login')!.click();
        await flush();
        expect(ui.line.textContent).toBe('failed to enable login — could not reach server.');
    });

    it('a failed disable says so on the tab line', async () => {
        vi.spyOn(authClient, 'disableAuth').mockRejectedValue(new Error('500'));
        const ui = mount(ctx({ authEnabled: true }));
        [...ui.section.querySelectorAll('button')].find((b) => /disable login/.test(b.textContent ?? ''))!.click();
        await flush();
        expect(ui.line.textContent).toBe('failed to disable login — see server logs.');
        expect(ui.line.textContent).not.toBe('');
    });
});

describe('remote admin without sign-in: what the item shows', () => {
    it('is hidden, and stages nothing, until the dialog hands over /api/config', () => {
        const ui = mount();
        expect(ui.item.hidden).toBe(true);
        expect(ui.store.changes()).toEqual([]);
    });

    it('is a checkbox named by its row label', () => {
        const ui = mount();
        applyUsersConfig(ui.section, envelope({}));
        const labelId = ui.checkbox.getAttribute('aria-labelledby')!;
        expect(document.getElementById(labelId)?.textContent).toBe('remote admin without sign-in');
        expect(ui.item.hidden).toBe(false);
    });

    it('off: unchecked, with the muted note', () => {
        const ui = mount();
        applyUsersConfig(ui.section, envelope({}, false));
        expect(ui.checkbox.checked).toBe(false);
        expect(ui.checkbox.disabled).toBe(false);
        expect(ui.note.textContent).toBe(REMOTE_ADMIN_OFF_NOTE);
        expect(ui.note.textContent).toBe('admin actions are limited to this machine unless sign-in is set up.');
        expect(ui.note.classList.contains('settings-status-warning')).toBe(false);
        expect(ui.note.hidden).toBe(false);
    });

    it('on: checked, in the home page banner look, with its title over the warning', () => {
        const ui = mount();
        applyUsersConfig(ui.section, envelope({ adminScope: 'remote' }, true));
        expect(ui.checkbox.checked).toBe(true);
        expect(ui.note.textContent).toBe(REMOTE_ADMIN_ON_NOTE);
        expect(ui.note.textContent).toBe(
            'any device that can reach this server can administer it. set up sign-in, or uncheck this, to close it.',
        );
        // The box carries the warning tone; the note reads as its body.
        expect(ui.item.classList.contains('settings-item--alert')).toBe(true);
        expect(ui.title.hidden).toBe(false);
        expect(ui.title.textContent).toBe(REMOTE_ADMIN_ON_TITLE);
        expect(ui.title.textContent).toBe('remote admin is enabled without sign-in.');
        expect(ui.note.classList.contains('settings-status-warning')).toBe(false);
    });

    it('checked but not yet saved: the banner look says it applies on save', async () => {
        vi.spyOn(RemoteAdminWarningModal, 'choose').mockResolvedValue('accept');
        const ui = mount(ctx({ askChild: async (open) => open() }));
        applyUsersConfig(ui.section, envelope({}, false));
        expect(ui.item.classList.contains('settings-item--alert')).toBe(false);
        expect(ui.title.hidden).toBe(true);
        ui.toggle(true);
        await flush();
        expect(ui.item.classList.contains('settings-item--alert')).toBe(true);
        expect(ui.title.textContent).toBe(REMOTE_ADMIN_STAGED_TITLE);
        // Unchecked again: back to a plain item.
        ui.toggle(false);
        expect(ui.item.classList.contains('settings-item--alert')).toBe(false);
        expect(ui.title.hidden).toBe(true);
    });

    it('off, and on while sign-in is on, are plain items', () => {
        const off = mount();
        applyUsersConfig(off.section, envelope({}, false));
        expect(off.item.classList.contains('settings-item--alert')).toBe(false);
        expect(off.title.hidden).toBe(true);

        const signedIn = mount(ctx({ authEnabled: true }));
        applyUsersConfig(signedIn.section, envelope({ adminScope: 'authenticated' }, true));
        expect(signedIn.item.classList.contains('settings-item--alert')).toBe(false);
        expect(signedIn.title.hidden).toBe(true);
    });

    it('forced on by the environment: checked and disabled, and says how to turn it off', () => {
        const ui = mount();
        applyUsersConfig(ui.section, envelope({ adminScope: 'remote', remoteAdminForced: true }, false));
        expect(ui.checkbox.checked).toBe(true);
        expect(ui.checkbox.disabled).toBe(true);
        expect(ui.note.textContent).toBe(REMOTE_ADMIN_FORCED_MESSAGE);
        expect(ui.note.textContent).toBe(
            'forced on by WS_SCRCPY_ALLOW_REMOTE_ADMIN=1 on the server; remove the variable to turn it off.',
        );
        expect(ui.item.classList.contains('settings-item--alert')).toBe(true);
        expect(ui.title.textContent).toBe(REMOTE_ADMIN_ON_TITLE);
        expect(ui.store.changes()).toEqual([]);
    });

    it('sign-in on: still shown and editable, and says it is ignored until sign-in is off', () => {
        const ui = mount(ctx({ authEnabled: true }));
        applyUsersConfig(ui.section, envelope({ adminScope: 'authenticated' }, true));
        expect(ui.item.hidden).toBe(false);
        expect(ui.checkbox.checked).toBe(true);
        expect(ui.checkbox.disabled).toBe(false);
        expect(ui.note.textContent).toBe(REMOTE_ADMIN_SIGN_IN_NOTE);
        expect(ui.note.textContent).toBe('ignored while sign-in is on; it applies again if sign-in is turned off.');

        // ...so a stored `on` can be cleared before it comes back into force.
        ui.toggle(false);
        expect(ui.store.changes().map((c) => [c.id, c.to])).toEqual([[REMOTE_ADMIN_ID, false]]);
    });

    it('off on another device under the local policy: disabled, since the server would refuse the save', () => {
        const ui = mount();
        applyUsersConfig(ui.section, envelope({ adminScope: 'local', callerIsLocal: false }, false));
        expect(ui.checkbox.disabled).toBe(true);
        expect(ui.note.textContent).toBe(REMOTE_ADMIN_OFF_NOTE);
    });

    it('another device that is admin only because of it: unchecking warns that saving ends its access', () => {
        const ui = mount();
        applyUsersConfig(ui.section, envelope({ adminScope: 'remote', callerIsLocal: false }, true));
        expect(ui.checkbox.disabled).toBe(false);
        ui.toggle(false);
        expect(ui.note.textContent).toBe(REMOTE_ADMIN_OFF_BOX_WARNING);
        expect(ui.note.textContent).toBe('you are on another device: saving this ends your admin access from here.');
        expect(ui.note.classList.contains('settings-status-warning')).toBe(true);
        // ...and the review screen says it too.
        const [change] = ui.store.changes();
        expect(change?.warning).toBe(REMOTE_ADMIN_OFF_BOX_WARNING);

        // Checked again: back to the plain warning, and nothing staged.
        ui.toggle(true);
        expect(ui.note.textContent).toBe(REMOTE_ADMIN_ON_NOTE);
        expect(ui.store.changes()).toEqual([]);
    });

    it('this machine turning it off gets no off-box warning', () => {
        const ui = mount();
        applyUsersConfig(ui.section, envelope({ adminScope: 'remote', callerIsLocal: true }, true));
        ui.toggle(false);
        expect(ui.note.textContent).toBe(REMOTE_ADMIN_OFF_NOTE);
        expect(ui.store.changes()[0]?.warning).toBeUndefined();
    });
});

describe('where the admin API will not answer this page', () => {
    it('disables manage users and enable login, and says why once', () => {
        const ui = mount();
        applyUsersConfig(ui.section, envelope({ adminScope: 'local', callerIsLocal: false }, false));
        const buttons = [...ui.section.querySelectorAll<HTMLButtonElement>('button')];
        expect(buttons.map((b) => [b.textContent, b.disabled])).toEqual([
            ['manage users', true],
            ['enable login', true],
        ]);
        expect(ui.checkbox.disabled).toBe(true);
        const notes = [...ui.section.querySelectorAll<HTMLElement>('[data-admin-unreachable-note]')];
        expect(notes).toHaveLength(1);
        expect(notes[0]!.hidden).toBe(false);
        expect(notes[0]!.textContent).toBe('admin changes are limited to the machine running the server.');
    });

    it('leaves everything usable, and the note hidden, where it answers', () => {
        const ui = mount();
        applyUsersConfig(ui.section, envelope({ adminScope: 'remote', callerIsLocal: false }, true));
        expect([...ui.section.querySelectorAll<HTMLButtonElement>('button')].every((b) => !b.disabled)).toBe(true);
        expect(ui.section.querySelector<HTMLElement>('[data-admin-unreachable-note]')!.hidden).toBe(true);
    });
});

describe('remote admin without sign-in: staging', () => {
    it('unchecking stages on → off with no confirmation', () => {
        const choose = vi.spyOn(RemoteAdminWarningModal, 'choose');
        const ui = mount();
        applyUsersConfig(ui.section, envelope({ adminScope: 'remote' }, true));
        ui.toggle(false);
        expect(choose).not.toHaveBeenCalled();
        expect(ui.store.changes()).toEqual([
            {
                id: REMOTE_ADMIN_ID,
                label: REMOTE_ADMIN_LABEL,
                from: true,
                to: false,
                fromText: 'on',
                toText: 'off',
            },
        ]);
    });

    it('checking raises the warning first, and stages off → on only on its accept', async () => {
        const choose = vi.spyOn(RemoteAdminWarningModal, 'choose').mockResolvedValue('accept');
        const ui = mount();
        applyUsersConfig(ui.section, envelope({}, false));
        ui.toggle(true);
        // Unchecked while the question is open.
        expect(ui.checkbox.checked).toBe(false);
        expect(ui.store.changes()).toEqual([]);
        await flush();

        expect(choose).toHaveBeenCalledTimes(1);
        expect(ui.checkbox.checked).toBe(true);
        expect(ui.note.textContent).toBe(REMOTE_ADMIN_ON_NOTE);
        expect(ui.store.changes().map((c) => [c.id, c.fromText, c.toText])).toEqual([[REMOTE_ADMIN_ID, 'off', 'on']]);
    });

    it('a dismissed warning reverts the checkbox and stages nothing', async () => {
        vi.spyOn(RemoteAdminWarningModal, 'choose').mockResolvedValue('dismiss');
        const opened = vi.fn();
        const openChild = <T>(open: () => T): T => {
            opened();
            return open();
        };
        const ui = mount(ctx({ openChild }));
        applyUsersConfig(ui.section, envelope({}, false));
        ui.toggle(true);
        await flush();

        expect(ui.checkbox.checked).toBe(false);
        expect(ui.store.changes()).toEqual([]);
        expect(opened).not.toHaveBeenCalled();
    });

    it('"set up sign-in instead" stages nothing and opens manage users over Settings', async () => {
        vi.spyOn(RemoteAdminWarningModal, 'choose').mockResolvedValue('sign-in');
        const opened = vi.fn();
        const openChild = <T>(open: () => T): T => {
            opened();
            return open();
        };
        const ui = mount(ctx({ openChild }));
        applyUsersConfig(ui.section, envelope({}, false));
        ui.toggle(true);
        await flush();

        expect(ui.checkbox.checked).toBe(false);
        expect(ui.store.changes()).toEqual([]);
        expect(opened).toHaveBeenCalledTimes(1);
        expect(document.querySelector('dialog.users-modal')).not.toBeNull();
    });

    it('asks through the dialog, so the warning closes with Settings and reads as a dismissal', async () => {
        const askChild = vi.fn((async (_ask: () => Promise<unknown>, unanswered: unknown) => unanswered) as AskChild);
        const ui = mount(ctx({ askChild: askChild as unknown as AskChild }));
        applyUsersConfig(ui.section, envelope({}, false));
        ui.toggle(true);
        await flush();

        expect(askChild).toHaveBeenCalledTimes(1);
        expect(askChild.mock.calls[0]?.[1]).toBe('dismiss');
        expect(ui.store.changes()).toEqual([]);
    });

    it('re-checking a stored `on` after unchecking it is an undo, with no warning', () => {
        const choose = vi.spyOn(RemoteAdminWarningModal, 'choose');
        const ui = mount();
        applyUsersConfig(ui.section, envelope({ adminScope: 'remote' }, true));
        ui.toggle(false);
        ui.toggle(true);
        expect(choose).not.toHaveBeenCalled();
        expect(ui.store.changes()).toEqual([]);
    });

    it('the review screen lists it as "Remote admin without sign-in: off → on"', async () => {
        vi.spyOn(RemoteAdminWarningModal, 'choose').mockResolvedValue('accept');
        const ui = mount();
        applyUsersConfig(ui.section, envelope({}, false));
        ui.toggle(true);
        await flush();

        void SettingsSummaryModal.confirm(ui.store.changes());
        const items = [...document.querySelectorAll('.settings-summary__list li')].map((li) => li.textContent);
        expect(items).toEqual(['Remote admin without sign-in: off → on']);
        expect(document.querySelector('.settings-summary__warning')).toBeNull();
    });

    it('the review screen warns the device that is admin only because of it', () => {
        const ui = mount();
        applyUsersConfig(ui.section, envelope({ adminScope: 'remote', callerIsLocal: false }, true));
        ui.toggle(false);

        void SettingsSummaryModal.confirm(ui.store.changes());
        const items = [...document.querySelectorAll('.settings-summary__list li')].map((li) => li.textContent);
        expect(items).toEqual(['Remote admin without sign-in: on → off']);
        expect(document.querySelector('.settings-summary__warning')?.textContent).toBe(REMOTE_ADMIN_OFF_BOX_WARNING);
    });
});
