import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../Config', () => ({ Config: { getInstance: () => ({ adbPath: 'adb' }) } }));

import { Device } from '../Device';

// `emitUpdate` throttles a device's updates to one per 300 ms, timed by the
// wall clock. When the clock stepped backwards (an NTP correction, a manual
// change) the time since the last emit went negative, and the throttle waited
// out the whole step plus 300 ms before sending anything: a one-hour step hid
// the device's updates for an hour. A step past ~24.8 days overflowed
// setTimeout, which Node reports as "Timeout duration was set to 1." That is
// the warning the scanLabels suite printed, when a Device from one test
// emitted while the next had faked the clock back to 1970.
const T = 2_000_000_000_000;

/** An offline device (no adb is touched), its constructor's own updates already sent. */
function settledDevice(): { device: Device; updates: ReturnType<typeof vi.fn> } {
    const device = new Device('10.0.0.5:5555', 'offline');
    vi.advanceTimersByTime(1000);
    const updates = vi.fn();
    device.on('update', updates);
    return { device, updates };
}

describe('Device update throttle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(T);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('emits at once after the wall clock steps backwards, instead of waiting out the step', () => {
        const { device, updates } = settledDevice();

        vi.setSystemTime(T - 60 * 60 * 1000);
        device.setState('unauthorized');

        expect(updates).toHaveBeenCalled();
        vi.advanceTimersByTime(301);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('still throttles updates that come less than 300 ms apart', () => {
        const { device, updates } = settledDevice();

        device.setState('unauthorized');
        expect(updates).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(100);
        device.setState('offline');
        expect(updates).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(300);
        expect(updates).toHaveBeenCalledTimes(2);
    });
});
