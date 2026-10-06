// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParamsStreamScrcpy } from '../../../../types/ParamsStreamScrcpy';
import type { BasePlayer } from '../../../player/BasePlayer';
import type { StartStreamOptions } from '../../../public/types';
import type VideoSettings from '../../../VideoSettings';
import { ConnectModal } from '../ConnectModal';

// startStream is the modal's only link to a real stream: capture the callbacks
// it is handed so a test can play the stream's side.
const stream = vi.hoisted(() => ({
    options: undefined as StartStreamOptions | undefined,
    stop: undefined as ReturnType<typeof vi.fn> | undefined,
}));
vi.mock('../../../public/startStream', () => ({
    startStream: vi.fn((_container: HTMLElement, deviceId: string, options: StartStreamOptions) => {
        stream.options = options;
        stream.stop = vi.fn();
        return { stop: stream.stop, isConnected: false, deviceId };
    }),
}));

/**
 * A stream error shows `stream failed: …` and closes the modal 4 s later.
 * Closing it with × inside that window used to leave the timer armed, so the
 * modal closed a second time when it fired.
 */

function openModal(): ConnectModal {
    const params = { udid: 'serial-1', hostname: '', port: 0 } as unknown as ParamsStreamScrcpy;
    const videoSettings = { bounds: null, bitrate: 0, maxFps: 0 } as unknown as VideoSettings;
    return new ConnectModal(params, {} as BasePlayer, true, videoSettings, 'Pixel');
}

function closeButton(modal: ConnectModal): HTMLElement {
    const buttons = modal['dialog'].querySelectorAll('.modal-close');
    return buttons[buttons.length - 1] as HTMLElement;
}

describe('ConnectModal stream error closes the modal once', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        HTMLDialogElement.prototype.showModal = vi.fn();
        HTMLDialogElement.prototype.close = vi.fn();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        stream.options = undefined;
        stream.stop = undefined;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        document.body.querySelectorAll('dialog').forEach((d) => {
            d.remove();
        });
    });

    it('shows the error and closes once after 4 s when the user does nothing', () => {
        const modal = openModal();
        stream.options?.onError?.(new Error('device went away'));
        expect(modal['bodyEl'].textContent).toBe('stream failed: device went away');

        vi.advanceTimersByTime(3999);
        expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);
        expect(stream.stop).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(5000);
        expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);
        expect(document.body.contains(modal['dialog'])).toBe(false);
    });

    it('closing with × during the 4 s does not close the modal again when the timer would have fired', () => {
        const modal = openModal();
        stream.options?.onError?.(new Error('device went away'));
        vi.advanceTimersByTime(1000);

        closeButton(modal).click();
        expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);
        expect(stream.stop).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(5000);
        expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);
        expect(stream.stop).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    // An abnormal socket close reaches the modal as onDisconnect (which closes
    // it) and then onError (which schedules the 4 s close) — the order
    // StreamClientScrcpy.onDisconnected calls them in.
    it('a disconnect followed by an error closes the modal once', () => {
        openModal();
        stream.options?.onDisconnect?.();
        stream.options?.onError?.(new Error('WebSocket closed with code 1006'));
        expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(5000);
        expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    // Closing with × stops the stream, and the stopped socket's close event
    // arrives later as onDisconnect.
    it('a disconnect arriving after × does not close the modal again', () => {
        const modal = openModal();
        closeButton(modal).click();
        stream.options?.onDisconnect?.();
        expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);
        expect(stream.stop).toHaveBeenCalledTimes(1);
    });
});
