// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteAdminWarningModal } from '../RemoteAdminWarningModal';

// Same spec-realistic stub as AdminConfirmModal.test.ts: showModal() must THROW
// on a dialog that already has `open`. A silently no-op'ing stub is what let the
// double-showModal bug ship in 2026-05-21 while unit tests stayed green.
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

function button(label: string): HTMLButtonElement {
    const found = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label);
    expect(found, `button "${label}" should be in the DOM`).toBeTruthy();
    return found as HTMLButtonElement;
}

describe('RemoteAdminWarningModal', () => {
    it('resolves false when the recommended button is clicked', async () => {
        const p = RemoteAdminWarningModal.confirm();
        button('Set up sign-in instead').click();
        await expect(p).resolves.toBe(false);
    });

    it('resolves true only via the explicit accept button', async () => {
        const p = RemoteAdminWarningModal.confirm();
        button('I understand — allow remote admin').click();
        await expect(p).resolves.toBe(true);
    });

    it('gives initial focus to the recommended button, not the risky one', () => {
        void RemoteAdminWarningModal.confirm();
        expect(document.activeElement?.textContent).toBe('Set up sign-in instead');
    });

    it('does not call showModal twice — the AdminConfirmModal trap', () => {
        const spy = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
        void RemoteAdminWarningModal.confirm();
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });

    // Every dismissal path must mean "no". A mis-click or an Esc can never be
    // allowed to widen the server's exposure.
    it('resolves false on Escape', async () => {
        const p = RemoteAdminWarningModal.confirm();
        const dialog = document.querySelector('dialog') as HTMLDialogElement;
        dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
        await expect(p).resolves.toBe(false);
    });

    it('resolves false on a backdrop click', async () => {
        const p = RemoteAdminWarningModal.confirm();
        const dialog = document.querySelector('dialog') as HTMLDialogElement;
        dialog.dispatchEvent(new MouseEvent('click', { bubbles: false }));
        await expect(p).resolves.toBe(false);
    });

    it('resolves false on the close (×) button', async () => {
        const p = RemoteAdminWarningModal.confirm();
        button('×').click();
        await expect(p).resolves.toBe(false);
    });
});
