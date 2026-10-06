// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsDirtyCloseModal } from '../../client/SettingsModal';
import { ShellCloseConfirmModal } from '../../client/ShellCloseConfirmModal';
import { SettingsSummaryModal } from '../../client/settings/SettingsSummaryModal';
import { Modal } from '../Modal';

/**
 * The base mechanism behind "a child dialog never outlives the modal that
 * opened it": `openChild` binds a child to its parent, the parent's close()
 * closes it, and `askChild` turns an answer the parent can no longer act on
 * into the caller's own "no answer".
 */

class Plain extends Modal {
    constructor(title = 'plain') {
        super({ title });
    }
    protected buildBody(): void {}
}

/** A parent that exposes the protected helpers to the test. */
class Parent extends Plain {
    public open<T>(open: () => T): T {
        return this.openChild(open);
    }
    public ask<T>(ask: () => Promise<T>, unanswered: T): Promise<T> {
        return this.askChild(ask, unanswered);
    }
}

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('Modal.openChild', () => {
    it("closes an open child when the parent closes, before the parent's own teardown", () => {
        const parent = new Parent();
        const child = parent.open(() => new Plain('child'));
        const order: string[] = [];
        vi.spyOn(child, 'close').mockImplementation(() => order.push('child'));
        vi.spyOn(parent as unknown as { onBeforeClose: () => void }, 'onBeforeClose').mockImplementation(() =>
            order.push('parent'),
        );

        parent.close();

        expect(order).toEqual(['child', 'parent']);
    });

    it('does not close a child a second time once it has closed on its own', () => {
        const parent = new Parent();
        const child = parent.open(() => new Plain('child'));
        child.close();
        const again = vi.spyOn(child, 'close');

        parent.close();

        expect(again).not.toHaveBeenCalled();
    });

    it('binds only modals built inside the opener, not ones opened later elsewhere', () => {
        const parent = new Parent();
        parent.open(() => new Plain('child'));
        const stranger = new Plain('stranger');
        const strangerClose = vi.spyOn(stranger, 'close');

        parent.close();

        expect(strangerClose).not.toHaveBeenCalled();
    });

    it('closes at once a child opened after the parent has closed', () => {
        const parent = new Parent();
        parent.close();
        const late = parent.open(() => new Plain('late'));
        expect(late['dialog'].hasAttribute('open')).toBe(false);
    });
});

describe('Modal.askChild', () => {
    it("settles to the caller's no-answer when the parent closes first", async () => {
        const parent = new Parent();
        const answer = parent.ask(() => ShellCloseConfirmModal.confirm(), false);
        parent.close();
        await expect(answer).resolves.toBe(false);
    });

    it('maps an answer that lands after the parent closed to no-answer', async () => {
        const parent = new Parent();
        let resolveChild!: (v: boolean) => void;
        const answer = parent.ask(() => new Promise<boolean>((r) => (resolveChild = r)), false);
        resolveChild(true);
        parent.close();
        await expect(answer).resolves.toBe(false);
    });

    it('passes a normal answer straight through', async () => {
        const parent = new Parent();
        let resolveChild!: (v: string) => void;
        const answer = parent.ask(() => new Promise<string>((r) => (resolveChild = r)), 'cancel');
        resolveChild('discard');
        await expect(answer).resolves.toBe('discard');
    });
});

describe('promise-answering children settle when closed without an answer', () => {
    // Closed by a parent, these must not leave the awaiting caller hanging.
    it('ShellCloseConfirmModal resolves false', async () => {
        const parent = new Parent();
        const answer = parent.open(() => ShellCloseConfirmModal.confirm());
        parent.close();
        await expect(answer).resolves.toBe(false);
    });

    it('SettingsSummaryModal resolves false', async () => {
        const parent = new Parent();
        const answer = parent.open(() =>
            SettingsSummaryModal.confirm([{ id: 'webPort', label: 'Web port', from: 1, to: 2 }]),
        );
        parent.close();
        await expect(answer).resolves.toBe(false);
    });

    it('SettingsDirtyCloseModal resolves cancel', async () => {
        const parent = new Parent();
        const answer = parent.open(() => SettingsDirtyCloseModal.choose());
        parent.close();
        await expect(answer).resolves.toBe('cancel');
    });
});
