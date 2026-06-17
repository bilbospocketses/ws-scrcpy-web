// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResetConfirmModal } from '../ResetConfirmModal';

// Mirror the UninstallConfirmModal test stub: showModal throws InvalidStateError
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
    const dialog = document.querySelector('dialog.reset-confirm-modal');
    expect(dialog, 'modal dialog should be in the DOM').toBeTruthy();
    return dialog as HTMLDialogElement;
}

function getButton(label: string): HTMLButtonElement {
    const btns = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const btn = btns.find((b) => b.textContent?.trim().toLowerCase() === label.toLowerCase());
    expect(btn, `button labeled "${label}" should be in the DOM`).toBeTruthy();
    return btn!;
}

describe('ResetConfirmModal.confirm', () => {
    it('confirm reset resolves true', async () => {
        const promise = ResetConfirmModal.confirm();
        await Promise.resolve();
        getButton('confirm reset').click();
        await expect(promise).resolves.toBe(true);
    });

    it('cancel resolves false', async () => {
        const promise = ResetConfirmModal.confirm();
        await Promise.resolve();
        getButton('cancel').click();
        await expect(promise).resolves.toBe(false);
    });

    it('close (×) resolves false', async () => {
        const promise = ResetConfirmModal.confirm();
        await Promise.resolve();
        const closeBtn = getDialog().querySelector<HTMLButtonElement>('.modal-close:last-child');
        expect(closeBtn, 'close button should exist').toBeTruthy();
        closeBtn!.click();
        await expect(promise).resolves.toBe(false);
    });

    it('body contains the verbatim reset copy', async () => {
        const promise = ResetConfirmModal.confirm();
        await Promise.resolve();
        const body = document.querySelector('.modal-body');
        const text = body?.textContent?.toLowerCase() ?? '';
        expect(text).toContain('this resets the welcome modal');
        expect(text).toContain('the page will reload');
        expect(text).toContain('does not affect install mode, audio preferences, or scan history');
        getButton('cancel').click();
        await promise;
    });

    it('confirm button is primary blue (settings-btn-primary, NOT danger)', async () => {
        const promise = ResetConfirmModal.confirm();
        await Promise.resolve();
        const btn = getButton('confirm reset');
        expect(btn.classList.contains('settings-btn')).toBe(true);
        expect(btn.classList.contains('settings-btn-primary')).toBe(true);
        expect(btn.classList.contains('settings-btn-danger-outline')).toBe(false);
        getButton('cancel').click();
        await promise;
    });

    it('cancel button is neutral (settings-btn, no primary/danger)', async () => {
        const promise = ResetConfirmModal.confirm();
        await Promise.resolve();
        const btn = getButton('cancel');
        expect(btn.classList.contains('settings-btn')).toBe(true);
        expect(btn.classList.contains('settings-btn-primary')).toBe(false);
        expect(btn.classList.contains('settings-btn-danger-outline')).toBe(false);
        btn.click();
        await promise;
    });

    it('calls showModal exactly once', async () => {
        const spy = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
        const promise = ResetConfirmModal.confirm();
        await Promise.resolve();
        expect(spy).toHaveBeenCalledTimes(1);
        getButton('cancel').click();
        await promise;
        spy.mockRestore();
    });

    it('resolves only once even if multiple close paths fire', async () => {
        const promise = ResetConfirmModal.confirm();
        await Promise.resolve();
        getButton('confirm reset').click();
        getButton('cancel').click();
        await expect(promise).resolves.toBe(true);
    });
});
