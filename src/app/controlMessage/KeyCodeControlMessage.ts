import { BinaryWriter } from '../BinaryWriter';
import { ControlMessage, type ControlMessageInterface } from './ControlMessage';

export interface KeyCodeControlMessageInterface extends ControlMessageInterface {
    action: number;
    keycode: number;
    repeat: number;
    metaState: number;
}

export class KeyCodeControlMessage extends ControlMessage {
    public static PAYLOAD_LENGTH = 13;

    constructor(
        readonly action: number,
        readonly keycode: number,
        readonly repeat: number,
        readonly metaState: number,
    ) {
        super(ControlMessage.TYPE_KEYCODE);
    }

    /**
     * @override
     */
    public override toUint8Array(): Uint8Array {
        return new BinaryWriter(KeyCodeControlMessage.PAYLOAD_LENGTH + 1)
            .writeInt8(this.type)
            .writeInt8(this.action)
            .writeInt32BE(this.keycode)
            .writeInt32BE(this.repeat)
            .writeInt32BE(this.metaState)
            .toUint8Array();
    }

    public override toString(): string {
        return `KeyCodeControlMessage{action=${this.action}, keycode=${this.keycode}, metaState=${this.metaState}}`;
    }

    public override toJSON(): KeyCodeControlMessageInterface {
        return {
            type: this.type,
            action: this.action,
            keycode: this.keycode,
            metaState: this.metaState,
            repeat: this.repeat,
        };
    }
}
