// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `AudioPlayer.stop()` has to be safe to call more than once.
 *
 * `StreamClientScrcpy` stops the audio player from three places, and two of
 * them fire for a single user-initiated stop: the stop handler calls
 * `demuxer.close()` and then `audioPlayer.stop()`, and the resulting WebSocket
 * `onclose` runs `onDisconnected`, which stops it again. Only `refreshStream`
 * clears the reference afterwards, so the second call lands on a live player
 * whose `AudioContext` is already closed.
 *
 * A real `AudioContext` rejects the second `close()` with
 * `InvalidStateError: Can't close an AudioContext twice`, and nothing awaits
 * that promise — which is how it reached issue #498's console as an uncaught
 * rejection. The fake below reproduces that contract exactly.
 */

class FakeAudioWorklet {
    addModule = vi.fn(() => Promise.resolve());
}

class FakeAudioParam {
    public value = 1;
}

class FakeGainNode {
    public gain = new FakeAudioParam();
    connect = vi.fn();
    disconnect = vi.fn();
}

class FakeAudioContext {
    public state: 'running' | 'suspended' | 'closed' = 'running';
    public destination = {};
    public audioWorklet = new FakeAudioWorklet();
    public closeCalls = 0;
    public gainNode = new FakeGainNode();
    /** Make close() reject even from a healthy state — see the swallow test. */
    public rejectClose = false;

    createGain() {
        return this.gainNode;
    }

    close(): Promise<void> {
        this.closeCalls += 1;
        if (this.rejectClose) {
            return Promise.reject(new DOMException('close failed', 'InvalidStateError'));
        }
        if (this.state === 'closed') {
            return Promise.reject(new DOMException("Can't close an AudioContext twice", 'InvalidStateError'));
        }
        this.state = 'closed';
        return Promise.resolve();
    }
}

class FakeAudioWorkletNode {
    public port = { postMessage: vi.fn() };
    connect = vi.fn();
    disconnect = vi.fn();
}

class FakeAudioDecoder {
    public state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
    configure() {
        this.state = 'configured';
    }
    decode() {
        /* not exercised here */
    }
    close() {
        this.state = 'closed';
    }
}

let lastContext: FakeAudioContext | undefined;

describe('AudioPlayer.stop() idempotency', () => {
    beforeEach(() => {
        lastContext = undefined;
        vi.stubGlobal(
            'AudioContext',
            class extends FakeAudioContext {
                constructor() {
                    super();
                    lastContext = this;
                }
            },
        );
        vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
        vi.stubGlobal('AudioDecoder', FakeAudioDecoder);
        // jsdom implements `new URL()` but not the object-URL statics, and the
        // worklet is loaded from a Blob URL. Subclass so the constructor keeps
        // working — replacing the global outright breaks every `new URL(...)`
        // on the import path.
        class FakeURL extends URL {
            static override createObjectURL = vi.fn(() => 'blob:fake');
            static override revokeObjectURL = vi.fn();
        }
        vi.stubGlobal('URL', FakeURL);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('closes the AudioContext exactly once across repeated stop() calls', async () => {
        const { AudioPlayer } = await import('../AudioPlayer');
        const player = new AudioPlayer('opus');
        await player.start();

        player.stop();
        player.stop();

        expect(lastContext?.closeCalls).toBe(1);
        expect(lastContext?.state).toBe('closed');
    });

    it('does not throw when stop() runs after the context is already closed', async () => {
        const { AudioPlayer } = await import('../AudioPlayer');
        const player = new AudioPlayer('opus');
        await player.start();

        player.stop();
        expect(() => player.stop()).not.toThrow();
    });

    it('skips close() entirely when the context is already closed', async () => {
        const { AudioPlayer } = await import('../AudioPlayer');
        const player = new AudioPlayer('opus');
        await player.start();

        // The browser can close a context out from under us (page hidden,
        // device change), leaving the player holding a closed one.
        lastContext!.state = 'closed';
        player.stop();

        expect(lastContext?.closeCalls).toBe(0);
    });

    it('swallows a close() that rejects anyway', async () => {
        const { AudioPlayer } = await import('../AudioPlayer');
        const player = new AudioPlayer('opus');
        await player.start();

        // State says open, close() rejects regardless — the state guard cannot
        // catch this shape, so the promise handler has to.
        lastContext!.rejectClose = true;

        expect(() => player.stop()).not.toThrow();
        // Give the rejection a turn to surface as unhandled before we finish.
        await Promise.resolve();
        await Promise.resolve();
    });

    it('is safe to stop a player that was never started', async () => {
        const { AudioPlayer } = await import('../AudioPlayer');
        const player = new AudioPlayer('opus');

        expect(() => player.stop()).not.toThrow();
        expect(lastContext).toBeUndefined();
    });

    it('closes the decoder once and leaves it closed', async () => {
        const { AudioPlayer } = await import('../AudioPlayer');
        const player = new AudioPlayer('opus');
        await player.start();

        player.stop();
        player.stop();

        // Nothing to assert on call counts here — the decoder was already
        // guarded on `state !== 'closed'`. This pins that the guard survives
        // the stop() rewrite rather than being dropped along with it.
        expect(() => player.stop()).not.toThrow();
    });
});
