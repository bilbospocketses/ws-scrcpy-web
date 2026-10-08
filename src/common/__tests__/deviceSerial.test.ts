import { describe, expect, it } from 'vitest';
import { isUniqueSerial } from '../deviceSerial';

// M11 fix 1, m4: a serial many devices share must not key a device's row,
// settings or card.
describe('isUniqueSerial', () => {
    it.each([
        '',
        '   ',
        'unknown',
        'UNKNOWN',
        '0123456789ABCDEF',
        '0123456789abcdef',
        'EMULATOR37X1X11X0',
        'EMULATOR30X0X26X0',
        'EMULATOR37.1.11.0',
    ])('rejects the placeholder %j', (serial) => {
        expect(isUniqueSerial(serial)).toBe(false);
    });

    it('rejects a missing serial', () => {
        expect(isUniqueSerial(undefined)).toBe(false);
        expect(isUniqueSerial(null)).toBe(false);
    });

    it.each(['R5CN30ABCDE', '5C061JEA327610', 'emulator-5554', 'EMULATORS', '0123456789ABCDEF0'])(
        'accepts the real serial %j',
        (serial) => {
            expect(isUniqueSerial(serial)).toBe(true);
        },
    );
});
