import { describe, expect, it, vi } from 'vitest';
import { attachFsChannelKeepAlive } from './fsChannelKeepAlive';

// Minimal channel-like stub exposing the TypedEmitter on/off surface that
// Multiplexer provides. We don't need a real Multiplexer to verify the
// register/unregister symmetry that prevents the 'empty'-handler leak (#38).
function makeChannel() {
    return {
        on: vi.fn(),
        off: vi.fn(),
    };
}

describe('attachFsChannelKeepAlive (#38)', () => {
    it("registers an 'empty' handler on attach", () => {
        const channel = makeChannel();
        attachFsChannelKeepAlive(channel);
        expect(channel.on).toHaveBeenCalledTimes(1);
        expect(channel.on.mock.calls[0]![0]).toBe('empty');
        expect(channel.on.mock.calls[0]![1]).toBeTypeOf('function');
    });

    it("detaches the SAME 'empty' handler reference via the returned disposer", () => {
        const channel = makeChannel();
        const detach = attachFsChannelKeepAlive(channel);
        const registered = channel.on.mock.calls[0]![1];

        detach();

        expect(channel.off).toHaveBeenCalledTimes(1);
        expect(channel.off.mock.calls[0]![0]).toBe('empty');
        // Same reference passed to on() and off() — the whole point: an
        // anonymous inline handler could never be removed.
        expect(channel.off.mock.calls[0]![1]).toBe(registered);
    });

    it('the registered handler is a no-op (keeps the channel alive, does not close it)', () => {
        const channel = makeChannel();
        attachFsChannelKeepAlive(channel);
        const registered = channel.on.mock.calls[0]![1] as (c: unknown) => void;
        // Should not throw and should not call anything on the channel.
        expect(() => registered(channel)).not.toThrow();
    });
});
