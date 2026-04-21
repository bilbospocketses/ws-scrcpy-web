import { describe, it, expect, beforeEach } from 'vitest';
import { CapabilitiesApi } from '../api/CapabilitiesApi';
import { _resetForTest, resolveNodePty } from '../NodePtyResolver';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';

function makeReqRes(url: string, method = 'GET') {
    const req = { url, method } as IncomingMessage;
    const chunks: string[] = [];
    let statusCode = 0;
    const res = {
        writeHead(code: number) { statusCode = code; return this; },
        setHeader() { return this; },
        end(data?: string) { if (data) chunks.push(data); },
        getStatus: () => statusCode,
        getBody: () => chunks.join(''),
    } as unknown as ServerResponse & { getStatus(): number; getBody(): string };
    return { req, res };
}

describe('CapabilitiesApi', () => {
    beforeEach(() => {
        _resetForTest();
    });

    it('returns { shell: true } when node-pty resolved successfully', async () => {
        await resolveNodePty('/tmp/test-deps');
        const api = new CapabilitiesApi();
        const { req, res } = makeReqRes('/api/capabilities');
        const handled = await api.handle(req, res);
        expect(handled).toBe(true);
        expect((res as any).getStatus()).toBe(200);
        expect(JSON.parse((res as any).getBody())).toEqual({ shell: true });
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
