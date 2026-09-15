import net from 'net';
import { describe, expect, it } from 'vitest';
import { FrameReader, type ScrcpyFrame, type ScrcpySessionChange } from '../FrameReader';

// Item 24. scrcpy v4 sends a "session packet" on the video socket whenever the
// capture session changes — a rotation or a resize. `drain()` used to detect
// one by the MSB flag and throw the whole 12 bytes away, so the browser never
// learned the new geometry and kept rendering (and mapping touches) against the
// pre-rotation size. These tests pin the parse.
//
// Layout is the one `ScrcpyConnection.parseMetadata` already documents for the
// initial session packet, which is the same packet in the same shape:
//   @0-3  flags  — MSB set marks a session packet
//   @4-7  width  (BE)
//   @8-11 height (BE)
const SESSION_FLAG = 0x80000000;

function sessionPacket(width: number, height: number, flags = SESSION_FLAG): Buffer {
    const buf = Buffer.alloc(12);
    buf.writeUInt32BE(flags >>> 0, 0);
    buf.writeUInt32BE(width, 4);
    buf.writeUInt32BE(height, 8);
    return buf;
}

// Media packet: 8 bytes PTS+flags, 4 bytes payload size, then the payload.
// v4 shifted CONFIG to bit 62 and KEY_FRAME to bit 61 to make room for the
// session flag at bit 63 — so a media packet always has its MSB clear.
function mediaPacket(payload: Buffer, ptsWithFlags = 0n): Buffer {
    const header = Buffer.alloc(12);
    header.writeBigUInt64BE(ptsWithFlags, 0);
    header.writeUInt32BE(payload.length, 8);
    return Buffer.concat([header, payload]);
}

function reader(): {
    socket: net.Socket;
    frames: ScrcpyFrame[];
    changes: ScrcpySessionChange[];
    instance: FrameReader;
} {
    const socket = new net.Socket();
    const frames: ScrcpyFrame[] = [];
    const changes: ScrcpySessionChange[] = [];
    const instance = new FrameReader(socket);
    instance.onFrame((frame) => frames.push(frame));
    instance.onSessionChange((change) => changes.push(change));
    return { socket, frames, changes, instance };
}

describe('FrameReader session packets', () => {
    it('reports the new dimensions instead of discarding them', () => {
        const { socket, changes } = reader();

        socket.emit('data', sessionPacket(1080, 2400));

        expect(changes).toEqual([{ width: 1080, height: 2400 }]);
    });

    it('does not mistake a session packet for a frame', () => {
        const { socket, frames } = reader();

        socket.emit('data', sessionPacket(1080, 2400));

        expect(frames).toEqual([]);
    });

    it('keeps parsing media packets after a rotation', () => {
        const { socket, frames, changes } = reader();

        // The realistic ordering: rotation lands mid-stream, and the encoder
        // restarts with a fresh config packet right behind it. If the session
        // packet were consumed by even one byte too many or too few, this
        // config packet would be read at the wrong offset and the stream would
        // desynchronise for good.
        const config = mediaPacket(Buffer.from([1, 2, 3, 4]), 0x4000000000000000n);
        socket.emit('data', Buffer.concat([sessionPacket(2400, 1080), config]));

        expect(changes).toEqual([{ width: 2400, height: 1080 }]);
        expect(frames).toHaveLength(1);
        expect(frames[0]?.type).toBe('config');
        expect(frames[0]?.data).toEqual(Buffer.from([1, 2, 3, 4]));
    });

    it('waits for a session packet split across TCP chunks rather than half-reading it', () => {
        const { socket, changes } = reader();

        const packet = sessionPacket(1080, 2400);
        socket.emit('data', packet.subarray(0, 7));
        expect(changes).toEqual([]);

        socket.emit('data', packet.subarray(7));
        expect(changes).toEqual([{ width: 1080, height: 2400 }]);
    });

    it('reports every rotation in a burst, in order', () => {
        const { socket, changes } = reader();

        socket.emit('data', Buffer.concat([sessionPacket(2400, 1080), sessionPacket(1080, 2400)]));

        expect(changes).toEqual([
            { width: 2400, height: 1080 },
            { width: 1080, height: 2400 },
        ]);
    });

    it('stops reporting once destroyed', () => {
        const { socket, changes, instance } = reader();

        instance.destroy();
        socket.emit('data', sessionPacket(1080, 2400));

        expect(changes).toEqual([]);
    });
});
