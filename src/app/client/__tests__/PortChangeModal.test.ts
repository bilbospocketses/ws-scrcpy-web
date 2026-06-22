// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmModal } from '../ConfirmModal';
import { PortChangeModal } from '../PortChangeModal';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
    vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve({ ok: true } as Response)),
    );
});

afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function checkboxes(): HTMLInputElement[] {
    return Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
}
function gotIt(): HTMLButtonElement {
    const btn = (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]).find(
        (b) => b.textContent?.trim().toLowerCase() === 'got it',
    );
    expect(btn, 'got it button').toBeTruthy();
    return btn!;
}
function fetchMock(): ReturnType<typeof vi.fn> {
    return fetch as unknown as ReturnType<typeof vi.fn>;
}

describe('PortChangeModal global-dismiss (#5c)', () => {
    it('renders both the per-port and the global checkbox', async () => {
        new PortChangeModal({ webPort: 8000 });
        await flush();
        expect(checkboxes().length).toBe(2);
        const body = document.querySelector('.port-change-modal .modal-body')?.textContent?.toLowerCase() ?? '';
        expect(body).toContain('for this port');
        expect(body).toContain('ever, even when the port changes');
    });

    it('checking the global box disables the per-port box', async () => {
        new PortChangeModal({ webPort: 8000 });
        await flush();
        const boxes = checkboxes();
        const perPort = boxes[0]!;
        const global = boxes[1]!;
        global.checked = true;
        global.dispatchEvent(new Event('change'));
        expect(perPort.disabled).toBe(true);
    });

    it('global-checked + confirmed PATCHes bookmarkDismissedGlobally:true to /api/settings', async () => {
        const confirmSpy = vi.spyOn(ConfirmModal, 'confirm').mockResolvedValue(true);
        // settingsService.patchGlobal → fetch('/api/settings', { method: 'PATCH', ... })
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response)),
        );
        new PortChangeModal({ webPort: 8000 });
        await flush();
        const global = checkboxes()[1]!;
        global.checked = true;
        global.dispatchEvent(new Event('change'));
        gotIt().click();
        await flush();
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        const lastCall = fetchMock().mock.calls.at(-1);
        expect(lastCall?.[0]).toBe('/api/settings');
        expect(JSON.parse((lastCall?.[1] as RequestInit).body as string)).toEqual({ bookmarkDismissedGlobally: true });
    });

    it('global-checked + cancelled does NOT PATCH and keeps the modal open', async () => {
        vi.spyOn(ConfirmModal, 'confirm').mockResolvedValue(false);
        new PortChangeModal({ webPort: 8000 });
        await flush();
        const global = checkboxes()[1]!;
        global.checked = true;
        global.dispatchEvent(new Event('change'));
        gotIt().click();
        await flush();
        expect(fetchMock()).not.toHaveBeenCalled();
        expect(document.querySelector('dialog.port-change-modal')?.hasAttribute('open')).toBe(true);
    });

    it('per-port only (global unchecked) PATCHes bookmarkDismissedForPort to /api/settings', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response)),
        );
        new PortChangeModal({ webPort: 8000 });
        await flush();
        const perPort = checkboxes()[0]!;
        perPort.checked = true;
        gotIt().click();
        await flush();
        const lastCall = fetchMock().mock.calls.at(-1);
        expect(lastCall?.[0]).toBe('/api/settings');
        expect(JSON.parse((lastCall?.[1] as RequestInit).body as string)).toEqual({ bookmarkDismissedForPort: 8000 });
    });
});
