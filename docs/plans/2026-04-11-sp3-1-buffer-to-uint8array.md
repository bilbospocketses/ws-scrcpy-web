# SP3-1: Buffer → Uint8Array + path-browserify Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Node.js `Buffer` polyfill and `path-browserify` from the browser bundle so all browser-side binary code uses native `Uint8Array` + `DataView`.

**Architecture:** Two small utility classes (BinaryWriter for serialization, BinaryReader for deserialization) replace all Buffer usage in browser code. A tiny pathUtils module replaces `path-browserify`. Then we convert ~13 files one by one, update the webpack config, and verify the build.

**Tech Stack:** TypeScript, DataView, Uint8Array, TextEncoder, webpack 5

**Spec:** `docs/specs/2026-04-11-sp3-feature-additions.md` (SP3-1 section)

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `src/app/BinaryWriter.ts` | Sequential big-endian binary serialization (replaces `Buffer.alloc` + `writeXxxBE`) |
| `src/app/BinaryReader.ts` | Sequential big-endian binary deserialization (replaces `Buffer.readXxxBE`) |
| `src/app/pathUtils.ts` | Unix-style path operations for ADB paths (replaces `path-browserify`) |

### Modified Files
| File | Change |
|------|--------|
| `src/app/controlMessage/ControlMessage.ts` | `toBuffer(): Buffer` → `toUint8Array(): Uint8Array` |
| `src/app/controlMessage/KeyCodeControlMessage.ts` | Buffer → BinaryWriter |
| `src/app/controlMessage/TextControlMessage.ts` | Buffer → BinaryWriter + TextEncoder |
| `src/app/controlMessage/TouchControlMessage.ts` | Buffer → BinaryWriter |
| `src/app/controlMessage/ScrollControlMessage.ts` | Buffer → BinaryWriter |
| `src/app/controlMessage/CommandControlMessage.ts` | Buffer → BinaryWriter/BinaryReader |
| `src/app/VideoSettings.ts` | `toBuffer()`/`fromBuffer()` → BinaryWriter/BinaryReader |
| `src/app/googDevice/DeviceMessage.ts` | Buffer → BinaryReader |
| `src/app/ScrcpyDemuxer.ts` | `sendControl()` uses `toUint8Array()` instead of `toBuffer()` |
| `src/app/client/BaseDeviceTracker.ts` | `getChannelInitData()` returns `Uint8Array` |
| `src/app/client/HostTracker.ts` | `getChannelInitData()` returns `Uint8Array` |
| `src/app/client/ManagerClient.ts` | `getChannelInitData()` returns `Uint8Array` |
| `src/app/googDevice/client/ShellClient.ts` | `getChannelInitData()` returns `Uint8Array` |
| `src/app/googDevice/client/FileListingClient.ts` | Buffer → BinaryWriter + pathUtils |
| `src/packages/multiplexer/Multiplexer.ts` | `createChannel(data: Buffer)` → `createChannel(data: Uint8Array)` |
| `webpack/ws-scrcpy-web.common.ts` | Remove ProvidePlugin Buffer + resolve.fallback.path |

---

## Task 1: Create BinaryWriter

**Files:**
- Create: `src/app/BinaryWriter.ts`

- [ ] **Step 1: Create BinaryWriter**

