import type Position from '../Position';
import type { PositionInterface } from '../Position';
import { ControlMessage, type ControlMessageInterface } from './ControlMessage';
import { BinaryWriter } from '../BinaryWriter';

export interface ScrollControlMessageInterface extends ControlMessageInterface {
    position: PositionInterface;
    hScroll: number;
    vScroll: number;
    buttons: number;
}

export class ScrollControlMessage extends ControlMessage {
    public static PAYLOAD_LENGTH = 25;

    constructor(
        readonly position: Position,
        readonly hScroll: number,
        readonly vScroll: number,
        readonly buttons: number,
    ) {
        super(ControlMessage.TYPE_SCROLL);
    }

    /**
     * @override
     */
    public toUint8Array(): Uint8Array {
        return new BinaryWriter(ScrollControlMessage.PAYLOAD_LENGTH + 1)
            .writeUInt8(this.type)
            .writeUInt32BE(this.position.point.x)
            .writeUInt32BE(this.position.point.y)
            .writeUInt16BE(this.position.screenSize.width)
            .writeUInt16BE(this.position.screenSize.height)
            .writeInt32BE(Math.round(this.hScroll * 65535))
            .writeInt32BE(Math.round(this.vScroll * 65535))
            .writeUInt32BE(this.buttons)
            .toUint8Array();
    }

    public toString(): string {
        return `ScrollControlMessage{hScroll=${this.hScroll}, vScroll=${this.vScroll}, buttons=${this.buttons}, position=${this.position}}`;
    }

    public toJSON(): ScrollControlMessageInterface {
        return {
            type: this.type,
            position: this.position.toJSON(),
            hScroll: this.hScroll,
            vScroll: this.vScroll,
            buttons: this.buttons,
        };
    }
}
