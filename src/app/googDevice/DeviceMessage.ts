import Util from '../Util';

export default class DeviceMessage {
    public static TYPE_CLIPBOARD = 0;
    public static TYPE_ACK_CLIPBOARD = 1;
    public static TYPE_UHID_OUTPUT = 2;
    public static TYPE_PUSH_RESPONSE = 101; // custom, not used with vanilla scrcpy v3.x

    public static readonly MAGIC_BYTES_MESSAGE = Util.stringToUtf8ByteArray('scrcpy_message');

    constructor(
        public readonly type: number,
        protected readonly buffer: Buffer,
    ) {}

    public static fromBuffer(data: ArrayBuffer): DeviceMessage {
        const magicSize = this.MAGIC_BYTES_MESSAGE.length;
        const buffer = Buffer.from(data, magicSize, data.byteLength - magicSize);
        const type = buffer.readUInt8(0);
        return new DeviceMessage(type, buffer);
    }

    public static fromRaw(data: Uint8Array): DeviceMessage {
        const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        const type = buffer.readUInt8(0);
        return new DeviceMessage(type, buffer);
    }

    public getText(): string {
        if (this.type !== DeviceMessage.TYPE_CLIPBOARD) {
            throw TypeError(`Wrong message type: ${this.type}`);
        }
        if (!this.buffer) {
            throw Error('Empty buffer');
        }
        let offset = 1;
        const length = this.buffer.readInt32BE(offset);
        offset += 4;
        const textBytes = this.buffer.slice(offset, offset + length);
        return Util.utf8ByteArrayToString(textBytes);
    }

    public getAckSequence(): bigint {
        if (this.type !== DeviceMessage.TYPE_ACK_CLIPBOARD) {
            throw TypeError(`Wrong message type: ${this.type}`);
        }
        return this.buffer.readBigUInt64BE(1);
    }

    public getPushStats(): { id: number; code: number } {
        if (this.type !== DeviceMessage.TYPE_PUSH_RESPONSE) {
            throw TypeError(`Wrong message type: ${this.type}`);
        }
        if (!this.buffer) {
            throw Error('Empty buffer');
        }
        const id = this.buffer.readInt16BE(1);
        const code = this.buffer.readInt8(3);
        return { id, code };
    }

    public toString(): string {
        let desc: string;
        if (this.type === DeviceMessage.TYPE_CLIPBOARD && this.buffer) {
            desc = `, text=[${this.getText()}]`;
        } else {
            desc = this.buffer ? `, buffer=[${this.buffer.join(',')}]` : '';
        }
        return `DeviceMessage{type=${this.type}${desc}}`;
    }
}
