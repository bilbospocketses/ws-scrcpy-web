// src/app/BinaryReader.ts

export class BinaryReader {
    private view: DataView;
    private pos: number;

    constructor(data: Uint8Array, offset = 0) {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        this.pos = offset;
    }

    /**
     * Bounds-check a read of `n` bytes at the current position against the
     * logical view length. Throws rather than reading past the message — which,
     * for readBytes(), would otherwise alias unrelated bytes of the backing
     * ArrayBuffer (an out-of-message information leak on untrusted input).
     */
    private check(n: number): void {
        if (!Number.isInteger(n) || n < 0 || this.pos + n > this.view.byteLength) {
            throw new RangeError(
                `BinaryReader out of bounds: need ${n} byte(s) at offset ${this.pos}, have ${this.remaining}`,
            );
        }
    }

    readUInt8(): number {
        this.check(1);
        const v = this.view.getUint8(this.pos);
        this.pos += 1;
        return v;
    }

    readInt8(): number {
        this.check(1);
        const v = this.view.getInt8(this.pos);
        this.pos += 1;
        return v;
    }

    readUInt16BE(): number {
        this.check(2);
        const v = this.view.getUint16(this.pos);
        this.pos += 2;
        return v;
    }

    readInt16BE(): number {
        this.check(2);
        const v = this.view.getInt16(this.pos);
        this.pos += 2;
        return v;
    }

    readUInt32BE(): number {
        this.check(4);
        const v = this.view.getUint32(this.pos);
        this.pos += 4;
        return v;
    }

    readInt32BE(): number {
        this.check(4);
        const v = this.view.getInt32(this.pos);
        this.pos += 4;
        return v;
    }

    readUInt32LE(): number {
        this.check(4);
        const v = this.view.getUint32(this.pos, true);
        this.pos += 4;
        return v;
    }

    readBigUInt64BE(): bigint {
        this.check(8);
        const v = this.view.getBigUint64(this.pos);
        this.pos += 8;
        return v;
    }

    readBytes(length: number): Uint8Array {
        this.check(length);
        const data = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, length);
        this.pos += length;
        return data;
    }

    readString(length: number): string {
        const bytes = this.readBytes(length);
        return new TextDecoder().decode(bytes);
    }

    get offset(): number {
        return this.pos;
    }

    get remaining(): number {
        return this.view.byteLength - this.pos;
    }
}
