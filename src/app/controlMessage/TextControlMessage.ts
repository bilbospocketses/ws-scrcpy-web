import { BinaryWriter } from '../BinaryWriter';
import { ControlMessage, type ControlMessageInterface } from './ControlMessage';

export interface TextControlMessageInterface extends ControlMessageInterface {
    text: string;
}

export class TextControlMessage extends ControlMessage {
    private static TEXT_SIZE_FIELD_LENGTH = 4;
    constructor(readonly text: string) {
        super(ControlMessage.TYPE_TEXT);
    }

    public getText(): string {
        return this.text;
    }

    /**
     * @override
     */
    public override toUint8Array(): Uint8Array {
        const textBytes = new TextEncoder().encode(this.text);
        return new BinaryWriter(1 + TextControlMessage.TEXT_SIZE_FIELD_LENGTH + textBytes.length)
            .writeUInt8(this.type)
            .writeUInt32BE(textBytes.length)
            .writeBytes(textBytes)
            .toUint8Array();
    }

    public override toString(): string {
        return `TextControlMessage{text=${this.text}}`;
    }

    public override toJSON(): TextControlMessageInterface {
        return {
            type: this.type,
            text: this.text,
        };
    }
}
