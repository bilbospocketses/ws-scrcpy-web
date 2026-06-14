import { describe, expect, it } from 'vitest';
import Util from './Util';

describe('Util.escapeUdid', () => {
    it('preserves the output for real USB and network udids', () => {
        // Behaviour unchanged for normal device serials so DOM ids/lookups
        // built from escapeUdid stay consistent.
        expect(Util.escapeUdid('emulator-5554')).toBe('udid_emulator-5554');
        expect(Util.escapeUdid('192.168.1.5:5555')).toBe('udid_192_168_1_5_5555');
    });

    it('neutralises HTML-dangerous characters (defence in depth for derived ids)', () => {
        const out = Util.escapeUdid('x"><img src=x onerror=alert(1)>');
        expect(out).not.toMatch(/[<>"'&]/);
        // Only safe id characters remain.
        expect(out).toMatch(/^udid_[A-Za-z0-9_-]*$/);
    });
});
