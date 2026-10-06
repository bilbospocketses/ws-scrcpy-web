// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Smoke row 8.27: a failed stream shows `stream failed: <reason>` and the modal
 * closes after ~4 s; a normal disconnect closes it at once.
 *
 * The error text never appeared. `onDisconnected` ran the disconnect callback
 * FIRST, the connect modal's callback closes the modal, closing the modal stops
 * the stream, and stopping sets `isStopping` — so the close-code check that came
 * after always read "the user stopped it" and the error hook never fired, for
 * any close code. These tests drive the real StreamClientScrcpy, startStream and
 * ConnectModal; only the socket, the player and the toolbox are faked.
 */

const h = vi.hoisted(() => ({
    demuxers: [] as Array<{
        url: string;
        closed: boolean;
        disconnectCb?: (ev: CloseEvent) => void;
        fireClose(code: number, reason?: string): void;
    }>,
}));

vi.mock('../../../ScrcpyDemuxer', () => {
    class ScrcpyDemuxer {
        public closed = false;
        public disconnectCb?: (ev: CloseEvent) => void;
        constructor(public url: string) {
            h.demuxers.push(this);
        }
        onVideoFrame(): void {}
        onAudioFrame(): void {}
        onDeviceMessage(): void {}
        onMetadata(): void {}
        onSessionChange(): void {}
        onDisconnect(cb: (ev: CloseEvent) => void): void {
            this.disconnectCb = cb;
        }
        sendControl(): void {}
        close(): void {
            this.closed = true;
        }
        /** What the browser's `ws.onclose` would deliver. */
        fireClose(code: number, reason = ''): void {
            this.disconnectCb?.({ code, reason } as CloseEvent);
        }
    }
    return { ScrcpyDemuxer };
});

vi.mock('../../toolbox/GoogToolBox', () => ({
    GoogToolBox: {
        createToolBox: () => {
            const holder = document.createElement('div');
            return { getHolderElement: () => holder };
        },
    },
}));

vi.mock('../../../interactionHandler/FeaturedInteractionHandler', () => ({
    FeaturedInteractionHandler: class {
        release(): void {}
        setDpadMode(): void {}
    },
}));

vi.mock('../../../player/webCodecsConfig', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../player/webCodecsConfig')>()),
    probeDecodeSupport: async () => true,
}));

import type { ParamsStreamScrcpy } from '../../../../types/ParamsStreamScrcpy';
import { settingsService } from '../../../client/SettingsService';
import type { PlayerClass } from '../../../player/BasePlayer';
import { startStream } from '../../../public/startStream';
import VideoSettings from '../../../VideoSettings';
import { ConnectModal } from '../ConnectModal';
import { StreamClientScrcpy } from '../StreamClientScrcpy';

class FakePlayer {
    public static playerFullName = 'webcodecs';
    public static playerCodeName = 'webcodecs';
    public static storageKeyPrefix = 'fake';
    public static isSupported(): boolean {
        return true;
    }
    public static getFitToScreenStatus(): boolean {
        return true;
    }
    on(): void {}
    getVideoSettings(): VideoSettings {
        return videoSettings();
    }
    setParent(): void {}
    pause(): void {}
    stop(): void {}
    setVideoSettings(): void {}
    getName(): string {
        return 'fake';
    }
}

function videoSettings(): VideoSettings {
    return new VideoSettings({
        bitrate: 8000000,
        maxFps: 30,
        iFrameInterval: 2,
        bounds: null,
        sendFrameMeta: false,
        lockedVideoOrientation: -1,
    });
}

const params: ParamsStreamScrcpy = {
    action: 'stream',
    udid: 'device-1',
    player: 'webcodecs',
    hostname: 'localhost',
    port: 8000,
    secure: false,
    pathname: '',
    videoCodec: 'h264',
} as ParamsStreamScrcpy;

/** StreamClientScrcpy.startStream is async; the socket exists once it settles. */
async function socketOpened(count = 1) {
    await vi.waitFor(() => expect(h.demuxers.length).toBe(count));
    return h.demuxers[count - 1]!;
}

