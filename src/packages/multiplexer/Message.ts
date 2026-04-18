import { CloseEventClass } from './CloseEventClass';
import { MessageType } from './MessageType';

export class Message {
    public static parse(buffer: ArrayBuffer): Message {
        const view = new DataView(buffer);

        const type: MessageType = view.getUint8(0);
        const channelId = view.getUint32(1, true);
        const data: ArrayBuffer = buffer.slice(5);

        return new Message(type, channelId, data);
    }

    public static fromCloseEvent(id: number, code: number, reason?: string): Message {
        const reasonBytes = reason ? new TextEncoder().encode(reason) : new Uint8Array(0);
        const buf = new Uint8Array(2 + 4 + reasonBytes.byteLength);
        const view = new DataView(buf.buffer);
        view.setUint16(0, code, true);
        if (reasonBytes.byteLength) {
            view.setUint32(2, reasonBytes.byteLength, true);
            buf.set(reasonBytes, 6);
        }
        return new Message(MessageType.CloseChannel, id, buf.buffer);
    }

    public static createBuffer(
        type: MessageType,
        channelId: number,
        data?: ArrayBuffer | Uint8Array,
    ): Uint8Array<ArrayBuffer> {
        const result = new Uint8Array(5 + (data ? data.byteLength : 0));
        const view = new DataView(result.buffer);
        view.setUint8(0, type);
        view.setUint32(1, channelId, true);
        if (data?.byteLength) {
            result.set(data instanceof Uint8Array ? data : new Uint8Array(data), 5);
        }
        return result as Uint8Array<ArrayBuffer>;
    }

    public constructor(
        public readonly type: MessageType,
        public readonly channelId: number,
        public readonly data: ArrayBuffer,
    ) {}

    public toCloseEvent(): CloseEvent {
        let code: number | undefined;
        let reason: string | undefined;
        if (this.data && this.data.byteLength) {
            const view = new DataView(this.data);
            code = view.getUint16(0, true);
            if (this.data.byteLength > 6) {
                const length = view.getUint32(2, true);
                reason = new TextDecoder().decode(new Uint8Array(this.data, 6, length));
            }
        }
        return new CloseEventClass('close', {
            code,
            reason,
            wasClean: code === 1000,
        });
    }

    public toBuffer(): Uint8Array<ArrayBuffer> {
        return Message.createBuffer(this.type, this.channelId, this.data);
    }
}
