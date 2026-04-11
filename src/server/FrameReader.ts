// src/server/FrameReader.ts
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type net from 'net';

const PTS_FLAG_CONFIG = 0x8000000000000000n;
const PTS_FLAG_KEYFRAME = 0x4000000000000000n;
const PTS_CLEAR_FLAGS = 0x3fffffffffffffffn;
const HEADER_SIZE = 12; // 8 (PTS) + 4 (size)

export interface ScrcpyFrame {
    type: 'config' | 'keyframe' | 'frame';
    pts: bigint;
    data: Buffer;
}

export class FrameReader {
    private buffer = Buffer.alloc(0);
    private frameCallback?: (frame: ScrcpyFrame) => void;
    private endCallback?: () => void;

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
            const rawPts = this.buffer.readBigUInt64BE(0);
            const size = this.buffer.readUInt32BE(8);
            const totalSize = HEADER_SIZE + size;

            if (this.buffer.length < totalSize) {
                break; // wait for more data
            }

            const isConfig = (rawPts & PTS_FLAG_CONFIG) !== 0n;
            const isKeyframe = (rawPts & PTS_FLAG_KEYFRAME) !== 0n;
            const pts = rawPts & PTS_CLEAR_FLAGS;

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
