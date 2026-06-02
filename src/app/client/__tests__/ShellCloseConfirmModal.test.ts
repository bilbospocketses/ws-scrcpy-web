// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ShellCloseConfirmModal } from '../ShellCloseConfirmModal';

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
    const dialog = document.querySelector('dialog.shell-close-confirm-modal');
    expect(dialog, 'modal dialog should be in the DOM').toBeTruthy();
    return dialog as HTMLDialogElement;
}

function getButton(label: string): HTMLButtonElement {
    const btns = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const btn = btns.find((b) => b.textContent?.trim().toLowerCase() === label.toLowerCase());
    expect(btn, `button labeled "${label}" should be in the DOM`).toBeTruthy();
    return btn!;
}

describe('ShellCloseConfirmModal.confirm', () => {
    it('resolves true when close is clicked', async () => {
        const promise = ShellCloseConfirmModal.confirm();
        await Promise.resolve();
        getButton('close').click();
        await expect(promise).resolves.toBe(true);
    });

    it('resolves false when cancel is clicked', async () => {
        const promise = ShellCloseConfirmModal.confirm();
        await Promise.resolve();
        getButton('cancel').click();
        await expect(promise).resolves.toBe(false);
    });

    it('resolves false when Esc is pressed', async () => {
        const promise = ShellCloseConfirmModal.confirm();
        await Promise.resolve();
        const dialog = getDialog();
        const cancelEvent = new Event('cancel', { cancelable: true });
        dialog.dispatchEvent(cancelEvent);
        await expect(promise).resolves.toBe(false);
    });

    it('resolves false when backdrop is clicked', async () => {
        const promise = ShellCloseConfirmModal.confirm();
        await Promise.resolve();
        const dialog = getDialog();
        const clickEvent = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(clickEvent, 'target', { value: dialog });
        dialog.dispatchEvent(clickEvent);
        await expect(promise).resolves.toBe(false);
    });

    it('resolves only once even if multiple close paths fire', async () => {
        const promise = ShellCloseConfirmModal.confirm();
        await Promise.resolve();
        getButton('close').click();
        getButton('cancel').click();
        await expect(promise).resolves.toBe(true);
    });

    it('renders warning text in the body', async () => {
        const promise = ShellCloseConfirmModal.confirm();
        await Promise.resolve();
        const body = document.querySelector('.modal-body');
        expect(body?.textContent?.toLowerCase()).toContain('ending the shell session');
        expect(body?.textContent?.toLowerCase()).toContain('close anyway?');
        getButton('cancel').click();
        await promise;
    });

    it('calls showModal exactly once', async () => {
        const spy = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
        const promise = ShellCloseConfirmModal.confirm();
        await Promise.resolve();
        expect(spy).toHaveBeenCalledTimes(1);
        getButton('close').click();
        await expect(promise).resolves.toBe(true);
        spy.mockRestore();
    });

    it('styles both footer buttons with the shared white-outline .modal-button class', async () => {
        const promise = ShellCloseConfirmModal.confirm();
        await Promise.resolve();
        expect(getButton('close').classList.contains('modal-button')).toBe(true);
        expect(getButton('cancel').classList.contains('modal-button')).toBe(true);
        getButton('cancel').click();
        await promise;
    });
});
