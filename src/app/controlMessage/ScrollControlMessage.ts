import { BinaryWriter } from '../BinaryWriter';
import type Position from '../Position';
import type { PositionInterface } from '../Position';
import { ControlMessage, type ControlMessageInterface } from './ControlMessage';

export interface ScrollControlMessageInterface extends ControlMessageInterface {
    position: PositionInterface;
    hScroll: number;
    vScroll: number;
    buttons: number;
}

export class ScrollControlMessage extends ControlMessage {
    public static PAYLOAD_LENGTH = 20;

    constructor(
        readonly position: Position,
        readonly hScroll: number,
        readonly vScroll: number,
        readonly buttons: number,
    ) {
        super(ControlMessage.TYPE_SCROLL);
    }

    // Matches scrcpy's sc_float_to_i16fp: maps [-1.0, 1.0] → [-32768, 32767]
    private static floatToI16FP(f: number): number {
        if (f < 0) {
            return -Math.round(-f * 0x8000);
        }
        return Math.round(f * 0x7fff);
    }

    /**
     * @override
     */
    public override toUint8Array(): Uint8Array {
        // Normalize scroll ticks to [-1, 1] then encode as i16 fixed-point
        // scrcpy desktop uses /16; we use /128 for slower scrolling over latent streams
        const hScrollNorm = Math.max(-1, Math.min(1, this.hScroll / 128));
        const vScrollNorm = Math.max(-1, Math.min(1, this.vScroll / 128));
        return new BinaryWriter(ScrollControlMessage.PAYLOAD_LENGTH + 1)
            .writeUInt8(this.type)
            .writeUInt32BE(this.position.point.x)
            .writeUInt32BE(this.position.point.y)
            .writeUInt16BE(this.position.screenSize.width)
            .writeUInt16BE(this.position.screenSize.height)
            .writeInt16BE(ScrollControlMessage.floatToI16FP(hScrollNorm))
            .writeInt16BE(ScrollControlMessage.floatToI16FP(vScrollNorm))
            .writeUInt32BE(this.buttons)
            .toUint8Array();
    }

    public override toString(): string {
        return `ScrollControlMessage{hScroll=${this.hScroll}, vScroll=${this.vScroll}, buttons=${this.buttons}, position=${this.position}}`;
    }

    public override toJSON(): ScrollControlMessageInterface {
        return {
            type: this.type,
            position: this.position.toJSON(),
            hScroll: this.hScroll,
            vScroll: this.vScroll,
            buttons: this.buttons,
        };
    }
}