```typescript
// src/app/BinaryWriter.ts

export class BinaryWriter {
    private view: DataView;
    private buf: Uint8Array;
    private pos = 0;

    constructor(size: number) {
        this.buf = new Uint8Array(size);
        this.view = new DataView(this.buf.buffer);
    }

    writeUInt8(value: number): this {
        this.view.setUint8(this.pos, value);
        this.pos += 1;
        return this;
    }

    writeInt8(value: number): this {
        this.view.setInt8(this.pos, value);
        this.pos += 1;
        return this;
    }

    writeUInt16BE(value: number): this {
        this.view.setUint16(this.pos, value);
        this.pos += 2;
        return this;
    }

    writeInt16BE(value: number): this {
        this.view.setInt16(this.pos, value);
        this.pos += 2;
        return this;
    }

    writeUInt32BE(value: number): this {
        this.view.setUint32(this.pos, value);
        this.pos += 4;
        return this;
    }

    writeInt32BE(value: number): this {
        this.view.setInt32(this.pos, value);
        this.pos += 4;
        return this;
    }

    writeUInt32LE(value: number): this {
        this.view.setUint32(this.pos, value, true);
        this.pos += 4;
        return this;
    }

    writeBigUInt64BE(value: bigint): this {
        this.view.setBigUint64(this.pos, value);
        this.pos += 8;
        return this;
    }

    writeBytes(data: Uint8Array): this {
        this.buf.set(data, this.pos);
        this.pos += data.length;
        return this;
    }

    writeString(text: string): this {
        const encoded = new TextEncoder().encode(text);
        this.buf.set(encoded, this.pos);
        this.pos += encoded.length;
        return this;
    }

    /** Fill from a specific offset (for writing at non-sequential positions). */
    writeBytesAt(offset: number, data: Uint8Array): this {
        this.buf.set(data, offset);
        return this;
    }

    get offset(): number {
        return this.pos;
    }

    toUint8Array(): Uint8Array {
        return this.buf;
    }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`
Expected: `compiled successfully`

- [ ] **Step 3: Commit**

```bash
git add src/app/BinaryWriter.ts
git commit -m "feat(sp3-1): add BinaryWriter utility for Uint8Array serialization"
```

---

## Task 2: Create BinaryReader

**Files:**
- Create: `src/app/BinaryReader.ts`

- [ ] **Step 1: Create BinaryReader**

```typescript
// src/app/BinaryReader.ts

export class BinaryReader {
    private view: DataView;
    private pos: number;

    constructor(data: Uint8Array, offset = 0) {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        this.pos = offset;
    }

    readUInt8(): number {
        const v = this.view.getUint8(this.pos);
        this.pos += 1;
        return v;
    }

    readInt8(): number {
        const v = this.view.getInt8(this.pos);
        this.pos += 1;
        return v;
    }

    readUInt16BE(): number {
        const v = this.view.getUint16(this.pos);
        this.pos += 2;
        return v;
    }

    readInt16BE(): number {
        const v = this.view.getInt16(this.pos);
        this.pos += 2;
        return v;
    }

    readUInt32BE(): number {
        const v = this.view.getUint32(this.pos);
        this.pos += 4;
        return v;
    }

    readInt32BE(): number {
        const v = this.view.getInt32(this.pos);
        this.pos += 4;
        return v;
    }

    readUInt32LE(): number {
        const v = this.view.getUint32(this.pos, true);
        this.pos += 4;
        return v;
    }

    readBigUInt64BE(): bigint {
        const v = this.view.getBigUint64(this.pos);
        this.pos += 8;
        return v;
    }

    readBytes(length: number): Uint8Array {
        const data = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, length);
        this.pos += length;
        return data;
    }

    readString(length: number): string {
        const bytes = this.readBytes(length);
        return new TextDecoder().decode(bytes);
    }

    get offset(): number {
        return this.pos;
    }

    get remaining(): number {
        return this.view.byteLength - this.pos;
    }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`
Expected: `compiled successfully`

- [ ] **Step 3: Commit**

```bash
git add src/app/BinaryReader.ts
git commit -m "feat(sp3-1): add BinaryReader utility for Uint8Array deserialization"
```

---

## Task 3: Create pathUtils

**Files:**
- Create: `src/app/pathUtils.ts`

- [ ] **Step 1: Create pathUtils**

ADB paths are always Unix-style `/`-separated. These are simple string operations.

```typescript
// src/app/pathUtils.ts

export function basename(p: string): string {
    const i = p.lastIndexOf('/');
    return i === -1 ? p : p.substring(i + 1);
}

export function dirname(p: string): string {
    const i = p.lastIndexOf('/');
    if (i <= 0) return '/';
    return p.substring(0, i);
}

export function join(...parts: string[]): string {
    return parts
        .join('/')
        .replace(/\/+/g, '/')
        .replace(/\/$/, '') || '/';
}

export function resolve(base: string, name: string): string {
    if (name.startsWith('/')) return name;
    if (name === '.') return base;
    if (name === '..') return dirname(base);
    return join(base, name);
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`
Expected: `compiled successfully`

