import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../common/ConfigEvents';
import { applyUpdaterConfigChange } from '../updaterConfigSync';

const BASE = {
    channel: 'beta',
    githubOwner: 'owner',
    updateCheckIntervalMinutes: 60,
    autoUpdate: true,
} as AppConfig;

describe('applyUpdaterConfigChange — channel and interval together', () => {
    it('re-times the timer without waiting for the check reconfigure starts', async () => {
        // reconfigure resolves only when its check is over (on Windows with
        // automatic updates on, after the whole download). The new interval must
        // not wait on that, so restartTimer runs while reconfigure is pending.
        let finishCheck!: () => void;
        const reconfigure = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finishCheck = resolve;
                }),
        );
        const restartTimer = vi.fn();
        const done = applyUpdaterConfigChange({ reconfigure, restartTimer }, BASE, {
            ...BASE,
            channel: 'stable',
            updateCheckIntervalMinutes: 120,
        });

        expect(reconfigure).toHaveBeenCalledWith('stable', 'owner');
        expect(restartTimer).toHaveBeenCalledWith(120, true);
        // reconfigure is still started first, as it always was; only the
        // timer's re-timing stops waiting for it to finish.
        expect(reconfigure.mock.invocationCallOrder[0]!).toBeLessThan(restartTimer.mock.invocationCallOrder[0]!);

        finishCheck();
        await done;
    });

    it('still re-times the timer when reconfigure rejects', async () => {
        const reconfigure = vi.fn(async () => {
            throw new Error('feed unreachable');
        });
        const restartTimer = vi.fn();
        await expect(
            applyUpdaterConfigChange({ reconfigure, restartTimer }, BASE, {
                ...BASE,
                githubOwner: 'someone-else',
                updateCheckIntervalMinutes: 30,
            }),
        ).rejects.toThrow('feed unreachable');
        expect(restartTimer).toHaveBeenCalledWith(30, true);
    });

    it('a channel change alone leaves the timer as it is', async () => {
        const reconfigure = vi.fn(async () => undefined);
        const restartTimer = vi.fn();
        await applyUpdaterConfigChange({ reconfigure, restartTimer }, BASE, { ...BASE, channel: 'stable' });
        expect(reconfigure).toHaveBeenCalledTimes(1);
        expect(restartTimer).not.toHaveBeenCalled();
    });
});
