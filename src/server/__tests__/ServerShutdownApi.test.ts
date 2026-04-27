// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';
import { describe, expect, it, vi } from 'vitest';
import { ServerShutdownApi } from '../api/ServerShutdownApi';

function makeReqRes(url: string, method = 'GET') {
    const req = { url, method } as IncomingMessage;
    let statusCode = 0;
    const chunks: string[] = [];
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

describe('ServerShutdownApi', () => {
    it('returns false for GET requests (wrong method)', async () => {
        const api = new ServerShutdownApi();
        const { req, res } = makeReqRes('/api/server/shutdown', 'GET');
        expect(await api.handle(req, res)).toBe(false);
    });

    it('returns false for POSTs to a different path', async () => {
        const api = new ServerShutdownApi();
        const { req, res } = makeReqRes('/api/devices', 'POST');
        expect(await api.handle(req, res)).toBe(false);
    });

    it('returns false for the right path with a wrong method (PUT)', async () => {
        const api = new ServerShutdownApi();
        const { req, res } = makeReqRes('/api/server/shutdown', 'PUT');
        expect(await api.handle(req, res)).toBe(false);
    });

    it('POST /api/server/shutdown writes 200 with { ok: true } envelope', async () => {
        const schedule = vi.fn();
        const exit = vi.fn();
        const api = new ServerShutdownApi(schedule, exit);
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST');
        const handled = await api.handle(req, res);
        expect(handled).toBe(true);
        expect((res as any).getStatus()).toBe(200);
        expect(JSON.parse((res as any).getBody())).toEqual({ ok: true });
    });

    it('schedules process.exit(0) via setTimeout after responding', async () => {
        const schedule = vi.fn();
        const exit = vi.fn();
        const api = new ServerShutdownApi(schedule, exit);
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST');
        await api.handle(req, res);

        expect(schedule).toHaveBeenCalledTimes(1);
        const [cb, delay] = schedule.mock.calls[0];
        expect(typeof cb).toBe('function');
        expect(delay).toBe(100);

        // Exit must NOT have fired yet — only scheduled.
        expect(exit).not.toHaveBeenCalled();

        // Manually invoke the scheduled callback; verify exit(0) is then called.
        (cb as () => void)();
        expect(exit).toHaveBeenCalledWith(0);
    });
});