- [ ] **Step 3: Commit**

```bash
git add src/app/pathUtils.ts
git commit -m "feat(sp3-1): add pathUtils for ADB path operations"
```

---

## Task 4: Update ControlMessage base class + ScrcpyDemuxer consumer

**Files:**
- Modify: `src/app/controlMessage/ControlMessage.ts:29-31`
- Modify: `src/app/ScrcpyDemuxer.ts:64-68`

The base class signature change and the primary consumer update must happen together.

- [ ] **Step 1: Update ControlMessage.toBuffer → toUint8Array**

In `src/app/controlMessage/ControlMessage.ts`, change line 29-31:

```typescript
// Before:
    public toBuffer(): Buffer {
        throw Error('Not implemented');
    }

// After:
    public toUint8Array(): Uint8Array {
        throw Error('Not implemented');
    }
```

- [ ] **Step 2: Update ScrcpyDemuxer.sendControl**

In `src/app/ScrcpyDemuxer.ts`, change lines 64-68:

```typescript
// Before:
    sendControl(message: ControlMessage): void {
        const payload = message.toBuffer();
        const msg = new Uint8Array(1 + payload.length);
        msg[0] = ChannelId.CONTROL;
        msg.set(new Uint8Array(payload.buffer, payload.byteOffset, payload.length), 1);

// After:
    sendControl(message: ControlMessage): void {
        const payload = message.toUint8Array();
        const msg = new Uint8Array(1 + payload.length);
        msg[0] = ChannelId.CONTROL;
        msg.set(payload, 1);
```

Note: `payload` is now a plain `Uint8Array`, so `msg.set(payload, 1)` works directly — no need for the `new Uint8Array(payload.buffer, payload.byteOffset, payload.length)` dance.

- [ ] **Step 3: Verify build**

Build will have errors because subclasses still override `toBuffer()`. That's expected — we'll fix them in Tasks 5-7.

Run: `npm run build:dev 2>&1 | grep -c "error"` to confirm the errors are only in the expected control message files.

- [ ] **Step 4: Commit**

```bash
git add src/app/controlMessage/ControlMessage.ts src/app/ScrcpyDemuxer.ts
git commit -m "refactor(sp3-1): rename ControlMessage.toBuffer to toUint8Array"
```

---

## Task 5: Convert KeyCodeControlMessage + TextControlMessage

**Files:**
- Modify: `src/app/controlMessage/KeyCodeControlMessage.ts`
- Modify: `src/app/controlMessage/TextControlMessage.ts`

- [ ] **Step 1: Convert KeyCodeControlMessage**

Replace the entire `toBuffer()` method and remove the Buffer import:

```typescript
// Before (line 1):
import { Buffer } from 'buffer';

// After (line 1):
import { BinaryWriter } from '../BinaryWriter';
```

```typescript
// Before (lines 26-34):
    public toBuffer(): Buffer {
        const buffer = Buffer.alloc(KeyCodeControlMessage.PAYLOAD_LENGTH + 1);
        let offset = 0;
        offset = buffer.writeInt8(this.type, offset);
        offset = buffer.writeInt8(this.action, offset);
        offset = buffer.writeInt32BE(this.keycode, offset);
        offset = buffer.writeInt32BE(this.repeat, offset);
        buffer.writeInt32BE(this.metaState, offset);
        return buffer;
    }

// After:
    public toUint8Array(): Uint8Array {
        return new BinaryWriter(KeyCodeControlMessage.PAYLOAD_LENGTH + 1)
            .writeInt8(this.type)
            .writeInt8(this.action)
            .writeInt32BE(this.keycode)
            .writeInt32BE(this.repeat)
            .writeInt32BE(this.metaState)
            .toUint8Array();
    }
```

- [ ] **Step 2: Convert TextControlMessage**

Replace the Buffer import and `toBuffer()` method:

```typescript
// Before (line 1):
import { Buffer } from 'buffer';

// After (line 1):
import { BinaryWriter } from '../BinaryWriter';
```

