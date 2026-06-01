import { describe, it, expect, vi } from 'vitest';
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
            now: (() => { let t = 0; return () => (t += 1); })(),
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
            now: (() => { let t = 0; return () => (t += 2); })(),
        });
        expect(result).toBe('timeout');
    });
});
