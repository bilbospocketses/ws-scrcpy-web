// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListFilesModal } from '../ListFilesModal';

// A saved icon size sends the modal straight to the file browser, which builds
// the WebSocket URL and, for a malformed host, takes the connect-error path.
vi.mock('../../../client/SettingsService', () => ({
    settingsService: {
        loadGlobal: async () => {},
        getGlobalCached: () => ({ iconSize: 24 }),
    },
}));

/**
 * A malformed device host makes `showConnectError` show `connection failed: …`
 * and close the modal 4 s later. Closing it with × inside that window used to
 * leave the timer armed, so the modal closed a second time when it fired.
 */

const BAD_HOST = { hostname: 'bad host', port: 8000 };

async function openWithConnectError(): Promise<ListFilesModal> {
    const modal = new ListFilesModal('serial-1', 'Pixel', BAD_HOST);
    // The file browser opens after an async settings read (a dynamic import
    // and an await); let those settle without advancing the fake clock.
    await vi.dynamicImportSettled();
    for (let i = 0; i < 10 && !modal['bodyEl'].querySelector('.list-files-modal-error'); i++) {
        await Promise.resolve();
    }
    expect(modal['bodyEl'].textContent).toContain('connection failed: refusing to open WebSocket');
    return modal;
}

function closeButton(modal: ListFilesModal): HTMLElement {
    const buttons = modal['dialog'].querySelectorAll('.modal-close');
    return buttons[buttons.length - 1] as HTMLElement;
}

describe('ListFilesModal connect error closes the modal once', () => {
    let beforeClose: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.useFakeTimers();
        HTMLDialogElement.prototype.showModal = vi.fn();
        HTMLDialogElement.prototype.close = vi.fn();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        beforeClose = vi.spyOn(ListFilesModal.prototype as any, 'onBeforeClose');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        document.body.querySelectorAll('dialog').forEach((d) => {
            d.remove();
        });
    });

    it('shows the error and closes once after 4 s when the user does nothing', async () => {
        const modal = await openWithConnectError();

        vi.advanceTimersByTime(3999);
        expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(5000);
        expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);
        expect(beforeClose).toHaveBeenCalledTimes(1);
        expect(document.body.contains(modal['dialog'])).toBe(false);
    });

    it('closing with × during the 4 s does not close the modal again when the timer would have fired', async () => {
        const modal = await openWithConnectError();
        vi.advanceTimersByTime(1000);

        closeButton(modal).click();
        expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);
        expect(beforeClose).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(5000);
        expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);
        expect(beforeClose).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});
