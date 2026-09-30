import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openBrowser } from '../openBrowser';

// A missing opener (ENOENT) is not thrown by `spawn`: it is EMITTED on the
// child afterwards, outside openBrowser's try/catch. With no 'error' listener,
// EventEmitter throws it, which in the server is an uncaught exception. These
// tests emit that error on the child each branch spawned; without the listener
// the emit throws and the test fails.

type FakeChild = EventEmitter & { unref: ReturnType<typeof vi.fn> };

const { children } = vi.hoisted(() => ({ children: [] as FakeChild[] }));

vi.mock('child_process', () => ({
    spawn: vi.fn(() => {
        const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
        children.push(child);
        return child;
    }),
}));

const realPlatform = process.platform;

afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    children.length = 0;
});

describe('openBrowser survives a spawn error on every platform branch', () => {
    it.each(['win32', 'linux', 'darwin'] as const)('%s', (platform) => {
        Object.defineProperty(process, 'platform', { value: platform });
        openBrowser('http://localhost:8000');

        expect(children).toHaveLength(1);
        const child = children[0] as FakeChild;
        expect(child.unref).toHaveBeenCalledTimes(1);
        const enoent = Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' });
        expect(() => child.emit('error', enoent)).not.toThrow();
    });
});
