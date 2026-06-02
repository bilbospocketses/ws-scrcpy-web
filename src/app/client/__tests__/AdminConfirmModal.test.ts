// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AdminConfirmModal } from '../AdminConfirmModal';

// JSDOM doesn't implement HTMLDialogElement.showModal() by default; stub
// it WITH the spec's InvalidStateError throw when called on a dialog that
// already has the `open` attribute. Pre-2026-05-21 the stub silently
// no-op'd the second call, which masked a real-browser bug:
// AdminConfirmModal.confirm() used to fire showModal() twice (once via
// the Modal base-class constructor, once explicitly afterwards). In a
// real browser the second call threw, the Promise rejected, and the
// Continue/Cancel handlers silently no-op'd (calling resolve() on an
// already-rejected promise). Spec link:
//   https://html.spec.whatwg.org/multipage/interactive-elements.html#dom-dialog-showmodal
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
    // Clear any modal/dialog elements left over between tests. Use
    // replaceChildren() rather than innerHTML to satisfy the security-
    // reminder hook (innerHTML with strings is flagged even when empty).
    document.body.replaceChildren();
});

function getDialog(): HTMLDialogElement {
    const dialog = document.querySelector('dialog.admin-confirm-modal');
    expect(dialog, 'modal dialog should be in the DOM').toBeTruthy();
    return dialog as HTMLDialogElement;
}

function getButton(label: string): HTMLButtonElement {
    const btns = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const btn = btns.find((b) => b.textContent?.trim().toLowerCase() === label.toLowerCase());
    expect(btn, `button labeled "${label}" should be in the DOM`).toBeTruthy();
    return btn!;
}

describe('AdminConfirmModal.confirm', () => {
    it('resolves true when Continue is clicked', async () => {
        const promise = AdminConfirmModal.confirm({ action: 'install service' });
        // Wait one microtask so the queueMicrotask body-fill runs.
        await Promise.resolve();
        getButton('continue').click();
        await expect(promise).resolves.toBe(true);
    });

    it('resolves false when Cancel is clicked', async () => {
        const promise = AdminConfirmModal.confirm({ action: 'uninstall service' });
        await Promise.resolve();
        getButton('cancel').click();
        await expect(promise).resolves.toBe(false);
    });

    it('resolves false when Esc is pressed', async () => {
        const promise = AdminConfirmModal.confirm({ action: 'install service' });
        await Promise.resolve();
        const dialog = getDialog();
        const cancelEvent = new Event('cancel', { cancelable: true });
        dialog.dispatchEvent(cancelEvent);
        await expect(promise).resolves.toBe(false);
    });

    it('resolves false when backdrop is clicked', async () => {
        const promise = AdminConfirmModal.confirm({ action: 'install service' });
        await Promise.resolve();
        const dialog = getDialog();
        // Backdrop click = click event whose target is the dialog element itself
        // (not a child). The Modal base class checks e.target === this.dialog.
        const clickEvent = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(clickEvent, 'target', { value: dialog });
        dialog.dispatchEvent(clickEvent);
        await expect(promise).resolves.toBe(false);
    });

    it('resolves only once even if multiple close paths fire', async () => {
        const promise = AdminConfirmModal.confirm({ action: 'install service' });
        await Promise.resolve();
        getButton('continue').click();
        // Subsequent close paths must not flip the resolution.
        getButton('cancel').click();
        await expect(promise).resolves.toBe(true);
    });

    it('renders action-specific copy in the body', async () => {
        const promise = AdminConfirmModal.confirm({ action: 'uninstall service' });
        await Promise.resolve();
        const body = document.querySelector('.modal-body');
        expect(body?.textContent?.toLowerCase()).toContain('uninstall service');
        // Resolve so the test cleans up.
        getButton('cancel').click();
        await promise;
    });

    // Regression for the 2026-05-21 fix: confirm() must call showModal()
    // exactly ONCE. Pre-fix the method invoked showModal() twice (once via
    // the Modal base-class constructor, once explicitly), which threw
    // InvalidStateError on the second call in real browsers, rejecting the
    // Promise and silently breaking the Continue/Cancel handlers. Settings →
    // install was broken; Welcome modal worked because it bypasses
    // AdminConfirmModal and calls /api/service/install directly.
    it('calls showModal exactly once (no double-show throw)', async () => {
        const spy = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
        const promise = AdminConfirmModal.confirm({ action: 'install service' });
        await Promise.resolve();
        expect(spy).toHaveBeenCalledTimes(1);
        // The Promise must still resolve normally on Continue.
        getButton('continue').click();
        await expect(promise).resolves.toBe(true);
        spy.mockRestore();
    });

    it('styles both footer buttons with the shared white-outline .modal-button class', async () => {
        const promise = AdminConfirmModal.confirm({ action: 'install service' });
        await Promise.resolve();
        expect(getButton('continue').classList.contains('modal-button')).toBe(true);
        expect(getButton('cancel').classList.contains('modal-button')).toBe(true);
        getButton('cancel').click();
        await promise;
    });
});
