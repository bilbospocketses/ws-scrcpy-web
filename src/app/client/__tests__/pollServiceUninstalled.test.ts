import { describe, expect, it, vi } from 'vitest';
import { pollServiceUninstalled } from '../pollServiceUninstalled';

function statusResponse(status: string) {
    return { ok: true, json: async () => ({ status }) } as unknown as Response;
}

/** A clock that advances `step` ms per read. */
function clock(step: number) {
    let t = 0;
    return () => (t += step);
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
            now: clock(1),
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
            now: clock(2),
        });
        expect(result).toBe('still-present');
    });

    it('resolves "stopped" when this origin goes quiet — the normal end of a system-scope uninstall (D11, item 157)', async () => {
        // qa-harness row 5.9 on beta.145: the teardown stopped the unit serving
        // the page, nothing listened on its port again, and the old poll timed
        // out into the red "still running" error on every successful uninstall.
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(statusResponse('running'))
            .mockRejectedValue(new TypeError('Failed to fetch'));
        const result = await pollServiceUninstalled({
            fetchFn: fetchMock as unknown as typeof fetch,
            intervalMs: 0,
            deadlineMs: 30_000,
            silentMs: 5000,
            now: clock(1000),
        });
        expect(result).toBe('stopped');
    });

    it('any answer resets the silence: a service that flaps but keeps answering is still-present', async () => {
        // Down, up, down, up… never silent for silentMs in a row.
        const fetchMock = vi.fn();
        for (let i = 0; i < 40; i++) {
            if (i % 2 === 0) fetchMock.mockRejectedValueOnce(new Error('down'));
            else fetchMock.mockResolvedValueOnce(statusResponse('running'));
        }
        const result = await pollServiceUninstalled({
            fetchFn: fetchMock as unknown as typeof fetch,
            intervalMs: 0,
            deadlineMs: 30_000,
            silentMs: 5000,
            now: clock(1000),
        });
        expect(result).toBe('still-present');
    });

    it('a non-OK answer (e.g. a 403 from a still-running server) is not silence', async () => {
        const forbidden = { ok: false, status: 403, json: async () => ({}) } as unknown as Response;
        const fetchMock = vi.fn().mockResolvedValue(forbidden);
        const result = await pollServiceUninstalled({
            fetchFn: fetchMock as unknown as typeof fetch,
            intervalMs: 0,
            deadlineMs: 10_000,
            silentMs: 2000,
            now: clock(1000),
        });
        expect(result).toBe('still-present');
    });
});
