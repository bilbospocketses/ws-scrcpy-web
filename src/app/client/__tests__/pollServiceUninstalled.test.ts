import { describe, it, expect, vi } from 'vitest';
import { pollServiceUninstalled } from '../pollServiceUninstalled';

function statusResponse(status: string) {
    return { ok: true, json: async () => ({ status }) } as unknown as Response;
}

describe('pollServiceUninstalled', () => {
    it('resolves "uninstalled" once /status reports not-installed (swallows the teardown down-window)', async () => {
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new Error('down')) // teardown stops the serving unit
            .mockResolvedValueOnce(statusResponse('running')) // still up briefly
            .mockResolvedValueOnce(statusResponse('not-installed')); // gone
        const result = await pollServiceUninstalled({
            fetchFn: fetchMock as unknown as typeof fetch,
            intervalMs: 0,
            deadlineMs: 10_000,
            now: (() => { let t = 0; return () => (t += 1); })(),
        });
        expect(result).toBe('uninstalled');
        expect(fetchMock).toHaveBeenCalledWith('/api/service/status', { cache: 'no-store' });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('resolves "still-present" when the service never goes away — surfaces a failed teardown (beta.60 #9 5.1)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(statusResponse('running'));
        const result = await pollServiceUninstalled({
            fetchFn: fetchMock as unknown as typeof fetch,
            intervalMs: 0,
            deadlineMs: 5,
            now: (() => { let t = 0; return () => (t += 2); })(),
        });
        expect(result).toBe('still-present');
    });
});
