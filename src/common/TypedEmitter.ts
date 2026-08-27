import { EventEmitter } from 'events';

export type EventMap = Record<string, any>;
export type EventKey<T extends EventMap> = string & keyof T;
export type EventReceiver<T> = (params: T) => void;

interface Emitter<T extends EventMap> {
    on<K extends EventKey<T>>(eventName: K, fn: EventReceiver<T[K]>): void;
    off<K extends EventKey<T>>(eventName: K, fn: EventReceiver<T[K]>): void;
    emit<K extends EventKey<T>>(eventName: K, params: T[K]): void;
}

export class TypedEmitter<T extends EventMap> implements Emitter<T> {
    private emitter = new EventEmitter();
    addEventListener<K extends EventKey<T>>(eventName: K, fn: EventReceiver<T[K]>): void {
        this.emitter.on(eventName, fn);
    }

    removeEventListener<K extends EventKey<T>>(eventName: K, fn: EventReceiver<T[K]>): void {
        this.emitter.off(eventName, fn);
    }

    /**
     * DOM `EventTarget.dispatchEvent` semantics, which differ from Node's
     * `EventEmitter` in one place that matters.
     *
     * Dispatching to nobody is a no-op in the DOM. Node's `EventEmitter`
     * instead treats `'error'` specially and **throws** when it is emitted with
     * no `'error'` listener registered. Since this class presents an
     * `EventTarget` surface over an `EventEmitter`, that Node behaviour leaked
     * into a contract that does not have it: a WebSocket error with nothing
     * listening crashed the caller instead of being ignored.
     *
     * `Multiplexer` dispatches its socket's error event, and a channel's
     * transport is itself a `Multiplexer` — so one dropped socket threw on the
     * inner hop and filled the console with `Unhandled error. (undefined)` on
     * every reconnect attempt. (`undefined` because the `events` polyfill
     * formats `er.message`, and a plain `Event` has none.)
     *
     * {@link emit} carries the same guard, for the same reason — see there.
     */
    dispatchEvent(event: Event): boolean {
        if (this.isUnhandledError(event.type)) {
            return false;
        }
        return this.emitter.emit(event.type, event);
    }

    /**
     * True when `eventName` is Node's magic `'error'` channel and nothing is
     * listening — the one case where the underlying `EventEmitter` throws
     * instead of returning `false`.
     */
    private isUnhandledError(eventName: string): boolean {
        return eventName === 'error' && this.emitter.listenerCount('error') === 0;
    }

    on<K extends EventKey<T>>(eventName: K, fn: EventReceiver<T[K]>): void {
        this.emitter.on(eventName, fn);
    }

    once<K extends EventKey<T>>(eventName: K, fn: EventReceiver<T[K]>): void {
        this.emitter.once(eventName, fn);
    }

    off<K extends EventKey<T>>(eventName: K, fn: EventReceiver<T[K]>): void {
        this.emitter.off(eventName, fn);
    }

    /**
     * Emit a typed event, returning whether anything was listening.
     *
     * Carries the same `'error'` guard as {@link dispatchEvent}. Node's
     * `EventEmitter` reserves `'error'` and throws when it is emitted
     * unhandled, but a `TypedEmitter` event map declares `'error'` as an
     * ordinary entry like any other — `HostTrackerEvents` types it as a plain
     * `string`. The type says "ordinary event"; the runtime disagreed.
     *
     * That was not theoretical: nothing in the codebase listens for
     * `HostTracker`'s `'error'`, so every `MessageType.ERROR` the server sent
     * threw inside `onSocketMessage` and aborted the rest of the handler. The
     * throw bought nothing either — `HostTracker` has already written the
     * message to `console.error` by the time it emits, so the diagnostic was
     * never at risk of being lost.
     *
     * Emitters that do want to hear about errors still do: attaching a
     * listener restores ordinary delivery, which is how
     * `AdbkitFilePushStream` → `FilePushHandler` works.
     */
    emit<K extends EventKey<T>>(eventName: K, params: T[K]): boolean {
        if (this.isUnhandledError(eventName)) {
            return false;
        }
        return this.emitter.emit(eventName, params);
    }
}
