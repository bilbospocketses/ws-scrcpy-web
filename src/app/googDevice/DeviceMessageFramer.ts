import DeviceMessage from './DeviceMessage';

const TAG = '[DeviceMessageFramer]';

/**
 * Largest device message scrcpy will ever send: `DEVICE_MSG_MAX_SIZE` in
 * upstream app/src/device_msg.h, `MESSAGE_MAX_SIZE` in DeviceMessageWriter.java
 * (both `1 << 18`, 256 KiB). A CLIPBOARD message at the limit is exactly this
 * long, since the device truncates its text to `MESSAGE_MAX_SIZE - 5`.
 */
export const DEVICE_MSG_MAX_SIZE = 1 << 18;

const EMPTY = new Uint8Array(0);

/**
 * Total length of the message at the start of `buf`, read from its header.
 * Layouts are upstream's DeviceMessageWriter.java / device_msg.c (v5.0):
 *
 * - CLIPBOARD (0):    type(1) + length(4, BE) + UTF-8 text(length)
 * - ACK_CLIPBOARD (1): type(1) + sequence(8, BE)
 * - UHID_OUTPUT (2):  type(1) + id(2, BE) + size(2, BE) + data(size)
 *
 * Returns `0` when there are not yet enough bytes to know, and `-1` for a type
 * this client does not know, whose length therefore cannot be found.
 */
export function deviceMessageLength(buf: Uint8Array): number {
    if (buf.length < 1) return 0;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    switch (buf[0]) {
        case DeviceMessage.TYPE_CLIPBOARD:
            return buf.length < 5 ? 0 : 5 + view.getUint32(1);
        case DeviceMessage.TYPE_ACK_CLIPBOARD:
            return 1 + 8;
        case DeviceMessage.TYPE_UHID_OUTPUT:
            return buf.length < 5 ? 0 : 5 + view.getUint16(3);
        default:
            return -1;
    }
}

/**
 * Turns the device-message byte stream back into whole messages.
 *
 * The server relays the scrcpy control socket's bytes as they come off TCP, so
 * a WebSocket frame on the DEVICE_MSG channel is a TCP chunk, not a message: a
 * long clipboard text arrives split over several frames, and two messages sent
 * back to back can share one. Reading each frame as exactly one message cut
 * the first case short and lost the second message in the other.
 *
 * One framer per connection — `ScrcpyDemuxer` owns it, and a reconnect builds a
 * new demuxer — so a half-received message never leaks into the next session.
 */
export class DeviceMessageFramer {
    private buffer: Uint8Array = EMPTY;
    /** Bytes still to discard from an oversized message that has not all arrived. */
    private skipRemaining = 0;
    private warnedUnknownType = false;

    constructor(private readonly onMessage: (message: Uint8Array) => void) {}

    /** Append one relayed chunk and deliver every message it completes. */
    public push(chunk: Uint8Array): void {
        let data = chunk;
        if (this.skipRemaining > 0) {
            const skipped = Math.min(this.skipRemaining, data.length);
            this.skipRemaining -= skipped;
            data = data.subarray(skipped);
        }
        if (data.length === 0) return;

        if (this.buffer.length === 0) {
            this.buffer = data.slice();
        } else {
            const joined = new Uint8Array(this.buffer.length + data.length);
            joined.set(this.buffer, 0);
            joined.set(data, this.buffer.length);
            this.buffer = joined;
        }

        let offset = 0;
        while (offset < this.buffer.length) {
            const rest = this.buffer.subarray(offset);
            const length = deviceMessageLength(rest);
            if (length < 0) {
                // Without a known type there is no length, so no way to find
                // where the next message starts. Drop what we hold rather than
                // let one bad byte block every message after it.
                if (!this.warnedUnknownType) {
                    this.warnedUnknownType = true;
                    console.warn(TAG, `unknown device message type ${rest[0]}; dropping ${rest.length} bytes`);
                }
                this.buffer = EMPTY;
                return;
            }
            if (length === 0) break; // header incomplete
            if (length > DEVICE_MSG_MAX_SIZE) {
                // The header still says where it ends, so skip exactly that
                // much and stay aligned with whatever follows.
                console.warn(
                    TAG,
                    `device message of ${length} bytes exceeds the ${DEVICE_MSG_MAX_SIZE}-byte limit; dropping it`,
                );
                if (rest.length >= length) {
                    offset += length;
                    continue;
                }
                this.skipRemaining = length - rest.length;
                this.buffer = EMPTY;
                return;
            }
            if (rest.length < length) break; // body incomplete
            this.onMessage(rest.slice(0, length));
            offset += length;
        }
        this.buffer = offset === 0 ? this.buffer : this.buffer.slice(offset);
    }

    /** Forget any partial message. */
    public reset(): void {
        this.buffer = EMPTY;
        this.skipRemaining = 0;
    }

    /** Bytes held while waiting for the rest of a message. */
    public get pendingBytes(): number {
        return this.buffer.length;
    }
}
