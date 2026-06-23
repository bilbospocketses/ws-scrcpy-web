// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION } from '../../../../common/Action';
import type { ParamsFileListing } from '../../../../types/ParamsFileListing';
import { FileListingClient } from '../FileListingClient';

// Minimal WebSocket stub. jsdom does not implement WebSocket. Reporting
// readyState=CONNECTING(0) makes Multiplexer buffer outgoing frames instead of
// calling send(), so FileListingClient's constructor completes without a real
// socket. We only need addEventListener/removeEventListener/send/close to exist.
class MockWebSocket {
    public readonly CONNECTING = 0;
    public readonly OPEN = 1;
    public readonly CLOSING = 2;
    public readonly CLOSED = 3;
    public readyState = 0; // CONNECTING
    public binaryType = 'blob';
    public url: string;
    constructor(url: string) {
        this.url = url;
    }
    public addEventListener(): void {
        // no-op
    }
    public removeEventListener(): void {
        // no-op
    }
    public send(): void {
        // no-op
    }
    public close(): void {
        // no-op
    }
}

const params: ParamsFileListing = {
    action: ACTION.FILE_LISTING,
    udid: 'serial123',
    path: '/data/local/tmp',
} as ParamsFileListing;

describe('FileListingClient hashchange listener lifecycle (#37)', () => {
    let addSpy: ReturnType<typeof vi.spyOn>;
    let removeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
        // ManagerClient.sockets is a static Map keyed by URL — clear so each
        // test builds a fresh multiplexer.
        addSpy = vi.spyOn(window, 'addEventListener');
        removeSpy = vi.spyOn(window, 'removeEventListener');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
        location.hash = '';
    });

    function getHashchangeHandler(): EventListener | undefined {
        const call = addSpy.mock.calls.find((c: unknown[]) => c[0] === 'hashchange');
        return call?.[1] as EventListener | undefined;
    }

    it('removes the SAME hashchange handler reference on destroy()', () => {
        const client = FileListingClient.start(params);

        const registered = getHashchangeHandler();
        expect(registered).toBeTypeOf('function');

        client.destroy();

        const removedCall = removeSpy.mock.calls.find((c: unknown[]) => c[0] === 'hashchange');
        expect(removedCall).toBeDefined();
        // Same reference passed to add and remove.
        expect(removedCall?.[1]).toBe(registered);
    });

    it('does not react to hashchange after destroy()', () => {
        const client = FileListingClient.start(params);
        const loadSpy = vi.spyOn(client as any, 'loadContent');

        client.destroy();

        // Simulate a hash navigation that WOULD have triggered loadContent.
        location.hash = `#!action=${ACTION.FILE_LISTING}&path=/sdcard`;
        window.dispatchEvent(new Event('hashchange'));

        expect(loadSpy).not.toHaveBeenCalled();
    });
});
