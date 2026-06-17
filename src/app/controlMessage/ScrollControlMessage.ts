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
    // scrcpy desktop normalizes scroll ticks with /16; we use a larger divisor for
    // slower, smoother scrolling over latent streams. Named so the two axes can't
    // drift apart. (#94)
    private static readonly SCROLL_DIVISOR = 128;

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
        // Normalize scroll ticks to [-1, 1] then encode as i16 fixed-point.
        const hScrollNorm = Math.max(-1, Math.min(1, this.hScroll / ScrollControlMessage.SCROLL_DIVISOR));
        const vScrollNorm = Math.max(-1, Math.min(1, this.vScroll / ScrollControlMessage.SCROLL_DIVISOR));
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
