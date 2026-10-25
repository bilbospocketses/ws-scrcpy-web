// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyStreamParams } from '../../../common/StreamUrlParams';
import { startStream } from '../startStream';

// Mock StreamClientScrcpy — startStream is a facade over it
vi.mock('../../googDevice/client/StreamClientScrcpy', () => ({
    StreamClientScrcpy: {
        start: vi.fn(() => ({
            instance: { stopStream: vi.fn() },
            stop: vi.fn(),
        })),
    },
}));

describe('startStream', () => {
    let container: HTMLElement;
    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });
    afterEach(() => {
        container.remove();
        vi.clearAllMocks();
    });

    it('throws if deviceId is missing', () => {
        expect(() => startStream(container, '')).toThrow(/deviceId/);
    });

    it('throws if container already has an active stream', () => {
        startStream(container, 'abc123');
        expect(() => startStream(container, 'abc123')).toThrow(/active stream/);
    });

    it('returns a handle with deviceId set', () => {
        const handle = startStream(container, 'abc123');
        expect(handle.deviceId).toBe('abc123');
        expect(handle.isConnected).toBe(false);
    });

    it('returns a handle with stop() that is idempotent', () => {
        const handle = startStream(container, 'abc123');
        expect(() => handle.stop()).not.toThrow();
        expect(() => handle.stop()).not.toThrow();
    });

    it('reports a start failure through onError only, and still returns a handle', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        const failure = new Error('device refused');
        (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
            throw failure;
        });
        const onError = vi.fn();
        const onDisconnect = vi.fn();

        let handle: ReturnType<typeof startStream> | undefined;
        expect(() => {
            handle = startStream(container, 'abc123', { onError, onDisconnect });
        }).not.toThrow();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(failure);
        expect(onDisconnect).not.toHaveBeenCalled();
        expect(handle?.deviceId).toBe('abc123');
        expect(handle?.isConnected).toBe(false);
        expect(() => handle?.stop()).not.toThrow();
        // The container is free again, so a retry is not refused as a duplicate.
        expect(() => startStream(container, 'abc123')).not.toThrow();
    });

    it('passes bitrate/maxFps/maxSize through to StreamClientScrcpy.start as VideoSettings', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123', { codec: 'h265', bitrate: 8000000, maxFps: 30, maxSize: 1920 });
        expect(StreamClientScrcpy.start).toHaveBeenCalled();
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(args[0].udid).toBe('abc123');
        expect(args[0].videoCodec).toBe('h265');
        // 4th arg is videoSettings
        expect(args[3]).toBeDefined();
        expect(args[3].bitrate).toBe(8000000);
        expect(args[3].maxFps).toBe(30);
        // bounds should reflect maxSize
        expect(args[3].bounds?.width).toBe(1920);
        expect(args[3].bounds?.height).toBe(1920);
    });

    it('passes undefined videoSettings when no bitrate/fps/size specified', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123');
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(args[3]).toBeUndefined();
    });

    it('fits to screen by default', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123');
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(args[0].fitToScreen).toBe(true);
        expect(args[2]).toBe(true);
    });

    // Issue #981: the config stream dialog's connect button lost fit to screen,
    // i-frame interval and codec options here, so the viewport replaced the
    // dialog's max size and the interval stayed at 2.
    it('passes fitToScreen=false, iFrameInterval, codecOptions and displayId through', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123', {
            maxSize: 640,
            fitToScreen: false,
            iFrameInterval: 10,
            codecOptions: 'profile:int=1',
            displayId: 2,
        });
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(args[0].fitToScreen).toBe(false);
        expect(args[2]).toBe(false);
        expect(args[3].iFrameInterval).toBe(10);
        expect(args[3].codecOptions).toBe('profile:int=1');
        expect(args[3].displayId).toBe(2);

        // What scrcpy-server is asked for, as StreamClientScrcpy.buildStreamUrl builds it.
        const url = new URL('ws://localhost:8000/');
        applyStreamParams(url, { udid: 'abc123' }, args[3]);
        expect(url.searchParams.get('maxSize')).toBe('640');
        expect(url.searchParams.get('displayId')).toBe('2');
        expect(url.searchParams.get('videoCodecOptions')).toBe('i-frame-interval:int=10,profile:int=1');
    });

    // A fresh device's card connect, or a dialog saved with fit off and blank
    // max width/height, must not stream at native size.
    it('fits to screen when fitToScreen=false comes without a maxSize', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123', { fitToScreen: false, bitrate: 8000000 });
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(args[0].fitToScreen).toBe(true);
        expect(args[2]).toBe(true);
    });

    it('builds VideoSettings when only iFrameInterval is given', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123', { iFrameInterval: 5 });
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(args[3]?.iFrameInterval).toBe(5);
    });

    it('propagates audio=false through to params.audioEnabled', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123', { audio: false });
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(args[0].audioEnabled).toBe(false);
    });

    it('propagates audio=true through to params.audioEnabled', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123', { audio: true });
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(args[0].audioEnabled).toBe(true);
    });

    it('omits audioEnabled when caller does not specify audio', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123');
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(args[0].audioEnabled).toBeUndefined();
    });

    it('propagates audioSource through to params.audioSource', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123', { audioSource: 'playback' });
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(args[0].audioSource).toBe('playback');
    });

    it('propagates audioCodec through to params.audioCodec', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123', { audioCodec: 'aac' });
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(args[0].audioCodec).toBe('aac');
    });
});
