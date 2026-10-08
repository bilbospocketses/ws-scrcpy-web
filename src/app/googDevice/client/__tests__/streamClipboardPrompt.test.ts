// @vitest-environment jsdom

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The stream view end of the device → host clipboard: a CLIPBOARD device message
 * reaching StreamClientScrcpy is written to the host clipboard, and a refused
 * write puts the "click to copy" prompt over the video. Drives the real
 * StreamClientScrcpy; only the socket, the player and the toolbox are faked.
 */

const h = vi.hoisted(() => ({
    deviceMessage: undefined as ((data: Uint8Array) => void) | undefined,
}));

vi.mock('../../../ScrcpyDemuxer', () => {
    class ScrcpyDemuxer {
        onVideoFrame(): void {}
        onAudioFrame(): void {}
        onDeviceMessage(cb: (data: Uint8Array) => void): void {
            h.deviceMessage = cb;
        }
        onMetadata(): void {}
        onSessionChange(): void {}
        onDisconnect(): void {}
        sendControl(): void {}
        close(): void {}
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
import VideoSettings from '../../../VideoSettings';
import DeviceMessage from '../../DeviceMessage';
import { ClipboardCopyPrompt } from '../ClipboardCopyPrompt';
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

function clipboardMessage(text: string): Uint8Array {
    const body = new TextEncoder().encode(text);
    const out = new Uint8Array(5 + body.length);
    out[0] = DeviceMessage.TYPE_CLIPBOARD;
    new DataView(out.buffer).setUint32(1, body.length);
    out.set(body, 5);
    return out;
}

async function startedStream(): Promise<HTMLElement> {
    return (await startedStreamWithStop()).container;
}

async function startedStreamWithStop(): Promise<{ container: HTMLElement; stop: () => void }> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { stop } = StreamClientScrcpy.start(params, undefined, true, videoSettings(), container);
    await vi.waitFor(() => expect(h.deviceMessage).toBeDefined());
    return { container, stop };
}

/** The declaration block of the first rule with exactly this selector in ws-scrcpy.css. */
function cssRule(selector: string): string {
    const css = fs.readFileSync(path.resolve('src', 'style', 'ws-scrcpy.css'), 'utf8');
    const at = css.indexOf(`\n${selector} {`);
    expect(at, `${selector} rule should exist`).toBeGreaterThanOrEqual(0);
    return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    h.deviceMessage = undefined;
    StreamClientScrcpy.registerPlayer(FakePlayer as unknown as PlayerClass);
    vi.spyOn(settingsService, 'hydrateDevice').mockResolvedValue();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('device clipboard in the stream view', () => {
    it('writes the device text to the host clipboard and shows no prompt when the write succeeds', async () => {
        const writeText = vi.fn(async () => undefined);
        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
        const container = await startedStream();

        h.deviceMessage!(clipboardMessage('from the phone'));
        await settle();

        expect(writeText).toHaveBeenCalledWith('from the phone');
        const prompt = container.querySelector<HTMLElement>('.video .stream-clipboard-prompt');
        expect(prompt, 'the prompt element lives in the stream view').toBeTruthy();
        expect(prompt!.hidden).toBe(true);
    });

    it('shows the "click to copy" prompt over the video when the browser refuses the write', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const writeText = vi
            .fn<(text: string) => Promise<void>>()
            .mockRejectedValueOnce(new DOMException('not allowed', 'NotAllowedError'))
            .mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
        const container = await startedStream();

        h.deviceMessage!(clipboardMessage('blocked by Safari'));
        await settle();

        const prompt = container.querySelector<HTMLElement>('.video .stream-clipboard-prompt')!;
        expect(prompt.hidden).toBe(false);

        prompt.querySelector<HTMLButtonElement>('.stream-clipboard-prompt-copy')!.click();
        expect(writeText).toHaveBeenLastCalledWith('blocked by Safari');
        await settle();
        expect(prompt.hidden).toBe(true);
    });

    it('stopping the stream disposes of the prompt', async () => {
        const dispose = vi.spyOn(ClipboardCopyPrompt.prototype, 'dispose');
        const { stop } = await startedStreamWithStop();
        expect(dispose).not.toHaveBeenCalled();

        stop();

        expect(dispose).toHaveBeenCalledTimes(1);
    });
});

describe('where the prompt sits over the video', () => {
    it('at the top edge, clear of the device navigation bar and keyboard at the bottom', () => {
        const rule = cssRule('.stream-clipboard-prompt');
        expect(rule).toMatch(/align-self:\s*start;/);
        expect(rule).not.toMatch(/align-self:\s*end;/);
    });

    it('before the locked notice in the DOM, so the CSS can move the notice out of its way', async () => {
        const container = await startedStream();
        const video = container.querySelector<HTMLElement>('.video')!;
        const order = Array.from(video.children).map((el) => el.className);
        expect(order.indexOf('stream-clipboard-prompt')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('stream-clipboard-prompt')).toBeLessThan(order.indexOf('stream-locked-notice'));
        // ...and the rule that does the moving: the notice drops to the bottom
        // edge while the prompt holds the top one.
        expect(cssRule('.stream-clipboard-prompt:not([hidden]) ~ .stream-locked-notice')).toMatch(/align-self:\s*end;/);
    });
});
