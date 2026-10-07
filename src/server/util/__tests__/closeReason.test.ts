import { describe, expect, it } from 'vitest';
import { closeReason, MAX_CLOSE_REASON_BYTES } from '../closeReason';

const bytes = (text: string): number => Buffer.byteLength(text, 'utf-8');

/** A cut that split a character would not survive an encode/decode round trip. */
function expectWholeCharacters(reason: string): void {
    expect(Buffer.from(reason, 'utf-8').toString('utf-8')).toBe(reason);
    expect(reason).not.toContain('�');
}

describe('closeReason', () => {
    it('is the RFC 6455 limit', () => {
        expect(MAX_CLOSE_REASON_BYTES).toBe(123);
    });

    it('leaves a short reason alone', () => {
        expect(closeReason('scrcpy-server exited (code 1)')).toBe('scrcpy-server exited (code 1)');
        expect(closeReason('')).toBe('');
    });

    it('leaves a reason of exactly 123 bytes alone', () => {
        const ascii = 'a'.repeat(123);
        expect(closeReason(ascii)).toBe(ascii);
        // 61 two-byte characters plus one byte: 123 bytes, 62 UTF-16 units.
        const mixed = `${'é'.repeat(61)}a`;
        expect(bytes(mixed)).toBe(123);
        expect(closeReason(mixed)).toBe(mixed);
    });

    it('cuts a long ASCII reason to 123 bytes', () => {
        expect(closeReason('a'.repeat(200))).toBe('a'.repeat(123));
    });

    it('cuts a long reason to 123 bytes of UTF-8 without splitting a character', () => {
        const reason = closeReason(`${'a'.repeat(121)}é€`);
        // 121 + 2 bytes (é) = 123; the 3-byte € would cross the limit.
        expect(reason).toBe(`${'a'.repeat(121)}é`);
        expect(closeReason('€'.repeat(100))).toBe('€'.repeat(41));
    });

    it.each([
        ['two-byte', 'é'.repeat(100), 'é'.repeat(61)],
        ['three-byte', '€'.repeat(100), '€'.repeat(41)],
        ['four-byte (emoji, a surrogate pair)', '😀'.repeat(40), '😀'.repeat(30)],
    ])('a %s message is cut on a character boundary', (_kind, text, expected) => {
        // String.slice(0, 123) — what DeviceProbe used — keeps every one of these over the limit.
        expect(bytes(text.slice(0, 123))).toBeGreaterThan(123);
        const reason = closeReason(text);
        expect(bytes(reason)).toBeLessThanOrEqual(123);
        expectWholeCharacters(reason);
        expect(reason).toBe(expected);
    });
});
