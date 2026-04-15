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
        // bytes 13-14: hScroll (int16 BE, raw value, no scaling)
        expect(view.getInt16(13)).toBe(-1);
        // bytes 15-16: vScroll (int16 BE, raw value, no scaling)
        expect(view.getInt16(15)).toBe(1);
        // bytes 17-20: buttons
        expect(view.getUint32(17)).toBe(0);
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
