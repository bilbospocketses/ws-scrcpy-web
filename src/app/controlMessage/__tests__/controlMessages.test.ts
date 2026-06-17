// Tests verifying control message binary formats match scrcpy v3.x protocol
// Reference: https://github.com/Genymobile/scrcpy/blob/master/app/src/control_msg.c

import { describe, expect, it } from 'vitest';
import { BinaryWriter } from '../../BinaryWriter';
import Point from '../../Point';
import Position from '../../Position';
import Size from '../../Size';
import { ControlMessage } from '../ControlMessage';
import { KeyCodeControlMessage } from '../KeyCodeControlMessage';
import { ScrollControlMessage } from '../ScrollControlMessage';
import { TouchControlMessage } from '../TouchControlMessage';
import { UhidCreateMessage } from '../UhidCreateMessage';

// Helper to build a Position for tests
function pos(x: number, y: number, w: number, h: number): Position {
    return new Position(new Point(x, y), new Size(w, h));
}

describe('BinaryWriter', () => {
    it('toUint8Array returns only written bytes, not the full buffer', () => {
        const writer = new BinaryWriter(16);
        writer.writeUInt8(0x02);
        writer.writeUInt8(0x01);
        // Wrote 2 bytes into a 16-byte buffer
        const result = writer.toUint8Array();
        expect(result.length).toBe(2);
    });
});

describe('TouchControlMessage pressure clamping (#93)', () => {
    // pressure is the UInt16BE at byte offset 22:
    // type(1)+action(1)+ptrIdHi(4)+ptrIdLo(4)+x(4)+y(4)+w(2)+h(2) = 22
    function pressureField(pressure: number): number {
        const bytes = new TouchControlMessage(0, 0, pos(0, 0, 100, 100), pressure, 0, 0).toUint8Array();
        return (bytes[22]! << 8) | bytes[23]!;
    }

    it('clamps pressure > 1 to the 16-bit max (0xffff), not a truncated wrap', () => {
        expect(pressureField(2.0)).toBe(0xffff);
    });

    it('clamps negative pressure to 0', () => {
        expect(pressureField(-1)).toBe(0x0000);
    });

    it('maps full pressure 1.0 to 0xffff', () => {
        expect(pressureField(1.0)).toBe(0xffff);
    });
});

describe('TouchControlMessage — scrcpy protocol match', () => {
    // scrcpy control_msg.c: sc_control_msg_serialize_inject_touch_event returns 32
    const SCRCPY_TOUCH_MSG_SIZE = 32;

    it('serializes to exactly 32 bytes (matching scrcpy protocol)', () => {
        const msg = new TouchControlMessage(
            0, // ACTION_DOWN
            0, // pointerId
            pos(100, 200, 1920, 1080),
            1.0, // pressure
            0, // actionButton
            1, // buttons (PRIMARY)
        );
        const bytes = msg.toUint8Array();
        expect(bytes.length).toBe(SCRCPY_TOUCH_MSG_SIZE);
    });

    it('has correct byte layout per scrcpy protocol', () => {
        const msg = new TouchControlMessage(
            0, // ACTION_DOWN
            7, // pointerId
            pos(100, 200, 1920, 1080),
            1.0, // pressure (max)
            0, // actionButton
            1, // buttons (PRIMARY)
        );
        const bytes = msg.toUint8Array();
        const view = new DataView(bytes.buffer, bytes.byteOffset);

        // byte 0: type
        expect(bytes[0]).toBe(ControlMessage.TYPE_TOUCH); // 2
        // byte 1: action
        expect(bytes[1]).toBe(0); // ACTION_DOWN
        // bytes 2-9: pointerId (int64 BE)
        expect(view.getBigInt64(2)).toBe(7n);
        // bytes 10-13: x
        expect(view.getUint32(10)).toBe(100);
        // bytes 14-17: y
        expect(view.getUint32(14)).toBe(200);
        // bytes 18-19: screen width
        expect(view.getUint16(18)).toBe(1920);
        // bytes 20-21: screen height
        expect(view.getUint16(20)).toBe(1080);
        // bytes 22-23: pressure (0xFFFF for 1.0)
        expect(view.getUint16(22)).toBe(0xffff);
        // bytes 24-27: actionButton
        expect(view.getUint32(24)).toBe(0);
        // bytes 28-31: buttons
        expect(view.getUint32(28)).toBe(1);
    });

    it('no trailing bytes that would desync the protocol stream', () => {
        const msg = new TouchControlMessage(0, 0, pos(0, 0, 1920, 1080), 0, 0, 0);
        const bytes = msg.toUint8Array();
        // Every byte in the output must be accounted for by the protocol.
        // A trailing zero would cause the scrcpy-server to interpret it as
        // TYPE_INJECT_KEYCODE (0), desyncing the entire control stream.
        expect(bytes.length).toBe(SCRCPY_TOUCH_MSG_SIZE);
        // Also verify PAYLOAD_LENGTH + 1 == total size
        expect(TouchControlMessage.PAYLOAD_LENGTH + 1).toBe(SCRCPY_TOUCH_MSG_SIZE);
    });
});

