// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    firstPaintTheme,
    getTheme,
    installThemeEmbedListener,
    notifyThemeChanged,
    notifyThemeReady,
    setTheme,
} from '../themeEmbed';

describe('firstPaintTheme', () => {
    it('returns "dark" when prefersDark is true', () => {
        expect(firstPaintTheme(true)).toBe('dark');
    });

    it('returns "light" when prefersDark is false', () => {
        expect(firstPaintTheme(false)).toBe('light');
    });
});

describe('getTheme / setTheme', () => {
    beforeEach(() => {
        document.documentElement.removeAttribute('data-theme');
    });

    it('returns "dark" by default when data-theme is absent', () => {
        expect(getTheme()).toBe('dark');
    });

    it('setTheme("light") writes DOM attribute', () => {
        setTheme('light');
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        expect(getTheme()).toBe('light');
    });

    it('setTheme("dark") round-trips', () => {
        setTheme('light');
        setTheme('dark');
        expect(getTheme()).toBe('dark');
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('setTheme does not touch localStorage', () => {
        const spy = vi.spyOn(Storage.prototype, 'setItem');
        setTheme('light');
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('coerces absent data-theme to "dark"', () => {
        document.documentElement.removeAttribute('data-theme');
        expect(getTheme()).toBe('dark');
    });
});

describe('installThemeEmbedListener', () => {
    beforeEach(() => {
        document.documentElement.removeAttribute('data-theme');
    });

    function postFromOrigin(origin: string, data: unknown): void {
        const evt = new MessageEvent('message', {
            data,
            origin,
            source: window,
        });
        window.dispatchEvent(evt);
    }

    it('applies a valid theme message of the default type', () => {
        const dispose = installThemeEmbedListener();
        postFromOrigin('https://example.com', { type: 'ws-scrcpy-web:theme', theme: 'light' });
        expect(getTheme()).toBe('light');
        dispose();
    });

    it('ignores wrong message type', () => {
        const dispose = installThemeEmbedListener();
        postFromOrigin('https://example.com', { type: 'other:theme', theme: 'light' });
        expect(getTheme()).toBe('dark');
        dispose();
    });

    it('ignores invalid theme values', () => {
        const dispose = installThemeEmbedListener();
        postFromOrigin('https://example.com', { type: 'ws-scrcpy-web:theme', theme: 'midnight' });
        postFromOrigin('https://example.com', { type: 'ws-scrcpy-web:theme', theme: null });
        expect(getTheme()).toBe('dark');
        dispose();
    });

    it('honors allowedOrigins allowlist', () => {
        const dispose = installThemeEmbedListener({ allowedOrigins: ['https://allowed.example'] });
        postFromOrigin('https://blocked.example', { type: 'ws-scrcpy-web:theme', theme: 'light' });
        expect(getTheme()).toBe('dark');
        postFromOrigin('https://allowed.example', { type: 'ws-scrcpy-web:theme', theme: 'light' });
        expect(getTheme()).toBe('light');
        dispose();
    });

    it('honors custom messageType', () => {
        const dispose = installThemeEmbedListener({ messageType: 'custom:theme' });
        postFromOrigin('https://example.com', { type: 'custom:theme', theme: 'light' });
        expect(getTheme()).toBe('light');
        dispose();
    });

    it('disposer detaches the listener', () => {
        const dispose = installThemeEmbedListener();
        dispose();
        postFromOrigin('https://example.com', { type: 'ws-scrcpy-web:theme', theme: 'light' });
        expect(getTheme()).toBe('dark');
    });

    it('responds to theme-request by re-posting theme-ready to event.source', () => {
        const source = { postMessage: vi.fn() } as unknown as Window;
        const dispose = installThemeEmbedListener();
        setTheme('light');
        const evt = new MessageEvent('message', {
            data: { type: 'ws-scrcpy-web:theme-request' },
            origin: 'https://example.com',
            source,
        });
        window.dispatchEvent(evt);
        expect(source.postMessage).toHaveBeenCalledWith(
            { type: 'ws-scrcpy-web:theme-ready', theme: 'light' },
            'https://example.com',
        );
        dispose();
    });

    it('ignores theme-request from non-allowed origin', () => {
        const source = { postMessage: vi.fn() } as unknown as Window;
        const dispose = installThemeEmbedListener({ allowedOrigins: ['https://allowed.example'] });
        const evt = new MessageEvent('message', {
            data: { type: 'ws-scrcpy-web:theme-request' },
            origin: 'https://blocked.example',
            source,
        });
        window.dispatchEvent(evt);
        expect(source.postMessage).not.toHaveBeenCalled();
        dispose();
    });
});

describe('notifyThemeReady', () => {
    beforeEach(() => {
        document.documentElement.removeAttribute('data-theme');
    });

    it('posts {type, theme} to the given target', () => {
        const target = { postMessage: vi.fn() } as unknown as Window;
        setTheme('light');
        notifyThemeReady(target);
        expect(target.postMessage).toHaveBeenCalledWith({ type: 'ws-scrcpy-web:theme-ready', theme: 'light' }, '*');
    });

    it('defaults target to window.parent', () => {
        const parentMock = { postMessage: vi.fn() };
        const originalParent = window.parent;
        Object.defineProperty(window, 'parent', { value: parentMock, configurable: true });
        // §25b — using-declaration replaces the prior try/finally that
        // restored window.parent after the test mutation.
        using _restoreParent = {
            [Symbol.dispose](): void {
                Object.defineProperty(window, 'parent', { value: originalParent, configurable: true });
            },
        };
        notifyThemeReady();
        expect(parentMock.postMessage).toHaveBeenCalled();
    });

    it('is a no-op when target equals window (not embedded)', () => {
        const spy = vi.spyOn(window, 'postMessage');
        notifyThemeReady(window);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('honors custom messageType (suffixed with -ready)', () => {
        const target = { postMessage: vi.fn() } as unknown as Window;
        notifyThemeReady(target, { messageType: 'custom:theme' });
        expect(target.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'custom:theme-ready' }), '*');
    });
});

describe('notifyThemeChanged', () => {
    beforeEach(() => {
        document.documentElement.removeAttribute('data-theme');
    });

    it('posts {type: <base>-changed, theme} to the given target', () => {
        const target = { postMessage: vi.fn() } as unknown as Window;
        setTheme('light');
        notifyThemeChanged(target);
        expect(target.postMessage).toHaveBeenCalledWith({ type: 'ws-scrcpy-web:theme-changed', theme: 'light' }, '*');
    });

    it('defaults target to window.parent', () => {
        const parentMock = { postMessage: vi.fn() };
        const originalParent = window.parent;
        Object.defineProperty(window, 'parent', { value: parentMock, configurable: true });
        // §25b — using-declaration replaces the prior try/finally that
        // restored window.parent after the test mutation.
        using _restoreParent = {
            [Symbol.dispose](): void {
                Object.defineProperty(window, 'parent', { value: originalParent, configurable: true });
            },
        };
        notifyThemeChanged();
        expect(parentMock.postMessage).toHaveBeenCalled();
    });

    it('is a no-op when target equals window (not embedded)', () => {
        const spy = vi.spyOn(window, 'postMessage');
        notifyThemeChanged(window);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('honors custom messageType (suffixed with -changed)', () => {
        const target = { postMessage: vi.fn() } as unknown as Window;
        notifyThemeChanged(target, { messageType: 'custom:theme' });
        expect(target.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'custom:theme-changed' }), '*');
    });
});
