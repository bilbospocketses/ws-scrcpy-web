import { BinaryWriter } from '../BinaryWriter';
import type Position from '../Position';
import type { PositionInterface } from '../Position';
import { ControlMessage, type ControlMessageInterface } from './ControlMessage';

export interface TouchControlMessageInterface extends ControlMessageInterface {
    type: number;
    action: number;
    pointerId: number;
    position: PositionInterface;
    pressure: number;
    actionButton: number;
    buttons: number;
}

export class TouchControlMessage extends ControlMessage {
    public static PAYLOAD_LENGTH = 31;
    /**
     * - For a touch screen or touch pad, reports the approximate pressure
     * applied to the surface by a finger or other tool.  The value is
     * normalized to a range from 0 (no pressure at all) to 1 (normal pressure),
     * although values higher than 1 may be generated depending on the
     * calibration of the input device.
     * - For a trackball, the value is set to 1 if the trackball button is pressed
     * or 0 otherwise.
     * - For a mouse, the value is set to 1 if the primary mouse button is pressed
     * or 0 otherwise.
     *
     * - scrcpy server expects signed short (2 bytes) for a pressure value
     * - in browser TouchEvent has `force` property (values in 0..1 range), we
     * use it as "pressure" for scrcpy
     */
    public static readonly MAX_PRESSURE_VALUE = 0xffff;

    constructor(
        readonly action: number,
        readonly pointerId: number,
        readonly position: Position,
        readonly pressure: number,
        readonly actionButton: number,
        readonly buttons: number,
    ) {
        super(ControlMessage.TYPE_TOUCH);
    }

    /**
     * @override
     */
    public override toUint8Array(): Uint8Array {
        return new BinaryWriter(TouchControlMessage.PAYLOAD_LENGTH + 1)
            .writeUInt8(this.type)
            .writeUInt8(this.action)
            .writeUInt32BE(0) // pointerId high 32 bits
            .writeUInt32BE(this.pointerId)
            .writeUInt32BE(this.position.point.x)
            .writeUInt32BE(this.position.point.y)
            .writeUInt16BE(this.position.screenSize.width)
            .writeUInt16BE(this.position.screenSize.height)
            .writeUInt16BE(this.pressure * TouchControlMessage.MAX_PRESSURE_VALUE)
            .writeUInt32BE(this.actionButton)
            .writeUInt32BE(this.buttons)
            .toUint8Array();
    }

    public override toString(): string {
        return `TouchControlMessage{action=${this.action}, pointerId=${this.pointerId}, position=${this.position}, pressure=${this.pressure}, actionButton=${this.actionButton}, buttons=${this.buttons}}`;
    }

    public override toJSON(): TouchControlMessageInterface {
        return {
            type: this.type,
            action: this.action,
            pointerId: this.pointerId,
            position: this.position.toJSON(),
            pressure: this.pressure,
            actionButton: this.actionButton,
            buttons: this.buttons,
        };
    }
}