```typescript
// Before (lines 20-27):
    public toBuffer(): Buffer {
        const length = this.text.length;
        const buffer = Buffer.alloc(length + 1 + TextControlMessage.TEXT_SIZE_FIELD_LENGTH);
        let offset = 0;
        offset = buffer.writeUInt8(this.type, offset);
        offset = buffer.writeUInt32BE(length, offset);
        buffer.write(this.text, offset);
        return buffer;
    }

// After:
    public toUint8Array(): Uint8Array {
        const textBytes = new TextEncoder().encode(this.text);
        return new BinaryWriter(1 + TextControlMessage.TEXT_SIZE_FIELD_LENGTH + textBytes.length)
            .writeUInt8(this.type)
            .writeUInt32BE(textBytes.length)
            .writeBytes(textBytes)
            .toUint8Array();
    }
```

Note: Use `TextEncoder` for proper UTF-8 byte length. The old code used `this.text.length` which is wrong for multi-byte chars — this is a bugfix.

- [ ] **Step 3: Verify build**

Run: `npm run build:dev 2>&1 | tail -10`
Expect: errors only from remaining unconverted files (Touch, Scroll, Command).

- [ ] **Step 4: Commit**

```bash
git add src/app/controlMessage/KeyCodeControlMessage.ts src/app/controlMessage/TextControlMessage.ts
git commit -m "refactor(sp3-1): convert KeyCode + Text control messages to Uint8Array"
```

---

## Task 6: Convert TouchControlMessage + ScrollControlMessage

**Files:**
- Modify: `src/app/controlMessage/TouchControlMessage.ts`
- Modify: `src/app/controlMessage/ScrollControlMessage.ts`

- [ ] **Step 1: Convert TouchControlMessage**

Add BinaryWriter import (no Buffer import to remove — was implicit):

```typescript
// Add after line 3:
import { BinaryWriter } from '../BinaryWriter';
```

Replace `toBuffer()` (lines 32-46):

```typescript
// Before:
    public toBuffer(): Buffer {
        const buffer: Buffer = Buffer.alloc(TouchControlMessage.PAYLOAD_LENGTH + 1);
        let offset = 0;
        offset = buffer.writeUInt8(this.type, offset);
        offset = buffer.writeUInt8(this.action, offset);
        offset = buffer.writeUInt32BE(0, offset); // pointerId high 32 bits
        offset = buffer.writeUInt32BE(this.pointerId, offset);
        offset = buffer.writeUInt32BE(this.position.point.x, offset);
        offset = buffer.writeUInt32BE(this.position.point.y, offset);
        offset = buffer.writeUInt16BE(this.position.screenSize.width, offset);
        offset = buffer.writeUInt16BE(this.position.screenSize.height, offset);
        offset = buffer.writeUInt16BE(this.pressure * TouchControlMessage.MAX_PRESSURE_VALUE, offset);
        offset = buffer.writeUInt32BE(this.actionButton, offset);
        buffer.writeUInt32BE(this.buttons, offset);
        return buffer;
    }

// After:
    public toUint8Array(): Uint8Array {
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
```

- [ ] **Step 2: Convert ScrollControlMessage**

Add BinaryWriter import:

```typescript
// Add after line 3:
import { BinaryWriter } from '../BinaryWriter';
```

Replace `toBuffer()` (lines 27-37):

```typescript
// Before:
    public toBuffer(): Buffer {
        const buffer = Buffer.alloc(ScrollControlMessage.PAYLOAD_LENGTH + 1);
        let offset = 0;
        offset = buffer.writeUInt8(this.type, offset);
        offset = buffer.writeUInt32BE(this.position.point.x, offset);
        offset = buffer.writeUInt32BE(this.position.point.y, offset);
        offset = buffer.writeUInt16BE(this.position.screenSize.width, offset);
        offset = buffer.writeUInt16BE(this.position.screenSize.height, offset);
        offset = buffer.writeInt32BE(Math.round(this.hScroll * 65535), offset);
        offset = buffer.writeInt32BE(Math.round(this.vScroll * 65535), offset);
        buffer.writeUInt32BE(this.buttons, offset);
        return buffer;
    }

// After:
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
```

- [ ] **Step 3: Verify build**

Run: `npm run build:dev 2>&1 | tail -10`
Expect: errors only from CommandControlMessage.

