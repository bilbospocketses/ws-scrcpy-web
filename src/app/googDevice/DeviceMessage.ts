import { BinaryReader } from '../BinaryReader';

export default class DeviceMessage {
    public static TYPE_CLIPBOARD = 0;
    public static TYPE_ACK_CLIPBOARD = 1;
    public static TYPE_UHID_OUTPUT = 2;
    public static TYPE_PUSH_RESPONSE = 101; // custom, not used with vanilla scrcpy v3.x

    public static readonly MAGIC_BYTES_MESSAGE = new TextEncoder().encode('scrcpy_message');

    constructor(
        public readonly type: number,
        protected readonly data: Uint8Array,
    ) {}

    public static fromBuffer(data: ArrayBuffer): DeviceMessage {
        const magicSize = this.MAGIC_BYTES_MESSAGE.length;
        const slice = new Uint8Array(data, magicSize, data.byteLength - magicSize);
        const type = slice[0];
        return new DeviceMessage(type, slice);
    }

    public static fromRaw(data: Uint8Array): DeviceMessage {
        const type = data[0];
        return new DeviceMessage(type, data);
    }

    public getText(): string {
        if (this.type !== DeviceMessage.TYPE_CLIPBOARD) {
            throw TypeError(`Wrong message type: ${this.type}`);
        }
        if (!this.data) {
            throw Error('Empty buffer');
        }
        const reader = new BinaryReader(this.data, 1);
        const length = reader.readInt32BE();
        const textBytes = reader.readBytes(length);
        return new TextDecoder().decode(textBytes);
    }

    public getAckSequence(): bigint {
        if (this.type !== DeviceMessage.TYPE_ACK_CLIPBOARD) {
            throw TypeError(`Wrong message type: ${this.type}`);
        }
        return new BinaryReader(this.data, 1).readBigUInt64BE();
    }

    public getPushStats(): { id: number; code: number } {
        if (this.type !== DeviceMessage.TYPE_PUSH_RESPONSE) {
            throw TypeError(`Wrong message type: ${this.type}`);
        }
        if (!this.data) {
            throw Error('Empty buffer');
        }
        const reader = new BinaryReader(this.data, 1);
        const id = reader.readInt16BE();
        const code = reader.readInt8();
        return { id, code };
    }

    public toString(): string {
        let desc: string;
        if (this.type === DeviceMessage.TYPE_CLIPBOARD && this.data) {
            desc = `, text=[${this.getText()}]`;
        } else {
            desc = this.data ? `, buffer=[${Array.from(this.data).join(',')}]` : '';
        }
        return `DeviceMessage{type=${this.type}${desc}}`;
    }
}
