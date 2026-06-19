import type { IncomingMessage, ServerResponse } from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilitiesApi } from '../api/CapabilitiesApi';

// Mock the resolver so CapabilitiesApi tests focus on API behavior and don't
// exercise real download / filesystem / network code. The resolver has its own
// unit tests + a dedicated integration test.
let mockedHandle: { available: boolean; reason?: string } | undefined;
vi.mock('../NodePtyResolver', () => ({
    _resetForTest: () => {
        mockedHandle = undefined;
    },
    resolveNodePty: async () => mockedHandle ?? { available: false, reason: 'test-default' },
    getNodePty: () => mockedHandle,
}));

function makeReqRes(url: string, method = 'GET') {
    const req = { url, method } as IncomingMessage;
    const chunks: string[] = [];
    let statusCode = 0;
    const res = {
        writeHead(code: number) {
            statusCode = code;
            return this;
        },
        setHeader() {
            return this;
        },
        end(data?: string) {
            if (data) chunks.push(data);
        },
        getStatus: () => statusCode,
        getBody: () => chunks.join(''),
    } as unknown as ServerResponse & { getStatus(): number; getBody(): string };
    return { req, res };
}

describe('CapabilitiesApi', () => {
    beforeEach(() => {
        mockedHandle = undefined;
    });

    it('returns { shell: true } when the cached handle reports available', async () => {
        mockedHandle = { available: true };
        const api = new CapabilitiesApi();
        const { req, res } = makeReqRes('/api/capabilities');
        const handled = await api.handle(req, res);
        expect(handled).toBe(true);
        expect((res as any).getStatus()).toBe(200);
        expect(JSON.parse((res as any).getBody())).toEqual({ shell: true });
    });

    it('returns { shell: false, shellReason } when the cached handle is unavailable', async () => {
        mockedHandle = { available: false, reason: 'no-manifest' };
        const api = new CapabilitiesApi();
        const { req, res } = makeReqRes('/api/capabilities');
        const handled = await api.handle(req, res);
        expect(handled).toBe(true);
        // v0.1.8: shellReason is surfaced so the frontend can render
        // an actionable failure mode rather than silently hiding the
        // shell modal.
        expect(JSON.parse((res as any).getBody())).toEqual({
            shell: false,
            shellReason: 'no-manifest',
        });
    });

    it('returns { shell: false } when no handle is cached yet', async () => {
        const api = new CapabilitiesApi();
        const { req, res } = makeReqRes('/api/capabilities');
        await api.handle(req, res);
        expect(JSON.parse((res as any).getBody())).toEqual({ shell: false });
    });

    it('returns false from handle() for non-matching URLs', async () => {
        const api = new CapabilitiesApi();
        const { req, res } = makeReqRes('/api/devices');
        const handled = await api.handle(req, res);
        expect(handled).toBe(false);
    });

    it('rejects non-GET methods with 405', async () => {
        const api = new CapabilitiesApi();
        const { req, res } = makeReqRes('/api/capabilities', 'POST');
        const handled = await api.handle(req, res);
        expect(handled).toBe(true);
        expect((res as any).getStatus()).toBe(405);
    });
});
