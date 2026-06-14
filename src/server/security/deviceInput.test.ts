import { describe, expect, it } from 'vitest';
import {
    assertSafeRemotePath,
    assertSerial,
    isSafeEncoderName,
    isValidSerial,
    shArg,
} from './deviceInput';

describe('deviceInput', () => {
    describe('shArg', () => {
        it('wraps a plain value in single quotes', () => {
            expect(shArg('/sdcard/Download')).toBe("'/sdcard/Download'");
        });

        it('neutralises shell metacharacters by quoting them literally', () => {
            expect(shArg('x; reboot')).toBe("'x; reboot'");
            expect(shArg('$(id)')).toBe("'$(id)'");
            expect(shArg('`id`')).toBe("'`id`'");
            expect(shArg('a|b>c')).toBe("'a|b>c'");
        });

        it('escapes embedded single quotes so the quote cannot be broken out of', () => {
            expect(shArg("a'b")).toBe("'a'\\''b'");
        });

        it('escapes a quote-breakout attempt into one inert sh token', () => {
            // Each ' becomes '\'' so sh re-parses the whole thing as the literal
            // input string rather than executing the embedded `rm`.
            expect(shArg("'; rm -rf /; '")).toBe("''\\''; rm -rf /; '\\'''");
        });
    });

    describe('isValidSerial', () => {
        it('accepts USB serials, emulator ids and host:port', () => {
            expect(isValidSerial('emulator-5554')).toBe(true);
            expect(isValidSerial('0123456789ABCDEF')).toBe(true);
            expect(isValidSerial('192.168.1.5:5555')).toBe(true);
        });

        it('rejects a leading dash (adb option injection)', () => {
            expect(isValidSerial('-Ltcp:evil:1234')).toBe(false);
            expect(isValidSerial('-H')).toBe(false);
        });

        it('rejects empty, whitespace, metacharacters and over-long values', () => {
            expect(isValidSerial('')).toBe(false);
            expect(isValidSerial('a b')).toBe(false);
            expect(isValidSerial('a;b')).toBe(false);
            expect(isValidSerial('a'.repeat(129))).toBe(false);
        });

        it('rejects non-strings', () => {
            expect(isValidSerial(undefined)).toBe(false);
            expect(isValidSerial(123 as unknown)).toBe(false);
        });
    });

    describe('assertSerial', () => {
        it('returns the serial when valid', () => {
            expect(assertSerial('emulator-5554')).toBe('emulator-5554');
        });

        it('throws on an invalid serial', () => {
            expect(() => assertSerial('-H')).toThrow();
            expect(() => assertSerial('a;b')).toThrow();
        });
    });

    describe('isSafeEncoderName', () => {
        it('accepts real encoder names', () => {
            expect(isSafeEncoderName('OMX.qcom.video.encoder.avc')).toBe(true);
            expect(isSafeEncoderName('c2.android.avc.encoder')).toBe(true);
        });

        it('rejects values with shell metacharacters or spaces', () => {
            expect(isSafeEncoderName('x;reboot')).toBe(false);
            expect(isSafeEncoderName('a b')).toBe(false);
            expect(isSafeEncoderName('$(id)')).toBe(false);
            expect(isSafeEncoderName('')).toBe(false);
        });
    });

    describe('assertSafeRemotePath', () => {
        it('returns a plausible device path unchanged', () => {
            expect(assertSafeRemotePath('/sdcard/Download/photo.jpg')).toBe('/sdcard/Download/photo.jpg');
        });

        it('rejects a leading dash (adb option injection)', () => {
            expect(() => assertSafeRemotePath('-rf')).toThrow();
        });

        it('rejects empty values and embedded NUL', () => {
            expect(() => assertSafeRemotePath('')).toThrow();
            expect(() => assertSafeRemotePath('a\0b')).toThrow();
        });
    });
});
