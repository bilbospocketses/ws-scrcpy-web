// src/app/controlMessage/UhidCreateMessage.ts
import { BinaryWriter } from '../BinaryWriter';
import { ControlMessage } from './ControlMessage';

// Standard USB HID keyboard report descriptor (8-byte reports)
// Modifier byte, reserved byte, 6 key slots
const KEYBOARD_DESCRIPTOR = new Uint8Array([
    0x05,
    0x01, // Usage Page (Generic Desktop)
    0x09,
    0x06, // Usage (Keyboard)
    0xa1,
    0x01, // Collection (Application)
    0x05,
    0x07, //   Usage Page (Key Codes)
    0x19,
    0xe0, //   Usage Minimum (224 = Left Control)
    0x29,
    0xe7, //   Usage Maximum (231 = Right Meta)
    0x15,
    0x00, //   Logical Minimum (0)
    0x25,
    0x01, //   Logical Maximum (1)
    0x75,
    0x01, //   Report Size (1)
    0x95,
    0x08, //   Report Count (8)
    0x81,
    0x02, //   Input (Data, Variable, Absolute) — modifier byte
    0x95,
    0x01, //   Report Count (1)
    0x75,
    0x08, //   Report Size (8)
    0x81,
    0x01, //   Input (Constant) — reserved byte
    0x95,
    0x06, //   Report Count (6)
    0x75,
    0x08, //   Report Size (8)
    0x15,
    0x00, //   Logical Minimum (0)
    0x25,
    0x65, //   Logical Maximum (101)
    0x05,
    0x07, //   Usage Page (Key Codes)
    0x19,
    0x00, //   Usage Minimum (0)
    0x29,
    0x65, //   Usage Maximum (101)
    0x81,
    0x00, //   Input (Data, Array) — 6 key slots
    0xc0, // End Collection
]);

// Standard USB HID mouse report descriptor (4-byte reports)
// Buttons byte, dx int8, dy int8, wheel int8
const MOUSE_DESCRIPTOR = new Uint8Array([
    0x05,
    0x01, // Usage Page (Generic Desktop)
    0x09,
    0x02, // Usage (Mouse)
    0xa1,
    0x01, // Collection (Application)
    0x09,
    0x01, //   Usage (Pointer)
    0xa1,
    0x00, //   Collection (Physical)
    0x05,
    0x09, //     Usage Page (Buttons)
    0x19,
    0x01, //     Usage Minimum (Button 1)
    0x29,
    0x05, //     Usage Maximum (Button 5)
    0x15,
    0x00, //     Logical Minimum (0)
    0x25,
    0x01, //     Logical Maximum (1)
    0x95,
    0x05, //     Report Count (5)
    0x75,
    0x01, //     Report Size (1)
    0x81,
    0x02, //     Input (Data, Variable, Absolute) — buttons
    0x95,
    0x01, //     Report Count (1)
    0x75,
    0x03, //     Report Size (3)
    0x81,
    0x01, //     Input (Constant) — padding
    0x05,
    0x01, //     Usage Page (Generic Desktop)
    0x09,
    0x30, //     Usage (X)
    0x09,
    0x31, //     Usage (Y)
    0x09,
    0x38, //     Usage (Wheel)
    0x15,
    0x81, //     Logical Minimum (-127)
    0x25,
    0x7f, //     Logical Maximum (127)
    0x75,
    0x08, //     Report Size (8)
    0x95,
    0x03, //     Report Count (3)
    0x81,
    0x06, //     Input (Data, Variable, Relative) — dx, dy, wheel
    0xc0, //   End Collection
    0xc0, // End Collection
]);

export class UhidCreateMessage extends ControlMessage {
    private constructor(
        private readonly id: number,
        private readonly name: string,
        private readonly descriptor: Uint8Array,
    ) {
        super(ControlMessage.TYPE_UHID_CREATE);
    }

    static createKeyboard(id: number): UhidCreateMessage {
        return new UhidCreateMessage(id, 'ws-scrcpy keyboard', KEYBOARD_DESCRIPTOR);
    }

    static createMouse(id: number): UhidCreateMessage {
        return new UhidCreateMessage(id, 'ws-scrcpy mouse', MOUSE_DESCRIPTOR);
    }

    public toUint8Array(): Uint8Array {
        const nameBytes = new TextEncoder().encode(this.name);
        // type(1) + id(2) + nameLength(2) + name(N) + descriptorLength(2) + descriptor(M)
        const size = 1 + 2 + 2 + nameBytes.length + 2 + this.descriptor.length;
        return new BinaryWriter(size)
            .writeUInt8(this.type)
            .writeUInt16BE(this.id)
            .writeUInt16BE(nameBytes.length)
            .writeBytes(nameBytes)
            .writeUInt16BE(this.descriptor.length)
            .writeBytes(this.descriptor)
            .toUint8Array();
    }
}
