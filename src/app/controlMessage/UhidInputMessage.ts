// src/app/controlMessage/UhidInputMessage.ts
import { BinaryWriter } from '../BinaryWriter';
import { ControlMessage } from './ControlMessage';

export class UhidInputMessage extends ControlMessage {
    private constructor(
        private readonly id: number,
        private readonly data: Uint8Array,
    ) {
        super(ControlMessage.TYPE_UHID_INPUT);
    }

    static createKeyboardReport(id: number, modifier: number, keycodes: number[]): UhidInputMessage {
        // 8-byte keyboard report: modifier(1) + reserved(1) + key1-key6(6)
        const report = new Uint8Array(8);
        report[0] = modifier;
        report[1] = 0; // reserved
        for (let i = 0; i < Math.min(keycodes.length, 6); i++) {
            report[2 + i] = keycodes[i];
        }
        return new UhidInputMessage(id, report);
    }

    static createMouseReport(id: number, buttons: number, dx: number, dy: number, wheel: number): UhidInputMessage {
        // 4-byte mouse report: buttons(1) + dx(int8) + dy(int8) + wheel(int8)
        const report = new Uint8Array(4);
        report[0] = buttons;
        report[1] = Math.max(-127, Math.min(127, dx)) & 0xff;
        report[2] = Math.max(-127, Math.min(127, dy)) & 0xff;
        report[3] = Math.max(-127, Math.min(127, wheel)) & 0xff;
        return new UhidInputMessage(id, report);
    }

    public toUint8Array(): Uint8Array {
        // type(1) + id(2) + size(2) + data(N)
        return new BinaryWriter(1 + 2 + 2 + this.data.length)
            .writeUInt8(this.type)
            .writeUInt16BE(this.id)
            .writeUInt16BE(this.data.length)
            .writeBytes(this.data)
            .toUint8Array();
    }
}
