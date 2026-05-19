// src/server/FrameReader.ts
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type net from 'net';

// scrcpy v4 wire-protocol constants. v4 added a "session packet flag" at
// MSB (bit 63) to distinguish session packets (rotate/resize events sent
// to the video socket) from media packets, AND shifted the pre-existing
// CONFIG + KEY_FRAME flag bits down by one to make room. Source: scrcpy
// v4.0 Streamer.java:
//   PACKET_FLAG_SESSION   = 1L << 63
//   PACKET_FLAG_CONFIG    = 1L << 62  (was 1L << 63 in v3)
//   PACKET_FLAG_KEY_FRAME = 1L << 61  (was 1L << 62 in v3)
const PACKET_FLAG_SESSION = 0x8000000000000000n;
const PTS_FLAG_CONFIG = 0x4000000000000000n;
const PTS_FLAG_KEYFRAME = 0x2000000000000000n;
const PTS_CLEAR_FLAGS = 0x1fffffffffffffffn;
const HEADER_SIZE = 12; // media packet: 8 (PTS + flags) + 4 (size); session packet: 4 (flags) + 4 (width) + 4 (height)

export interface ScrcpyFrame {
    type: 'config' | 'keyframe' | 'frame';
    pts: bigint;
    data: Buffer;
}

export class FrameReader {
    private buffer: Buffer = Buffer.alloc(0);
    private frameCallback?: ((frame: ScrcpyFrame) => void) | undefined;
    private endCallback?: (() => void) | undefined;

    constructor(private readonly socket: net.Socket) {
        socket.on('data', this.onData);
        socket.on('end', () => this.endCallback?.());
        socket.on('error', () => this.endCallback?.());
    }

    onFrame(callback: (frame: ScrcpyFrame) => void): void {
        this.frameCallback = callback;
    }

    onEnd(callback: () => void): void {
        this.endCallback = callback;
    }

    private onData = (chunk: Buffer): void => {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        this.drain();
    };

    private drain(): void {
        while (this.buffer.length >= HEADER_SIZE) {
            // v4 added in-stream session packets (rotate/resize events) on the
            // video socket. Distinguish them from media packets by the MSB of
            // the first 8 bytes: MSB set = session packet, MSB clear = media
            // packet. The initial session packet right after codec ID is parsed
            // by ScrcpyConnection.parseMetadata; any session packet that
            // arrives here is a mid-stream rotate/resize. We don't currently
            // expose rotation events downstream — skip the 12 bytes (flags +
            // width + height) and move on. See §24 in todo_ws_scrcpy_web.md
            // (deferred — promote on user request for live rotation handling).
            const rawHeader = this.buffer.readBigUInt64BE(0);
            if ((rawHeader & PACKET_FLAG_SESSION) !== 0n) {
                // Session packet: total 12 bytes (4 flags + 4 width + 4 height).
                // HEADER_SIZE is also 12, so the length check at loop top suffices.
                // No `data` segment follows — just consume the 12 bytes and continue.
                this.buffer = this.buffer.subarray(HEADER_SIZE);
                continue;
            }

            const size = this.buffer.readUInt32BE(8);
            const totalSize = HEADER_SIZE + size;

            if (this.buffer.length < totalSize) {
                break; // wait for more data
            }

            const isConfig = (rawHeader & PTS_FLAG_CONFIG) !== 0n;
            const isKeyframe = (rawHeader & PTS_FLAG_KEYFRAME) !== 0n;
            const pts = rawHeader & PTS_CLEAR_FLAGS;

            const data = this.buffer.subarray(HEADER_SIZE, totalSize);
            this.buffer = this.buffer.subarray(totalSize);

            const type = isConfig ? 'config' : isKeyframe ? 'keyframe' : 'frame';
            this.frameCallback?.({ type, pts, data });
        }
    }

    destroy(): void {
        this.socket.removeListener('data', this.onData);
        this.frameCallback = undefined;
        this.endCallback = undefined;
    }
}
