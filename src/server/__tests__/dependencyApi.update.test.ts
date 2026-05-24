// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DependencyApi } from '../api/DependencyApi';
import { DependencyManager } from '../DependencyManager';

interface MockRes {
    statusCode?: number;
    body?: string;
    writeHead: (...args: unknown[]) => unknown;
    end: (...args: unknown[]) => unknown;
    setHeader: (...args: unknown[]) => unknown;
}

function makeMockRes() {
    const res = Object.assign(new EventEmitter(), {
        statusCode: undefined as number | undefined,
        body: undefined as string | undefined,
        setHeader: vi.fn(),
        writeHead: vi.fn(),
        end: vi.fn(),
    }) as MockRes;
    (res.writeHead as ReturnType<typeof vi.fn>).mockImplementation((code: number) => {
        res.statusCode = code;
    });
    (res.end as ReturnType<typeof vi.fn>).mockImplementation((body: string) => {
        res.body = body;
    });
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    return res as any;
}

function makeReq(method: string, url: string) {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    return { method, url } as any;
}

describe('DependencyApi.update endpoint', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns 503 when update result has reason=launcher-required', async () => {
        const mgr = new DependencyManager('/tmp/test-api-503');
        vi.spyOn(mgr, 'update').mockResolvedValue({
            success: false,
            reason: 'launcher-required',
            errorMessage: 'Node.js updates require an installed build.',
            requiresRestart: false,
        });
        const api = new DependencyApi(mgr);
        const req = makeReq('POST', '/api/dependencies/nodejs/update');
        const res = makeMockRes();

        const handled = await api.handle(req, res);

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(503);
        const body = JSON.parse(res.body!);
        expect(body.success).toBe(false);
        expect(body.reason).toBe('launcher-required');
    });

    it('returns 200 when update succeeds (no launcher gate)', async () => {
        const mgr = new DependencyManager('/tmp/test-api-200');
        vi.spyOn(mgr, 'update').mockResolvedValue({
            success: true,
            newVersion: '4.0',
            requiresRestart: false,
        });
        const api = new DependencyApi(mgr);
        const req = makeReq('POST', '/api/dependencies/scrcpy-server/update');
        const res = makeMockRes();

        const handled = await api.handle(req, res);

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body!);
        expect(body.success).toBe(true);
    });

    it('returns 500 for non-gate update failures', async () => {
        const mgr = new DependencyManager('/tmp/test-api-500');
        vi.spyOn(mgr, 'update').mockResolvedValue({
            success: false,
            errorMessage: 'Download failed: HTTP 500',
            requiresRestart: false,
        });
        const api = new DependencyApi(mgr);
        const req = makeReq('POST', '/api/dependencies/nodejs/update');
        const res = makeMockRes();

        await api.handle(req, res);

        expect(res.statusCode).toBe(500);
    });
});
