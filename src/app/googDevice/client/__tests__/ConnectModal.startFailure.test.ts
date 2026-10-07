// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParamsStreamScrcpy } from '../../../../types/ParamsStreamScrcpy';
import type { BasePlayer } from '../../../player/BasePlayer';
import type VideoSettings from '../../../VideoSettings';
import { ConnectModal } from '../ConnectModal';

// The stream client throws synchronously from start() in every test here.
vi.mock('../StreamClientScrcpy', () => ({
    StreamClientScrcpy: {
        start: vi.fn(() => {
            throw new Error('device refused');
        }),
    },
}));

const params = { udid: 'abc123', hostname: '', port: 0, secure: false, pathname: '' } as ParamsStreamScrcpy;
const videoSettings = { bounds: null, bitrate: 0, maxFps: 0 } as unknown as VideoSettings;
const player = {} as BasePlayer;

function open(): ConnectModal {
    return new ConnectModal(params, player, true, videoSettings, 'Living Room TV', 'tv');
}

// A failed start is reported once, inside the modal. It must not also escape
// as an exception from the constructor: the device list and ConfigureScrcpy
// both build the modal as the last step of an async handler, so a throw there
// surfaced as an unhandled promise rejection.
describe('ConnectModal when the stream fails to start synchronously', () => {
    let closeSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        HTMLDialogElement.prototype.showModal = vi.fn();
        closeSpy = vi.fn();
        HTMLDialogElement.prototype.close = closeSpy as unknown as () => void;
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.querySelectorAll('dialog').forEach((d) => {
            d.remove();
        });
    });

    it('shows the error in the modal and the constructor does not throw', () => {
        expect(() => open()).not.toThrow();

        const errorEl = document.querySelector('dialog.connect-modal .connect-modal-error');
        expect(errorEl?.textContent).toBe('stream failed: device refused');
    });

    it('closes the modal once, after 4 seconds', () => {
        open();

        vi.advanceTimersByTime(3999);
        expect(closeSpy).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(closeSpy).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(10000);
        expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('lets the opening handler finish normally', async () => {
        // The shape of both callers (DeviceTracker's connect link and
        // ConfigureScrcpy's connect button): an async handler whose last step
        // is constructing the modal.
        const openFromHandler = async (): Promise<void> => {
            const { ConnectModal: Lazy } = await import('../ConnectModal');
            new Lazy(params, player, true, videoSettings, 'Living Room TV', 'tv');
        };

        await expect(openFromHandler()).resolves.toBeUndefined();
    });
});
