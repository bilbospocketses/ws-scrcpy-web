import { describe, expect, it, vi } from 'vitest';
import { reconnectAfterApply } from '../reconnectAfterApply';

function statusResponse(version: string) {
    return { ok: true, json: async () => ({ currentVersion: version }) } as unknown as Response;
}

describe('reconnectAfterApply', () => {
    it('resolves "updated" when status reports a new version (swallows the down window)', async () => {
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new Error('down')) // swap window
            .mockResolvedValueOnce(statusResponse('0.1.0')) // old still up
            .mockResolvedValueOnce(statusResponse('0.2.0')); // new!
        const result = await reconnectAfterApply({
            previousVersion: '0.1.0',
            fetchFn: fetchMock as unknown as typeof fetch,
            intervalMs: 0,
            deadlineMs: 10_000,
            now: (() => {
                let t = 0;
                return () => (t += 1);
            })(),
        });
        expect(result).toBe('updated');
        expect(fetchMock).toHaveBeenCalledWith('/api/updates/status', { cache: 'no-store' });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('resolves "timeout" when the deadline passes without a new version', async () => {
        const fetchMock = vi.fn().mockResolvedValue(statusResponse('0.1.0'));
        const result = await reconnectAfterApply({
            previousVersion: '0.1.0',
            fetchFn: fetchMock as unknown as typeof fetch,
            intervalMs: 0,
            deadlineMs: 5,
            now: (() => {
                let t = 0;
                return () => (t += 2);
            })(),
        });
        expect(result).toBe('timeout');
    });

    it('resolves "updated" on the stale-token 403: a new process holds the origin (D15)', async () => {
        // qa-harness arc L4 on beta.145: 1× 200 (old), then 64× this 403 until
        // the 60 s timeout, and the page never reloaded.
        const staleToken = {
            ok: false,
            status: 403,
            json: async () => ({ error: 'forbidden', reason: 'missing or invalid token' }),
        } as unknown as Response;
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(statusResponse('0.1.0'))
            .mockRejectedValueOnce(new Error('down'))
            .mockResolvedValueOnce(staleToken);
        const result = await reconnectAfterApply({
            previousVersion: '0.1.0',
            fetchFn: fetchMock as unknown as typeof fetch,
            intervalMs: 0,
            deadlineMs: 10_000,
            now: (() => {
                let t = 0;
                return () => (t += 1);
            })(),
        });
        expect(result).toBe('updated');
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('any other 403 is not a new process: it keeps polling to the timeout', async () => {
        for (const body of [{ error: 'forbidden' }, { error: 'admin actions are limited to this machine' }, null]) {
            const forbidden = { ok: false, status: 403, json: async () => body } as unknown as Response;
            const result = await reconnectAfterApply({
                previousVersion: '0.1.0',
                fetchFn: vi.fn().mockResolvedValue(forbidden) as unknown as typeof fetch,
                intervalMs: 0,
                deadlineMs: 5,
                now: (() => {
                    let t = 0;
                    return () => (t += 2);
                })(),
            });
            expect(result).toBe('timeout');
        }
    });

    it('a body that is not JSON does not throw the poll off course', async () => {
        const broken = {
            ok: false,
            status: 502,
            json: async () => {
                throw new SyntaxError('Unexpected token <');
            },
        } as unknown as Response;
        const fetchMock = vi.fn().mockResolvedValueOnce(broken).mockResolvedValueOnce(statusResponse('0.2.0'));
        const result = await reconnectAfterApply({
            previousVersion: '0.1.0',
            fetchFn: fetchMock as unknown as typeof fetch,
            intervalMs: 0,
            deadlineMs: 10_000,
            now: (() => {
                let t = 0;
                return () => (t += 1);
            })(),
        });
        expect(result).toBe('updated');
    });
});
