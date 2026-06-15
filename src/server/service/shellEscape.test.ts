import { describe, expect, it } from 'vitest';
import { assertServiceName, shQuote } from './shellEscape';

describe('shQuote', () => {
    it('wraps a plain value in single quotes', () => {
        expect(shQuote('/opt/ws-scrcpy-web')).toBe("'/opt/ws-scrcpy-web'");
    });

    it('neutralises double-quote / $() / backtick breakouts (root pkexec context)', () => {
        expect(shQuote('a"; reboot; "b')).toBe(`'a"; reboot; "b'`);
        expect(shQuote('$(reboot)')).toBe("'$(reboot)'");
        expect(shQuote('`reboot`')).toBe("'`reboot`'");
    });

    it('escapes embedded single quotes so the quote cannot be broken out of', () => {
        expect(shQuote("a'b")).toBe("'a'\\''b'");
        expect(shQuote("'; rm -rf /; '")).toBe("''\\''; rm -rf /; '\\'''");
    });
});

describe('assertServiceName', () => {
    it('accepts normal unit base names', () => {
        expect(assertServiceName('ws-scrcpy-web')).toBe('ws-scrcpy-web');
        expect(assertServiceName('WsScrcpyWeb')).toBe('WsScrcpyWeb');
        expect(assertServiceName('a_b.c-1')).toBe('a_b.c-1');
    });

    it('rejects names with shell metacharacters, spaces, or slashes', () => {
        expect(() => assertServiceName('a b')).toThrow();
        expect(() => assertServiceName('a;reboot')).toThrow();
        expect(() => assertServiceName('a/b')).toThrow();
        expect(() => assertServiceName('$(reboot)')).toThrow();
        expect(() => assertServiceName('')).toThrow();
    });

    it('rejects non-strings', () => {
        expect(() => assertServiceName(undefined as unknown as string)).toThrow();
    });
});
