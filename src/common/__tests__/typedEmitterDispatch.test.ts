import { describe, expect, it, vi } from 'vitest';
import { TypedEmitter } from '../TypedEmitter';

/**
 * `TypedEmitter` presents a DOM `EventTarget` surface (`addEventListener` /
 * `dispatchEvent`) over Node's `EventEmitter`. Those two disagree about one
 * thing, and it matters:
 *
 *   - DOM `dispatchEvent` on an event nobody listens for is a no-op.
 *   - Node's `EventEmitter` THROWS when `'error'` is emitted with no `'error'`
 *     listener registered.
 *
 * So dispatching a WebSocket `error` event through this shim used to crash the
 * caller. `Multiplexer` does exactly that from its socket error handler, and
 * because a channel's transport is itself a `Multiplexer`, one dropped socket
 * threw on the inner hop and filled the console with
 * `Error: Unhandled error. (undefined)` on every reconnect attempt.
 *
 * The `(undefined)` is the tell: the `events` polyfill formats the message as
 * `'Unhandled error.' + (er ? ' (' + er.message + ')' : '')`, and a plain
 * `Event` has no `.message`.
 */

type TestEvents = {
    error: Event;
    close: Event;
    message: Event;
};

describe('TypedEmitter.dispatchEvent', () => {
    it('does not throw when an error event has no listener', () => {
        const emitter = new TypedEmitter<TestEvents>();
        expect(() => emitter.dispatchEvent(new Event('error'))).not.toThrow();
    });

    it('reports that nothing handled the unlistened error event', () => {
        const emitter = new TypedEmitter<TestEvents>();
        expect(emitter.dispatchEvent(new Event('error'))).toBe(false);
    });

    it('still delivers error events to a registered listener', () => {
        const emitter = new TypedEmitter<TestEvents>();
        const seen: Event[] = [];
        emitter.on('error', (e) => seen.push(e));

        const event = new Event('error');
        expect(emitter.dispatchEvent(event)).toBe(true);
        expect(seen).toEqual([event]);
    });

    it('delivers to a listener added via addEventListener', () => {
        const emitter = new TypedEmitter<TestEvents>();
        const listener = vi.fn();
        emitter.addEventListener('error', listener);

        emitter.dispatchEvent(new Event('error'));
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('goes back to swallowing once the only listener is removed', () => {
        const emitter = new TypedEmitter<TestEvents>();
        const listener = vi.fn();
        emitter.on('error', listener);
        emitter.off('error', listener);

        expect(() => emitter.dispatchEvent(new Event('error'))).not.toThrow();
        expect(listener).not.toHaveBeenCalled();
    });

    it('leaves non-error events alone', () => {
        const emitter = new TypedEmitter<TestEvents>();
        // Unlistened non-error dispatch was always a no-op; it must stay one.
        expect(emitter.dispatchEvent(new Event('close'))).toBe(false);

        const listener = vi.fn();
        emitter.on('close', listener);
        expect(emitter.dispatchEvent(new Event('close'))).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('survives the nested dispatch that a Multiplexer chain produces', () => {
        // Outer socket errors -> outer emitter dispatches -> the listener is
        // an inner emitter that dispatches again with nothing behind it. That
        // second hop is where the throw used to happen.
        const outer = new TypedEmitter<TestEvents>();
        const inner = new TypedEmitter<TestEvents>();
        outer.on('error', (event) => {
            inner.dispatchEvent(event);
        });

        expect(() => outer.dispatchEvent(new Event('error'))).not.toThrow();
    });
});

/**
 * `emit()` needs the same guard, because a `TypedEmitter` event map declares
 * `'error'` as an ordinary entry — `HostTrackerEvents` types it as a plain
 * `string` — while Node's `EventEmitter` reserves it and throws when unhandled.
 *
 * Nothing in the codebase listens for `HostTracker`'s `'error'`, so every
 * `MessageType.ERROR` from the server threw inside `onSocketMessage` and
 * aborted the handler. The message had already been written to `console.error`
 * a line earlier, so the throw protected nothing.
 */
describe('TypedEmitter.emit', () => {
    type StringErrorEvents = { error: string; ready: number };

    it('does not throw on an unhandled error event', () => {
        const emitter = new TypedEmitter<StringErrorEvents>();
        expect(() => emitter.emit('error', 'server said no')).not.toThrow();
    });

    it('reports that nothing handled it', () => {
        const emitter = new TypedEmitter<StringErrorEvents>();
        expect(emitter.emit('error', 'server said no')).toBe(false);
    });

    it('does not throw when the payload is undefined', () => {
        const emitter = new TypedEmitter<{ error: string | undefined }>();
        // The shape that produced `Unhandled error. (undefined)`.
        expect(() => emitter.emit('error', undefined)).not.toThrow();
    });

    it('still delivers to a listener, payload intact', () => {
        const emitter = new TypedEmitter<StringErrorEvents>();
        const seen: string[] = [];
        emitter.on('error', (msg) => seen.push(msg));

        expect(emitter.emit('error', 'server said no')).toBe(true);
        expect(seen).toEqual(['server said no']);
    });

    it('leaves non-error events untouched', () => {
        const emitter = new TypedEmitter<StringErrorEvents>();
        expect(emitter.emit('ready', 1)).toBe(false);

        const listener = vi.fn();
        emitter.on('ready', listener);
        expect(emitter.emit('ready', 2)).toBe(true);
        expect(listener).toHaveBeenCalledWith(2);
    });

    it('goes back to swallowing when the last listener is removed', () => {
        const emitter = new TypedEmitter<StringErrorEvents>();
        const listener = vi.fn();
        emitter.on('error', listener);
        emitter.off('error', listener);

        expect(() => emitter.emit('error', 'later')).not.toThrow();
        expect(listener).not.toHaveBeenCalled();
    });

    it('does not throw for a once() listener that has already fired', () => {
        const emitter = new TypedEmitter<StringErrorEvents>();
        const listener = vi.fn();
        emitter.once('error', listener);

        emitter.emit('error', 'first');
        // `once` removed itself, so the second emit is unhandled again.
        expect(() => emitter.emit('error', 'second')).not.toThrow();
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