- [ ] **Step 4: Commit**

```bash
git add src/app/controlMessage/TouchControlMessage.ts src/app/controlMessage/ScrollControlMessage.ts
git commit -m "refactor(sp3-1): convert Touch + Scroll control messages to Uint8Array"
```

---

## Task 7: Convert CommandControlMessage + VideoSettings

**Files:**
- Modify: `src/app/controlMessage/CommandControlMessage.ts`
- Modify: `src/app/VideoSettings.ts`

This is the most complex conversion. CommandControlMessage has multiple static factory methods that create buffers, plus `pushFileCommandFromBuffer` which reads buffers. VideoSettings has `toBuffer()` and `fromBuffer()`.

- [ ] **Step 1: Convert VideoSettings**

VideoSettings.toBuffer() is called by CommandControlMessage.createSetVideoSettingsCommand(). Convert both together.

In `src/app/VideoSettings.ts`:
- Add import: `import { BinaryWriter } from './BinaryWriter';` and `import { BinaryReader } from './BinaryReader';`
- Rename `toBuffer(): Buffer` → `toUint8Array(): Uint8Array`
- Replace all `Buffer.alloc` + `buffer.writeXxx` calls with BinaryWriter
- Rename `fromBuffer(buffer: Buffer)` → `fromUint8Array(data: Uint8Array)`
- Replace all `buffer.readXxx` calls with BinaryReader
- Search codebase for all callers of `VideoSettings.fromBuffer` and update them

The implementation should follow the same mechanical pattern as the control messages: `new BinaryWriter(size).writeXxx(...).toUint8Array()` for serialization, `new BinaryReader(data)` for deserialization.

- [ ] **Step 2: Convert CommandControlMessage**

In `src/app/controlMessage/CommandControlMessage.ts`:
- Add imports: `import { BinaryWriter } from '../BinaryWriter';` and `import { BinaryReader } from '../BinaryReader';`
- Convert every static factory method: replace `Buffer.alloc` + `buffer.writeXxx` with `BinaryWriter`
- Change the `buffer` field type from `Buffer` to `Uint8Array`
- Rename `toBuffer()` → `toUint8Array()`: returns `this.buffer` (now Uint8Array)
- Convert `pushFileCommandFromBuffer(buffer: Buffer)` → `pushFileCommandFromData(data: Uint8Array)`: use BinaryReader
- Update `createSetVideoSettingsCommand`: call `videoSettings.toUint8Array()` instead of `toBuffer()`
- Replace `textBytes.forEach((byte, index) => buffer.writeUInt8(byte, index + offset))` patterns with `writer.writeBytes(textBytes)`
- Update all callers of `pushFileCommandFromBuffer` (search codebase)

- [ ] **Step 3: Verify build**

Run: `npm run build:dev 2>&1 | tail -10`
Expected: `compiled successfully` for both frontend and backend. All control messages now use `toUint8Array()`.

- [ ] **Step 4: Commit**

```bash
git add src/app/controlMessage/CommandControlMessage.ts src/app/VideoSettings.ts
git commit -m "refactor(sp3-1): convert CommandControlMessage + VideoSettings to Uint8Array"
```

---

## Task 8: Convert DeviceMessage

**Files:**
- Modify: `src/app/googDevice/DeviceMessage.ts`

- [ ] **Step 1: Convert DeviceMessage**

Replace the Buffer-based `buffer` field and all read operations with BinaryReader.

Key changes:
- Change constructor: `protected readonly buffer: Buffer` → `protected readonly data: Uint8Array`
- `fromBuffer(data: ArrayBuffer)`: use `new Uint8Array(data, magicSize)` + BinaryReader
- `fromRaw(data: Uint8Array)`: already receives Uint8Array — just wrap in BinaryReader
- `getText()`: use BinaryReader for `.readInt32BE()`, `.readBytes()` (replaces `.slice()`)
- `getAckSequence()`: use BinaryReader for `.readBigUInt64BE()`
- `getPushStats()`: use BinaryReader for `.readInt16BE()`, `.readInt8()`
- `toString()`: replace `buffer.join(',')` with `Array.from(data).join(',')`

Add import: `import { BinaryReader } from '../BinaryReader';`

