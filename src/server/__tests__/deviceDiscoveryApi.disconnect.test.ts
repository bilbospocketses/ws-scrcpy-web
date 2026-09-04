import { describe, expect, it } from 'vitest';
import { classifyDisconnectResult } from '../api/DeviceDiscoveryApi';

// Disconnecting an address that is not connected asks for a state that is
// already true, so it is a no-op rather than a failure. It used to answer 500,
// which left callers unable to tell a real adb failure from a cleanup step
// running twice — the device tier's `disconnectIfConnected` had to accept both
// statuses and assert the resulting state instead.
describe('classifyDisconnectResult', () => {
    it('reports a real disconnect as 200 + success', () => {
        const out = classifyDisconnectResult('disconnected 192.168.87.3:5555\n');
        expect(out).toEqual({ status: 200, success: true, message: 'disconnected 192.168.87.3:5555' });
    });

    it('reports an address that was not connected as 200 + success, not 500', () => {
        const out = classifyDisconnectResult("error: no such device '192.168.87.3:5555'\n");
        expect(out).toEqual({ status: 200, success: true, message: 'not connected' });
    });

    it('still reports a genuine adb failure as 500', () => {
        const out = classifyDisconnectResult("error: protocol fault (couldn't read status)");
        expect(out.status).toBe(500);
        expect(out.success).toBe(false);
        expect(out.message).toBe("error: protocol fault (couldn't read status)");
    });
});