beforeEach(() => {
    h.demuxers.length = 0;
    StreamClientScrcpy.registerPlayer(FakePlayer as unknown as PlayerClass);
    vi.spyOn(settingsService, 'hydrateDevice').mockResolvedValue();
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('startStream routes a stream end to exactly one of onError / onDisconnect', () => {
    function start() {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const onError = vi.fn();
        const onDisconnect = vi.fn();
        const handle = startStream(container, 'device-1', { codec: 'h264', onError, onDisconnect });
        return { handle, onError, onDisconnect };
    }

    it('reports a start failure (4005) with the server reason, and does not report a disconnect', async () => {
        const { onError, onDisconnect } = start();
        const socket = await socketOpened();

        socket.fireClose(4005, 'Timeout waiting for 3 TCP connections (got 2)');

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]![0].message).toBe('Timeout waiting for 3 TCP connections (got 2)');
        expect(onDisconnect).not.toHaveBeenCalled();
    });

    it('reports any other abnormal close with its reason', async () => {
        const { onError, onDisconnect } = start();
        const socket = await socketOpened();

        socket.fireClose(4010, 'something on the server broke');

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]![0].message).toBe('something on the server broke');
        expect(onDisconnect).not.toHaveBeenCalled();
    });

    it('names the code when an abnormal close carries no reason', async () => {
        const { onError, onDisconnect } = start();
        const socket = await socketOpened();

        socket.fireClose(1006);

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]![0].message).toBe('WebSocket closed with code 1006');
        expect(onDisconnect).not.toHaveBeenCalled();
    });

    it.each([1000, 1001, 1005])('treats close code %i as a normal end: onDisconnect only', async (code) => {
        const { onError, onDisconnect } = start();
        const socket = await socketOpened();

        socket.fireClose(code);

        expect(onDisconnect).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
    });

    it('treats a user stop as a normal end even when the close code is abnormal', async () => {
        const { handle, onError, onDisconnect } = start();
        const socket = await socketOpened();

        handle.stop();
        expect(socket.closed).toBe(true);
        socket.fireClose(1006);

        expect(onDisconnect).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
    });
});

describe('a refresh does not end the session', () => {
    it('fires neither callback when the replaced socket closes, whatever its code', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const onDisconnect = vi.fn();
        const { instance } = StreamClientScrcpy.start(
            params,
            undefined,
            true,
            videoSettings(),
            container,
            onDisconnect,
        );
        const onErrorReceived = vi.fn();
        instance.onErrorReceived = onErrorReceived;
        const first = await socketOpened();

        instance.refreshStream();
        expect(first.closed).toBe(true);
        first.fireClose(1006);
        first.fireClose(1000);

        expect(h.demuxers.length).toBe(2);
        expect(onDisconnect).not.toHaveBeenCalled();
        expect(onErrorReceived).not.toHaveBeenCalled();
    });
});

describe('ConnectModal (smoke row 8.27)', () => {
    function open(): { dialog: HTMLDialogElement; modal: ConnectModal } {
        const modal = new ConnectModal(params, {} as never, true, videoSettings(), 'Pixel', 'phone');
        const dialog = document.querySelector('dialog.connect-modal') as HTMLDialogElement;
        expect(dialog, 'the connect modal should be in the DOM').toBeTruthy();
        return { dialog, modal };
    }

    function errorText(dialog: HTMLDialogElement): string | null {
        return dialog.querySelector('.connect-modal-error')?.textContent ?? null;
    }

    it('shows "stream failed: <reason>" on a failure and closes about 4 s later', async () => {
        const { dialog } = open();
        const socket = await socketOpened();
        vi.useFakeTimers();

        socket.fireClose(4005, 'scrcpy-server exited (code 1)');

        expect(errorText(dialog)).toBe('stream failed: scrcpy-server exited (code 1)');
        expect(dialog.hasAttribute('open')).toBe(true);
        vi.advanceTimersByTime(3999);
        expect(dialog.hasAttribute('open')).toBe(true);
        vi.advanceTimersByTime(1);
        expect(dialog.hasAttribute('open')).toBe(false);
    });

    it.each([1000, 1001, 1005])('closes at once with no error text on a normal end (code %i)', async (code) => {
        const { dialog } = open();
        const socket = await socketOpened();

        socket.fireClose(code);

        expect(dialog.hasAttribute('open')).toBe(false);
        expect(errorText(dialog)).toBeNull();
    });

    it('shows no error when the user closes the modal, even if the socket then closes abnormally', async () => {
        const { dialog, modal } = open();
        const socket = await socketOpened();

        modal.close();
        socket.fireClose(1006);

        expect(dialog.hasAttribute('open')).toBe(false);
        expect(errorText(dialog)).toBeNull();
    });
});
