// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellModal } from '../ShellModal';

// The connect-error path never builds a terminal; stub xterm so importing the
// modal does not pull a canvas renderer into jsdom.
vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn() }));
vi.mock('@xterm/addon-attach', () => ({ AttachAddon: vi.fn() }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn() }));

/**
 * A malformed device host makes `showConnectError` show `connection failed: …`
 * and close the modal 4 s later. Closing it with × inside that window used to
 * leave the timer armed, so the modal closed a second time when it fired.
 */

// A hostname `buildMultiplexUrl` refuses, so the constructor takes the error path.
const BAD_HOST = { hostname: 'bad host', port: 8000 };

function closeButton(modal: ShellModal): HTMLElement {
    const buttons = modal['dialog'].querySelectorAll('.modal-close');
    return buttons[buttons.length - 1] as HTMLElement;
}

describe('ShellModal connect error closes the modal once', () => {
    let beforeClose: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.useFakeTimers();
        HTMLDialogElement.prototype.showModal = vi.fn();
        HTMLDialogElement.prototype.close = vi.fn();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        beforeClose = vi.spyOn(ShellModal.prototype as any, 'onBeforeClose');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        document.body.querySelectorAll('dialog').forEach((d) => {
            d.remove();
        });
    });

    it('shows the error and closes once after 4 s when the user does nothing', () => {
        const modal = new ShellModal('serial-1', 'Pixel', BAD_HOST);
        expect(modal['bodyEl'].textContent).toContain('connection failed: refusing to open WebSocket');

        vi.advanceTimersByTime(3999);
        expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(5000);
        expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);
        expect(beforeClose).toHaveBeenCalledTimes(1);
        expect(document.body.contains(modal['dialog'])).toBe(false);
    });

    it('closing with × during the 4 s does not close the modal again when the timer would have fired', () => {
        const modal = new ShellModal('serial-1', 'Pixel', BAD_HOST);
        vi.advanceTimersByTime(1000);

        closeButton(modal).click();
        expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);
        expect(beforeClose).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(5000);
        expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);
        expect(beforeClose).toHaveBeenCalledTimes(1);
        // Nothing left to run against the torn-down modal.
        expect(vi.getTimerCount()).toBe(0);
    });
});
