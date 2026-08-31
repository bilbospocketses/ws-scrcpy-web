import { describe, expect, it, vi } from 'vitest';
import { sanitizeFrameAncestors } from '../Config';

describe('sanitizeFrameAncestors', () => {
    it('returns an empty list when the key is absent', () => {
        expect(sanitizeFrameAncestors(undefined, vi.fn())).toEqual([]);
    });

    it('accepts absolute origins and normalises them', () => {
        const warn = vi.fn();

        // new URL().origin drops the default port and any trailing slash, so
        // "http://localhost:80/" and "http://localhost" agree.
        expect(sanitizeFrameAncestors(['http://localhost:5159', 'https://tools.example.com'], warn)).toEqual([
            'http://localhost:5159',
            'https://tools.example.com',
        ]);
        expect(warn).not.toHaveBeenCalled();
    });

    it('warns and ignores a non-array instead of throwing', () => {
        const warn = vi.fn();

        // Contract 1: a bad config.json must not stop the server booting.
        expect(sanitizeFrameAncestors('http://localhost:5159', warn)).toEqual([]);
        expect(warn).toHaveBeenCalledOnce();
    });

    it('skips blank and non-string entries but keeps the good ones', () => {
        const warn = vi.fn();

        expect(sanitizeFrameAncestors(['', '   ', 42, 'http://localhost:5159'], warn)).toEqual([
            'http://localhost:5159',
        ]);
        expect(warn).toHaveBeenCalledTimes(3);
    });

    it('rejects "*" outright', () => {
        const warn = vi.fn();

        // Allowing any embedder is precisely what the header exists to prevent,
        // so this is never treated as a shortcut for "disable framing checks".
        expect(sanitizeFrameAncestors(['*'], warn)).toEqual([]);
        expect(warn).toHaveBeenCalledOnce();
    });

    it('rejects entries that are not absolute origins', () => {
        const warn = vi.fn();

        expect(sanitizeFrameAncestors(['localhost:5159', 'not a url'], warn)).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it('rejects an origin carrying a path, query or fragment', () => {
        const warn = vi.fn();

        // frame-ancestors matches origins; a path is an operator mistake that
        // would otherwise be silently dropped by the browser.
        expect(sanitizeFrameAncestors(['http://localhost:5159/embed', 'http://localhost:5159/?a=1'], warn)).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(2);
    });
});
