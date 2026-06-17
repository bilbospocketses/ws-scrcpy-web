// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEBUG_STORAGE_KEY, debugError, debugLog, isDebugEnabled } from '../debugLog';

beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
});

afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
});

describe('isDebugEnabled', () => {
    it('is false when the flag is unset', () => {
        expect(isDebugEnabled()).toBe(false);
    });

    it("is true only when the flag is exactly 'true'", () => {
        localStorage.setItem(DEBUG_STORAGE_KEY, 'true');
        expect(isDebugEnabled()).toBe(true);
    });

    it("is false for non-'true' values", () => {
        localStorage.setItem(DEBUG_STORAGE_KEY, '1');
        expect(isDebugEnabled()).toBe(false);
        localStorage.setItem(DEBUG_STORAGE_KEY, 'TRUE');
        expect(isDebugEnabled()).toBe(false);
        localStorage.setItem(DEBUG_STORAGE_KEY, 'yes');
        expect(isDebugEnabled()).toBe(false);
        localStorage.setItem(DEBUG_STORAGE_KEY, '');
        expect(isDebugEnabled()).toBe(false);
    });

    it('reads from the ws-scrcpy-web-debug key', () => {
        expect(DEBUG_STORAGE_KEY).toBe('ws-scrcpy-web-debug');
    });
});

describe('debugLog', () => {
    it('does NOT call console.log when the flag is unset', () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        debugLog('hello', 1, 2);
        expect(spy).not.toHaveBeenCalled();
    });

    it('does NOT call console.log when the flag is false', () => {
        localStorage.setItem(DEBUG_STORAGE_KEY, 'false');
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        debugLog('hello');
        expect(spy).not.toHaveBeenCalled();
    });

    it("calls console.log with all args when the flag is 'true'", () => {
        localStorage.setItem(DEBUG_STORAGE_KEY, 'true');
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        debugLog('[TAG]', 'msg', 42);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith('[TAG]', 'msg', 42);
    });
});

describe('debugError', () => {
    it('does NOT call console.error when the flag is unset', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        debugError('boom');
        expect(spy).not.toHaveBeenCalled();
    });

    it("calls console.error with all args when the flag is 'true'", () => {
        localStorage.setItem(DEBUG_STORAGE_KEY, 'true');
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        debugError('[TAG]', 'bad', { x: 1 });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith('[TAG]', 'bad', { x: 1 });
    });
});

describe('debugLog without localStorage (non-browser env)', () => {
    it('does not throw when localStorage access throws', () => {
        const original = globalThis.localStorage;
        // Simulate an environment where reading localStorage throws (e.g. blocked storage).
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            get() {
                throw new Error('localStorage blocked');
            },
        });
        using _restore = {
            [Symbol.dispose](): void {
                Object.defineProperty(globalThis, 'localStorage', {
                    configurable: true,
                    value: original,
                });
            },
        };
        expect(() => isDebugEnabled()).not.toThrow();
        expect(isDebugEnabled()).toBe(false);
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        expect(() => debugLog('x')).not.toThrow();
        expect(spy).not.toHaveBeenCalled();
    });
});
