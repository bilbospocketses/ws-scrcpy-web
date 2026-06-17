// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemWideInstallModal } from '../SystemWideInstallModal';

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
    vi.restoreAllMocks();
});

function getButton(label: string): HTMLButtonElement {
    const btns = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const btn = btns.find((b) => b.textContent?.trim().toLowerCase() === label.toLowerCase());
    expect(btn, `button labeled "${label}" should be in the DOM`).toBeTruthy();
    return btn!;
}

describe('SystemWideInstallModal', () => {
    it('renders both buttons with the correct lowercase labels', async () => {
        const onInstall = vi.fn();
        const onDecline = vi.fn();
        new SystemWideInstallModal({ onInstall, onDecline });
        // Wait one microtask so the queueMicrotask body-fill runs.
        await Promise.resolve();
        getButton('yes, all users');
        getButton('no, me only');
    });

    it('clicking "yes, all users" calls onInstall', async () => {
        const onInstall = vi.fn();
        const onDecline = vi.fn();
        new SystemWideInstallModal({ onInstall, onDecline });
        await Promise.resolve();
        getButton('yes, all users').click();
        expect(onInstall).toHaveBeenCalledTimes(1);
        expect(onDecline).not.toHaveBeenCalled();
    });

    it('clicking "no, me only" calls onDecline', async () => {
        const onInstall = vi.fn();
        const onDecline = vi.fn();
        new SystemWideInstallModal({ onInstall, onDecline });
        await Promise.resolve();
        getButton('no, me only').click();
        expect(onDecline).toHaveBeenCalledTimes(1);
        expect(onInstall).not.toHaveBeenCalled();
    });

    it('clicking "yes, all users" closes the modal', async () => {
        const onInstall = vi.fn();
        const onDecline = vi.fn();
        new SystemWideInstallModal({ onInstall, onDecline });
        await Promise.resolve();
        const dialog = document.querySelector('dialog')!;
        expect(dialog.hasAttribute('open')).toBe(true);
        getButton('yes, all users').click();
        expect(dialog.hasAttribute('open')).toBe(false);
    });

    it('clicking "no, me only" closes the modal', async () => {
        const onInstall = vi.fn();
        const onDecline = vi.fn();
        new SystemWideInstallModal({ onInstall, onDecline });
        await Promise.resolve();
        const dialog = document.querySelector('dialog')!;
        expect(dialog.hasAttribute('open')).toBe(true);
        getButton('no, me only').click();
        expect(dialog.hasAttribute('open')).toBe(false);
    });

    it('body contains the required lowercase copy for both paths', async () => {
        const onInstall = vi.fn();
        const onDecline = vi.fn();
        new SystemWideInstallModal({ onInstall, onDecline });
        await Promise.resolve();
        const body = document.querySelector('.modal-body');
        const text = body?.textContent?.toLowerCase() ?? '';
        expect(text).toContain('all users');
        expect(text).toContain('/opt');
        expect(text).toContain('wherever you launch it from');
    });

    it('calls showModal exactly once', async () => {
        const spy = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
        const onInstall = vi.fn();
        const onDecline = vi.fn();
        new SystemWideInstallModal({ onInstall, onDecline });
        await Promise.resolve();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    // ── Forced choice (dismissible: false) — must click a button ──

    it('renders no × close button', async () => {
        const onInstall = vi.fn();
        const onDecline = vi.fn();
        new SystemWideInstallModal({ onInstall, onDecline });
        await Promise.resolve();
        const closeX = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '×');
        expect(closeX, 'the × close button should not be rendered').toBeUndefined();
    });

    it('Escape (cancel) does not close the modal', async () => {
        const onInstall = vi.fn();
        const onDecline = vi.fn();
        new SystemWideInstallModal({ onInstall, onDecline });
        await Promise.resolve();
        const dialog = document.querySelector('dialog')!;
        expect(dialog.hasAttribute('open')).toBe(true);
        dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
        expect(dialog.hasAttribute('open')).toBe(true);
        expect(onInstall).not.toHaveBeenCalled();
        expect(onDecline).not.toHaveBeenCalled();
    });

    it('backdrop click does not close the modal', async () => {
        const onInstall = vi.fn();
        const onDecline = vi.fn();
        new SystemWideInstallModal({ onInstall, onDecline });
        await Promise.resolve();
        const dialog = document.querySelector('dialog')!;
        expect(dialog.hasAttribute('open')).toBe(true);
        // A click whose target IS the dialog element is a backdrop click.
        dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(dialog.hasAttribute('open')).toBe(true);
        expect(onInstall).not.toHaveBeenCalled();
        expect(onDecline).not.toHaveBeenCalled();
    });
});
