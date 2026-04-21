// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

    it('passes bitrate/maxFps/maxSize through to StreamClientScrcpy.start as VideoSettings', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123', { codec: 'h265', bitrate: 8000000, maxFps: 30, maxSize: 1920 });
        expect(StreamClientScrcpy.start).toHaveBeenCalled();
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0];
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
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(args[3]).toBeUndefined();
    });

    it('propagates audio=false through to params.audioEnabled', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123', { audio: false });
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(args[0].audioEnabled).toBe(false);
    });

    it('propagates audio=true through to params.audioEnabled', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123', { audio: true });
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(args[0].audioEnabled).toBe(true);
    });

    it('omits audioEnabled when caller does not specify audio', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123');
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(args[0].audioEnabled).toBeUndefined();
    });

    it('propagates audioSource through to params.audioSource', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123', { audioSource: 'playback' });
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(args[0].audioSource).toBe('playback');
    });

    it('propagates audioCodec through to params.audioCodec', async () => {
        const { StreamClientScrcpy } = await import('../../googDevice/client/StreamClientScrcpy');
        startStream(container, 'abc123', { audioCodec: 'aac' });
        const args = (StreamClientScrcpy.start as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(args[0].audioCodec).toBe('aac');
    });
});
