// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParamsStreamScrcpy } from '../../../../types/ParamsStreamScrcpy';
import type { BasePlayer } from '../../../player/BasePlayer';
import type { StartStreamOptions } from '../../../public/types';
import Size from '../../../Size';
import VideoSettings from '../../../VideoSettings';
import { ConnectModal } from '../ConnectModal';

const stream = vi.hoisted(() => ({ options: undefined as StartStreamOptions | undefined }));
vi.mock('../../../public/startStream', () => ({
    startStream: vi.fn((_container: HTMLElement, deviceId: string, options: StartStreamOptions) => {
        stream.options = options;
        return { stop: vi.fn(), isConnected: false, deviceId };
    }),
}));

/**
 * Issue #981: the config stream dialog's connect button opens this modal, which
 * dropped fit to screen, i-frame interval, codec options and display id on the
 * way to startStream.
 */
describe('ConnectModal hands the dialog settings to startStream', () => {
    const params = { udid: 'serial-1', hostname: '', port: 0, videoCodec: 'h264' } as unknown as ParamsStreamScrcpy;

    beforeEach(() => {
        HTMLDialogElement.prototype.showModal = vi.fn();
        HTMLDialogElement.prototype.close = vi.fn();
        stream.options = undefined;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        document.body.querySelectorAll('dialog').forEach((d) => {
            d.remove();
        });
    });

    it('passes fit to screen off, max size, i-frame interval, codec options and display id', () => {
        const videoSettings = new VideoSettings({
            bitrate: 4000000,
            maxFps: 30,
            iFrameInterval: 10,
            bounds: new Size(640, 640),
            displayId: 2,
            codecOptions: 'profile:int=1',
        });
        new ConnectModal(params, {} as BasePlayer, false, videoSettings, 'Fire TV');

        expect(stream.options).toMatchObject({
            codec: 'h264',
            bitrate: 4000000,
            maxFps: 30,
            maxSize: 640,
            fitToScreen: false,
            iFrameInterval: 10,
            codecOptions: 'profile:int=1',
            displayId: 2,
        });
    });

    it('passes fit to screen on, and leaves blank fields to startStream defaults', () => {
        const videoSettings = new VideoSettings({ bitrate: 0, maxFps: 0, iFrameInterval: Number.NaN });
        new ConnectModal(params, {} as BasePlayer, true, videoSettings, 'Pixel');

        expect(stream.options?.fitToScreen).toBe(true);
        expect(stream.options?.iFrameInterval).toBeUndefined();
        expect(stream.options?.codecOptions).toBeUndefined();
        expect(stream.options?.displayId).toBeUndefined();
        expect(stream.options?.maxSize).toBeUndefined();
    });
});
