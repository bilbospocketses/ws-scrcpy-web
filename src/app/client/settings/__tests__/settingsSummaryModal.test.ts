// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsSummaryModal } from '../SettingsSummaryModal';

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        if (this.hasAttribute('open')) {
            throw new DOMException('already open', 'InvalidStateError');
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

const CHANGES = [
    { id: 'channel', label: 'Update channel', from: 'stable', to: 'beta' },
    { id: 'webPort', label: 'Web port', from: 8000, to: 8010 },
];

function button(label: string): HTMLButtonElement {
    const found = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label);
    expect(found, `button "${label}"`).toBeTruthy();
    return found as HTMLButtonElement;
}

describe('SettingsSummaryModal', () => {
    it('lists every change as label: from → to', () => {
        void SettingsSummaryModal.confirm(CHANGES);
        const text = document.querySelector('dialog')?.textContent ?? '';
        expect(text).toContain('Update channel');
        expect(text).toContain('stable');
        expect(text).toContain('beta');
    });

    it('warns that a webPort change restarts the server', () => {
        void SettingsSummaryModal.confirm(CHANGES);
        expect(document.querySelector('dialog')?.textContent).toContain('restart');
    });

    it('does NOT warn about a restart when the port did not change', () => {
        void SettingsSummaryModal.confirm([CHANGES[0]!]);
        expect(document.querySelector('dialog')?.textContent).not.toContain('restart');
    });

    it('resolves true only via Save', async () => {
        const p = SettingsSummaryModal.confirm(CHANGES);
        button('Save').click();
        await expect(p).resolves.toBe(true);
    });

    it('resolves false on Cancel', async () => {
        const p = SettingsSummaryModal.confirm(CHANGES);
        button('Cancel').click();
        await expect(p).resolves.toBe(false);
    });

    it('does not call showModal twice — the AdminConfirmModal trap', () => {
        const spy = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
        void SettingsSummaryModal.confirm(CHANGES);
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });
});
