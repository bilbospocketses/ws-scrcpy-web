import { describe, expect, it, vi } from 'vitest';
import { type ShutdownClosable, StreamRegistry } from '../liveStreams';

function session(registry: StreamRegistry, onClose?: () => void): ShutdownClosable & { closed: number } {
    const s = {
        closed: 0,
        closeForShutdown: vi.fn(() => {
            s.closed++;
            onClose?.();
            // A real session releases itself, which takes it off the registry.
            registry.remove(s);
        }),
    };
    registry.add(s);
    return s;
}

describe('StreamRegistry', () => {
    it('closes every open session once and reports how many', () => {
        const registry = new StreamRegistry();
        const a = session(registry);
        const b = session(registry);

        expect(registry.closeAllForShutdown()).toBe(2);

        expect(a.closed).toBe(1);
        expect(b.closed).toBe(1);
        expect(registry.size()).toBe(0);
    });

    it('does not close a session that was released before the stop', () => {
        const registry = new StreamRegistry();
        const gone = session(registry);
        const open = session(registry);
        registry.remove(gone);

        expect(registry.closeAllForShutdown()).toBe(1);

        expect(gone.closed).toBe(0);
        expect(open.closed).toBe(1);
    });

    it('one session throwing does not keep the others open, and none is left tracked', () => {
        const registry = new StreamRegistry();
        const broken: ShutdownClosable = {
            closeForShutdown: () => {
                throw new Error('socket already torn down');
            },
        };
        registry.add(broken);
        const after = session(registry);

        expect(() => registry.closeAllForShutdown()).not.toThrow();

        expect(after.closed).toBe(1);
        expect(registry.size()).toBe(0);
    });

    it('a second stop finds nothing left to close', () => {
        const registry = new StreamRegistry();
        session(registry);
        registry.closeAllForShutdown();

        expect(registry.closeAllForShutdown()).toBe(0);
    });

    it('is stopping from the moment the open sessions are closed, so a later one can be refused', () => {
        const registry = new StreamRegistry();
        expect(registry.isStopping()).toBe(false);

        registry.closeAllForShutdown();

        expect(registry.isStopping()).toBe(true);
    });

    it('a sweep that finds no session still marks the stop', () => {
        const registry = new StreamRegistry();

        expect(registry.closeAllForShutdown()).toBe(0);

        expect(registry.isStopping()).toBe(true);
    });

    it('a stop that did not happen accepts sessions again', () => {
        const registry = new StreamRegistry();
        registry.closeAllForShutdown();

        registry.cancelStop();

        expect(registry.isStopping()).toBe(false);
    });
});
