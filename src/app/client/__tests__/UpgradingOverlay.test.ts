// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { UpgradingOverlay } from '../UpgradingOverlay';

beforeAll(() => {
    // jsdom doesn't implement the top-layer dialog methods.
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.open = true;
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.open = false;
    });
});

describe('UpgradingOverlay', () => {
    it('mounts a top-layer <dialog> via showModal, swaps to timeout copy, and removes', () => {
        const spy = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
        const o = new UpgradingOverlay();
        o.mount();
        const el = document.querySelector('dialog.upgrading-overlay');
        expect(el).not.toBeNull();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(el!.textContent).toContain('updating');

        o.setState('timeout', 'http://localhost:8000/');
        expect(document.querySelector('.upgrading-overlay')!.textContent).toContain('http://localhost:8000/');

        o.remove();
        expect(document.querySelector('.upgrading-overlay')).toBeNull();
    });

    it('mount() is idempotent (no duplicate overlay)', () => {
        const o = new UpgradingOverlay();
        o.mount();
        o.mount();
        expect(document.querySelectorAll('.upgrading-overlay')).toHaveLength(1);
        o.remove();
    });
});