- [ ] **Step 2: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`
Expected: `compiled successfully`

- [ ] **Step 3: Commit**

```bash
git add src/app/googDevice/DeviceMessage.ts
git commit -m "refactor(sp3-1): convert DeviceMessage to Uint8Array + BinaryReader"
```

---

## Task 9: Convert channel init methods + Multiplexer signature

**Files:**
- Modify: `src/app/client/BaseDeviceTracker.ts:275-280`
- Modify: `src/app/client/HostTracker.ts:114-118`
- Modify: `src/app/client/ManagerClient.ts:124-126`
- Modify: `src/app/googDevice/client/ShellClient.ts:139+`
- Modify: `src/app/googDevice/client/FileListingClient.ts:586+`
- Modify: `src/packages/multiplexer/Multiplexer.ts:315`

All `getChannelInitData(): Buffer` methods return a small buffer containing a 4-byte ASCII channel code. The Multiplexer's `createChannel(data: Buffer)` consumes them.

- [ ] **Step 1: Update Multiplexer.createChannel signature**

In `src/packages/multiplexer/Multiplexer.ts`, change line 315:

```typescript
// Before:
    public createChannel(data: Buffer): Multiplexer {

// After:
    public createChannel(data: Uint8Array): Multiplexer {
```

Also update `Message.createBuffer` if it types the data parameter as `Buffer` — change to `Uint8Array`. Check the `Message` class in the same file and update any `Buffer` references in the message serialization to use `Uint8Array`. The Multiplexer runs in the browser so this is appropriate.

- [ ] **Step 2: Convert all getChannelInitData methods**

Each method creates a small buffer with an ASCII string. Replace with `TextEncoder`:

**BaseDeviceTracker.ts** (lines 275-280):
```typescript
// Before:
    protected getChannelInitData(): Buffer {
        const code = this.getChannelCode();
        const buffer = Buffer.alloc(code.length);
        buffer.write(code, 'ascii');
        return buffer;
    }

// After:
    protected getChannelInitData(): Uint8Array {
        return new TextEncoder().encode(this.getChannelCode());
    }
```

**HostTracker.ts** (lines 114-118):
```typescript
// Before:
    protected getChannelInitData(): Buffer {
        const buffer = Buffer.alloc(4);
        buffer.write(ChannelCode.HSTS, 'ascii');
        return buffer;
    }

// After:
    protected getChannelInitData(): Uint8Array {
        return new TextEncoder().encode(ChannelCode.HSTS);
    }
```

**ManagerClient.ts** (lines 124-126):
```typescript
// Before:
    protected getChannelInitData(): Buffer {
        return Buffer.from(ManagerClient.CODE);
    }

// After:
    protected getChannelInitData(): Uint8Array {
        return new TextEncoder().encode(ManagerClient.CODE);
    }
```

**ShellClient.ts** — same pattern, find its `getChannelInitData()` and apply identical conversion.

**FileListingClient.ts** — same pattern for its `getChannelInitData()`. (The other Buffer usages in FileListingClient are handled in Task 10.)

- [ ] **Step 3: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`
Expected: `compiled successfully`

- [ ] **Step 4: Commit**

```bash
git add src/app/client/BaseDeviceTracker.ts src/app/client/HostTracker.ts src/app/client/ManagerClient.ts src/app/googDevice/client/ShellClient.ts src/app/googDevice/client/FileListingClient.ts src/packages/multiplexer/Multiplexer.ts
git commit -m "refactor(sp3-1): convert channel init methods and Multiplexer to Uint8Array"
```

---

## Task 10: Convert FileListingClient (Buffer + path)

**Files:**
- Modify: `src/app/googDevice/client/FileListingClient.ts`

FileListingClient has two types of changes: replace `path` imports with `pathUtils`, and replace remaining Buffer usages with BinaryWriter/BinaryReader.

- [ ] **Step 1: Replace path import**

```typescript
// Before (line 2):
import * as path from 'path';

// After:
import { basename, dirname, join, resolve } from '../../pathUtils';
```

Then replace all usages:
- `path.resolve(this.path, name)` → `resolve(this.path, name)`
- `path.basename(download.path)` → `basename(download.path)`
- `path.dirname(download.path)` → `dirname(download.path)`
- `path.join(this.path, name)` → `join(this.path, name)`
- `path.basename(this.path)` → `basename(this.path)`

- [ ] **Step 2: Replace Buffer usages**

FileListingClient has Buffer usage for the ADB file listing protocol (lines 315-319, 384, 589-591).

Add imports: `import { BinaryWriter } from '../../BinaryWriter';`

For the protocol frame builder (~line 315):
```typescript
// Before:
        const len = Buffer.byteLength(path, 'utf-8');
        const payload = Buffer.alloc(cmd.length + 4 + len);
        let pos = payload.write(cmd, 0);
        pos = payload.writeUInt32LE(len, pos);
        payload.write(path, pos);

// After:
        const pathBytes = new TextEncoder().encode(path);
        const cmdBytes = new TextEncoder().encode(cmd);
        const payload = new BinaryWriter(cmdBytes.length + 4 + pathBytes.length)
            .writeBytes(cmdBytes)
            .writeUInt32LE(pathBytes.length)
            .writeBytes(pathBytes)
            .toUint8Array();
```

For data reception (~line 384):
```typescript
// Before:
        const data = Buffer.from(e.data);

// After:
        const data = new Uint8Array(e.data);
```

For getChannelInitData (~line 589): already converted in Task 9.

Update any remaining `buffer.readXxx` calls with BinaryReader.

- [ ] **Step 3: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`
Expected: `compiled successfully`

- [ ] **Step 4: Commit**

```bash
git add src/app/googDevice/client/FileListingClient.ts
git commit -m "refactor(sp3-1): convert FileListingClient to pathUtils + Uint8Array"
```

---

## Task 11: Remove polyfills + final verification

**Files:**
- Modify: `webpack/ws-scrcpy-web.common.ts`
- Modify: `package.json`

- [ ] **Step 1: Remove ProvidePlugin Buffer**

In `webpack/ws-scrcpy-web.common.ts`, delete lines 98-100 from the frontend config:

```typescript
// Delete:
        new webpack.ProvidePlugin({
            Buffer: ['buffer', 'Buffer'],
        }),
```

- [ ] **Step 2: Remove path-browserify fallback**

In the same file, remove the path fallback from resolve (lines 107-109):

```typescript
// Before:
    resolve: {
        fallback: {
            path: 'path-browserify',
        },
        extensions: ['.tsx', '.ts', '.js'],
    },

// After:
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
```

- [ ] **Step 3: Remove devDependencies**

```bash
npm uninstall buffer path-browserify
```

- [ ] **Step 4: Full build**

Run: `npm run build:dev 2>&1 | tail -20`
Expected: Both frontend and backend `compiled successfully` with no errors.

If there are errors about `Buffer` not being defined, they indicate a file was missed — go back and convert it.

- [ ] **Step 5: Verify no Buffer remains in browser code**

```bash
grep -r "Buffer" src/app/ --include="*.ts" | grep -v "// " | grep -v "ArrayBuffer" | grep -v "AudioBuffer" | grep -v "SourceBuffer"
```

Expected: No matches (or only type-only references that don't use Buffer at runtime).

Also check:
```bash
grep -r "from 'buffer'" src/app/ --include="*.ts"
grep -r "from 'path'" src/app/ --include="*.ts"
```

Expected: No matches.

- [ ] **Step 6: Smoke test**

Start the server and verify the stream still works:

```bash
npm run build:dev && node dist/index.js
```

Open `http://localhost:8000/` in a browser. Verify:
1. Device tracker shows the device
2. Click WebCodecs → video stream starts
3. Control buttons (back, home, etc.) still work — these send control messages via the converted `toUint8Array()` path

- [ ] **Step 7: Run lint**

```bash
npx @biomejs/biome check src/app/BinaryWriter.ts src/app/BinaryReader.ts src/app/pathUtils.ts
```

Fix any issues.

- [ ] **Step 8: Commit**

```bash
git add webpack/ws-scrcpy-web.common.ts package.json package-lock.json
git commit -m "refactor(sp3-1): remove Buffer polyfill and path-browserify from browser bundle"
```
