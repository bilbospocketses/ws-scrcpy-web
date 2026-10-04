// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UninstallConfirmModal, WINDOWS_CA_KEPT_NOTE } from '../UninstallConfirmModal';

// Mirror the AdminConfirmModal test stub: showModal throws InvalidStateError
// if the dialog already has the 'open' attribute (spec-realistic).
beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        if (this.hasAttribute('open')) {
            throw new DOMException(
                "Failed to execute 'showModal' on 'HTMLDialogElement': The element already has an 'open' attribute, and therefore cannot be opened modally.",
                'InvalidStateError',
            );
        }
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
});

afterEach(() => {
    document.body.replaceChildren();
});

function getDialog(): HTMLDialogElement {
    const dialog = document.querySelector('dialog.uninstall-confirm-modal');
    expect(dialog, 'modal dialog should be in the DOM').toBeTruthy();
    return dialog as HTMLDialogElement;
}

function getButton(label: string): HTMLButtonElement {
    const btns = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const btn = btns.find((b) => b.textContent?.trim().toLowerCase() === label.toLowerCase());
    expect(btn, `button labeled "${label}" should be in the DOM`).toBeTruthy();
    return btn!;
}

function getCheckbox(): HTMLInputElement {
    const dialog = getDialog();
    const cb = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(cb, 'keep checkbox should be in the DOM').toBeTruthy();
    return cb!;
}

describe('UninstallConfirmModal.confirm', () => {
    it('checkbox defaults to checked', async () => {
        const promise = UninstallConfirmModal.confirm();
        await Promise.resolve();
        const cb = getCheckbox();
        expect(cb.checked).toBe(true);
        getButton('cancel').click();
        await promise;
    });

    it('cancel resolves { confirmed: false, keep: true } when checkbox is still checked', async () => {
        const promise = UninstallConfirmModal.confirm();
        await Promise.resolve();
        // checkbox is checked by default
        getButton('cancel').click();
        await expect(promise).resolves.toEqual({ confirmed: false, keep: true });
    });

    it('uncheck then uninstall resolves { confirmed: true, keep: false }', async () => {
        const promise = UninstallConfirmModal.confirm();
        await Promise.resolve();
        const cb = getCheckbox();
        cb.checked = false;
        getButton('uninstall').click();
        await expect(promise).resolves.toEqual({ confirmed: true, keep: false });
    });

    it('uninstall with keep still checked resolves { confirmed: true, keep: true }', async () => {
        const promise = UninstallConfirmModal.confirm();
        await Promise.resolve();
        // checkbox is checked by default
        getButton('uninstall').click();
        await expect(promise).resolves.toEqual({ confirmed: true, keep: true });
    });

    it('body contains the expected copy', async () => {
        const promise = UninstallConfirmModal.confirm();
        await Promise.resolve();
        const body = document.querySelector('.modal-body');
        expect(body?.textContent?.toLowerCase()).toContain('removes the app');
        getButton('cancel').click();
        await promise;
    });

    it('uninstall button has class settings-btn-danger-outline', async () => {
        const promise = UninstallConfirmModal.confirm();
        await Promise.resolve();
        const btn = getButton('uninstall');
        expect(btn.classList.contains('settings-btn-danger-outline')).toBe(true);
        getButton('cancel').click();
        await promise;
    });

    it('uninstall button also has class settings-btn', async () => {
        const promise = UninstallConfirmModal.confirm();
        await Promise.resolve();
        const btn = getButton('uninstall');
        expect(btn.classList.contains('settings-btn')).toBe(true);
        getButton('cancel').click();
        await promise;
    });

    it('cancel button has class settings-btn (white outline, no danger)', async () => {
        const promise = UninstallConfirmModal.confirm();
        await Promise.resolve();
        const btn = getButton('cancel');
        expect(btn.classList.contains('settings-btn')).toBe(true);
        expect(btn.classList.contains('settings-btn-danger-outline')).toBe(false);
        btn.click();
        await promise;
    });

    it('cancel button has class uninstall-cancel', async () => {
        const promise = UninstallConfirmModal.confirm();
        await Promise.resolve();
        const btn = getButton('cancel');
        expect(btn.classList.contains('uninstall-cancel')).toBe(true);
        btn.click();
        await promise;
    });

    it('uninstall button has class uninstall-confirm', async () => {
        const promise = UninstallConfirmModal.confirm();
        await Promise.resolve();
        const btn = getButton('uninstall');
        expect(btn.classList.contains('uninstall-confirm')).toBe(true);
        getButton('cancel').click();
        await promise;
    });

    it('calls showModal exactly once', async () => {
        const spy = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
        const promise = UninstallConfirmModal.confirm();
        await Promise.resolve();
        expect(spy).toHaveBeenCalledTimes(1);
        getButton('cancel').click();
        await promise;
        spy.mockRestore();
    });

    it('resolves only once even if multiple close paths fire', async () => {
        const promise = UninstallConfirmModal.confirm();
        await Promise.resolve();
        getButton('uninstall').click();
        getButton('cancel').click();
        await expect(promise).resolves.toEqual({ confirmed: true, keep: true });
    });
});

describe('UninstallConfirmModal kept-CA note', () => {
    function getCaNote(): HTMLElement | null {
        return getDialog().querySelector<HTMLElement>('.uninstall-ca-note');
    }

    function setKeep(checked: boolean): void {
        const cb = getCheckbox();
        cb.checked = checked;
        cb.dispatchEvent(new Event('change'));
    }

    it('on Windows, is hidden while keep is checked and shown once it is unchecked', async () => {
        const promise = UninstallConfirmModal.confirm({ platform: 'win32' });
        await Promise.resolve();
        const note = getCaNote();
        expect(note).toBeTruthy();
        expect(note!.hidden).toBe(true);

        setKeep(false);
        expect(note!.hidden).toBe(false);
        expect(note!.textContent).toBe(WINDOWS_CA_KEPT_NOTE);

        setKeep(true);
        expect(note!.hidden).toBe(true);

        getButton('cancel').click();
        await promise;
    });

    it('names the folder and how to remove it, in lowercase', () => {
        expect(WINDOWS_CA_KEPT_NOTE).toBe(
            'the local https certificate authority is kept, in %LOCALAPPDATA%\\WsScrcpyWeb-tls, ' +
                'so devices that already trust it keep trusting a reinstall. delete that folder to remove it.',
        );
    });

    it.each([
        ['linux', 'linux' as const],
        ['an unknown platform', undefined],
    ])('is not rendered on %s, even with keep unchecked', async (_label, platform) => {
        const promise = UninstallConfirmModal.confirm({ platform });
        await Promise.resolve();
        setKeep(false);
        expect(getCaNote()).toBeNull();
        expect(getDialog().textContent).not.toContain('certificate authority');
        getButton('cancel').click();
        await promise;
    });

    it('does not change what confirm resolves with', async () => {
        const promise = UninstallConfirmModal.confirm({ platform: 'win32' });
        await Promise.resolve();
        setKeep(false);
        getButton('uninstall').click();
        await expect(promise).resolves.toEqual({ confirmed: true, keep: false });
    });
});
