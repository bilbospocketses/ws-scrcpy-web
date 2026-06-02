// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfirmModal } from '../ConfirmModal';

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
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

function button(label: string): HTMLButtonElement {
    const btn = (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[])
        .find((b) => b.textContent?.trim().toLowerCase() === label.toLowerCase());
    expect(btn, `button "${label}"`).toBeTruthy();
    return btn!;
}

describe('ConfirmModal.confirm', () => {
    it('resolves true when ok is clicked', async () => {
        const p = ConfirmModal.confirm({ title: 't', message: 'm' });
        await Promise.resolve();
        button('ok').click();
        await expect(p).resolves.toBe(true);
    });

    it('resolves false when cancel is clicked', async () => {
        const p = ConfirmModal.confirm({ title: 't', message: 'm' });
        await Promise.resolve();
        button('cancel').click();
        await expect(p).resolves.toBe(false);
    });

    it('renders the message body', async () => {
        const p = ConfirmModal.confirm({ title: 't', message: 'hello-confirm-body' });
        await Promise.resolve();
        expect(document.querySelector('.confirm-modal .modal-body')?.textContent).toContain('hello-confirm-body');
        button('cancel').click();
        await p;
    });
});