describe('ScrollControlMessage — scrcpy protocol match', () => {
    // scrcpy control_msg.c: sc_control_msg_serialize_inject_scroll_event returns 21
    const SCRCPY_SCROLL_MSG_SIZE = 21;

    it('serializes to exactly 21 bytes (matching scrcpy protocol)', () => {
        const msg = new ScrollControlMessage(pos(500, 300, 1920, 1080), -1, 1, 0);
        const bytes = msg.toUint8Array();
        expect(bytes.length).toBe(SCRCPY_SCROLL_MSG_SIZE);
    });

    it('has correct byte layout per scrcpy protocol', () => {
        const msg = new ScrollControlMessage(pos(500, 300, 1920, 1080), -1, 1, 0);
        const bytes = msg.toUint8Array();
        const view = new DataView(bytes.buffer, bytes.byteOffset);

        // byte 0: type
        expect(bytes[0]).toBe(ControlMessage.TYPE_SCROLL); // 3
        // bytes 1-4: x
        expect(view.getUint32(1)).toBe(500);
        // bytes 5-8: y
        expect(view.getUint32(5)).toBe(300);
        // bytes 9-10: screen width
        expect(view.getUint16(9)).toBe(1920);
        // bytes 11-12: screen height
        expect(view.getUint16(11)).toBe(1080);
        // bytes 13-14: hScroll (i16 fixed-point, -1 tick → -1/128 → -256)
        expect(view.getInt16(13)).toBe(-256);
        // bytes 15-16: vScroll (i16 fixed-point, 1 tick → 1/128 → 256)
        expect(view.getInt16(15)).toBe(256);
        // bytes 17-20: buttons
        expect(view.getUint32(17)).toBe(0);
    });

    it('encodes zero scroll as zero', () => {
        const msg = new ScrollControlMessage(pos(0, 0, 1920, 1080), 0, 0, 0);
        const bytes = msg.toUint8Array();
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        expect(view.getInt16(13)).toBe(0);
        expect(view.getInt16(15)).toBe(0);
    });

    it('clamps large scroll values to [-1, 1] range after normalization', () => {
        // 256 ticks would be 256/128 = 2.0, clamped to 1.0 → 0x7FFF
        const msg = new ScrollControlMessage(pos(0, 0, 1920, 1080), 256, -256, 0);
        const bytes = msg.toUint8Array();
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        expect(view.getInt16(13)).toBe(0x7fff);
        expect(view.getInt16(15)).toBe(-0x8000);
    });

    it('PAYLOAD_LENGTH + 1 equals protocol size', () => {
        expect(ScrollControlMessage.PAYLOAD_LENGTH + 1).toBe(SCRCPY_SCROLL_MSG_SIZE);
    });
});

describe('KeyCodeControlMessage — scrcpy protocol match (baseline)', () => {
    // This should already pass — serves as a control to verify the test approach
    const SCRCPY_KEYCODE_MSG_SIZE = 14;

    it('serializes to exactly 14 bytes (matching scrcpy protocol)', () => {
        const msg = new KeyCodeControlMessage(0, 66, 0, 0); // ACTION_DOWN, KEYCODE_ENTER
        const bytes = msg.toUint8Array();
        expect(bytes.length).toBe(SCRCPY_KEYCODE_MSG_SIZE);
    });

    it('PAYLOAD_LENGTH + 1 equals protocol size', () => {
        expect(KeyCodeControlMessage.PAYLOAD_LENGTH + 1).toBe(SCRCPY_KEYCODE_MSG_SIZE);
    });
});

describe('UhidCreateMessage — scrcpy v3.3.4 protocol match', () => {
    // scrcpy v3.3.4 ControlMessageReader.parseUhidCreate wire format:
    // type(1) + id(2) + vendorId(2) + productId(2) + nameLen(1) + name + dataLen(2) + data
    // Added in commit 27a5934a (2024-12-07, "Define UHID vendorId and productId from the client")
    const FIXED_HEADER_SIZE = 1 + 2 + 2 + 2 + 1 + 2; // everything except name + descriptor

    it('keyboard message has correct byte layout per scrcpy v3.3.4', () => {
        const msg = UhidCreateMessage.createKeyboard(1);
        const bytes = msg.toUint8Array();
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        const name = 'ws-scrcpy keyboard';
        const nameBytes = new TextEncoder().encode(name);

        // byte 0: type
        expect(bytes[0]).toBe(ControlMessage.TYPE_UHID_CREATE); // 12
        // bytes 1-2: id
        expect(view.getUint16(1)).toBe(1);
        // bytes 3-4: vendorId (0 = unspecified, matches scrcpy's own client)
        expect(view.getUint16(3)).toBe(0);
        // bytes 5-6: productId
        expect(view.getUint16(5)).toBe(0);
        // byte 7: nameLen (1 byte, not 2 — see parseString(1) in ControlMessageReader)
        expect(bytes[7]).toBe(nameBytes.length);
        // bytes 8..8+nameLen: name UTF-8 bytes
        const nameStart = 8;
        for (let i = 0; i < nameBytes.length; i++) {
            expect(bytes[nameStart + i]).toBe(nameBytes[i]);
        }
        // after name: 2-byte descriptor length
        const descLenOffset = nameStart + nameBytes.length;
        const descLen = view.getUint16(descLenOffset);
        expect(descLen).toBeGreaterThan(0);
        // total size = fixed header + name + descriptor
        expect(bytes.length).toBe(FIXED_HEADER_SIZE + nameBytes.length + descLen);
    });

    it('mouse message has correct byte layout per scrcpy v3.3.4', () => {
        const msg = UhidCreateMessage.createMouse(2);
        const bytes = msg.toUint8Array();
        const view = new DataView(bytes.buffer, bytes.byteOffset);

        expect(bytes[0]).toBe(ControlMessage.TYPE_UHID_CREATE);
        expect(view.getUint16(1)).toBe(2);
        expect(view.getUint16(3)).toBe(0); // vendorId
        expect(view.getUint16(5)).toBe(0); // productId
        const nameLen = bytes[7];
        expect(nameLen).toBe('ws-scrcpy mouse'.length);
    });
});
