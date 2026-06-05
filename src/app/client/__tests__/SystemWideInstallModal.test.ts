// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
        getButton('install for all users');
        getButton('not now');
    });

    it('clicking "install for all users" calls onInstall', async () => {
        const onInstall = vi.fn();
        const onDecline = vi.fn();
        new SystemWideInstallModal({ onInstall, onDecline });
        await Promise.resolve();
        getButton('install for all users').click();
        expect(onInstall).toHaveBeenCalledTimes(1);
        expect(onDecline).not.toHaveBeenCalled();
    });

    it('clicking "not now" calls onDecline', async () => {
        const onInstall = vi.fn();
        const onDecline = vi.fn();
        new SystemWideInstallModal({ onInstall, onDecline });
        await Promise.resolve();
        getButton('not now').click();
        expect(onDecline).toHaveBeenCalledTimes(1);
        expect(onInstall).not.toHaveBeenCalled();
    });

    it('clicking "install for all users" closes the modal', async () => {
        const onInstall = vi.fn();
        const onDecline = vi.fn();
        new SystemWideInstallModal({ onInstall, onDecline });
        await Promise.resolve();
        const dialog = document.querySelector('dialog')!;
        expect(dialog.hasAttribute('open')).toBe(true);
        getButton('install for all users').click();
        expect(dialog.hasAttribute('open')).toBe(false);
    });

    it('clicking "not now" closes the modal', async () => {
        const onInstall = vi.fn();
        const onDecline = vi.fn();
        new SystemWideInstallModal({ onInstall, onDecline });
        await Promise.resolve();
        const dialog = document.querySelector('dialog')!;
        expect(dialog.hasAttribute('open')).toBe(true);
        getButton('not now').click();
        expect(dialog.hasAttribute('open')).toBe(false);
    });

    it('body contains the required lowercase copy', async () => {
        const onInstall = vi.fn();
        const onDecline = vi.fn();
        new SystemWideInstallModal({ onInstall, onDecline });
        await Promise.resolve();
        const body = document.querySelector('.modal-body');
        const text = body?.textContent?.toLowerCase() ?? '';
        expect(text).toContain('all users');
        expect(text).toContain('/opt');
    });

    it('calls showModal exactly once', async () => {
        const spy = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
        const onInstall = vi.fn();
        const onDecline = vi.fn();
        new SystemWideInstallModal({ onInstall, onDecline });
        await Promise.resolve();
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
