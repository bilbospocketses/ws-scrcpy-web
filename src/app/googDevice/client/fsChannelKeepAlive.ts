/**
 * Minimal channel surface needed to keep the FSLS channel alive. Both
 * Multiplexer and any test stub expose this `on`/`off` pair (from TypedEmitter).
 */
export interface KeepAliveChannel {
    on(eventName: 'empty', fn: (channel: unknown) => void): void;
    off(eventName: 'empty', fn: (channel: unknown) => void): void;
}

/**
 * Register a no-op 'empty' handler on the FSLS channel and return a disposer
 * that removes that exact handler reference.
 *
 * Why: the root multiplexer auto-closes a channel that transiently has no
 * sub-channels (e.g. between STAT finishing and LIST starting). The FSLS
 * channel's lifecycle is owned by the modal, so we suppress that auto-close by
 * registering an 'empty' handler. Registering it inline (an anonymous arrow)
 * leaks it — `off` needs the same reference. This helper keeps the register /
 * unregister symmetric so onBeforeClose can detach it. (#38)
 */
export function attachFsChannelKeepAlive(channel: KeepAliveChannel): () => void {
    const handler = (): void => {
        // no-op: keep the FSLS channel alive
    };
    channel.on('empty', handler);
    return (): void => {
        channel.off('empty', handler);
    };
}
