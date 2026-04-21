# ws-scrcpy-web Technical Guide

This document covers the internal architecture of ws-scrcpy-web -- a browser-based Android screen mirroring tool that bridges scrcpy-server's TCP sockets to a multiplexed WebSocket for real-time video, audio, and input control in the browser.

**Target audience:** Developers who need to understand, modify, or debug the codebase without re-discovering its internals.

**scrcpy-server version:** 3.3.4 (vanilla Genymobile binary, no modifications)

---

## Table of Contents

1. [Directory Structure](#1-directory-structure)
2. [Communication Protocol](#2-communication-protocol)
3. [Video Pipeline](#3-video-pipeline)
4. [Audio Pipeline](#4-audio-pipeline)
5. [Input Pipeline](#5-input-pipeline)
6. [Public Stream API](#6-public-stream-api)
7. [Quality Protection System](#7-quality-protection-system)
8. [Device Probe and Codec Selection](#8-device-probe-and-codec-selection)
9. [Server Architecture](#9-server-architecture)
10. [Build and Development](#10-build-and-development)
11. [Known Issues and Fixes](#11-known-issues-and-fixes)
12. [Release Checklist](#12-release-checklist)
13. [Dependency Updater](#13-dependency-updater)
14. [Home Page Architecture](#14-home-page-architecture)
15. [Logging](#15-logging)
16. [Device Labels](#16-device-labels)
17. [Sleep/Wake Toggle](#17-sleepwake-toggle)

---

## 1. Directory Structure

```
src/
├── app/                              # Browser-side code (webpack bundle)
│   ├── player/
│   │   ├── WebCodecsPlayer.ts        # WebCodecs VideoDecoder, codec detection, canvas rendering
│   │   ├── BasePlayer.ts             # State machine, stats tracking, TypedEmitter base
│   │   ├── BaseCanvasBasedPlayer.ts  # Canvas/layer management, frame queue, rAF loop
│   │   ├── h264-utils.ts             # H.264 SPS parser (profile, level, dimensions, SAR)
│   │   ├── h265-utils.ts             # H.265 SPS/VPS parser, NALU type detection
│   │   └── av1-utils.ts              # AV1 OBU parser, Sequence Header, AV1CodecConfigurationRecord
│   ├── audio/
│   │   ├── AudioPlayer.ts            # WebCodecs AudioDecoder, multi-codec, worklet orchestration
│   │   └── PcmWorklet.ts             # AudioWorklet source (ring buffer, inline as string literal)
│   ├── interactionHandler/
│   │   ├── InteractionHandler.ts     # Base: static document.body listeners, touch coordinate math
│   │   └── FeaturedInteractionHandler.ts  # Mouse-to-touch mapping, right-click=BACK, scroll
│   ├── googDevice/
│   │   ├── client/
│   │   │   ├── StreamClientScrcpy.ts # Main client: connects demuxer, player, touch, audio, UHID
│   │   │   ├── ConfigureScrcpy.ts    # Stream configuration modal (extends Modal)
│   │   │   ├── ConnectModal.ts      # Stream experience modal (extends Modal)
│   │   │   ├── ShellModal.ts         # ADB shell terminal modal (extends Modal)
│   │   │   ├── ListFilesModal.ts    # File browser modal (extends Modal)
│   │   │   ├── FileIconUtils.ts     # SVG file type icons + extension mapping
│   │   │   └── DeviceTracker.ts      # Device list UI
│   ├── ui/
│   │   ├── Modal.ts                  # Abstract base class: native <dialog> with glassmorphism
│   │   └── __tests__/modal.test.ts   # Modal unit tests (19 tests)
│   │   ├── UhidManager.ts            # Creates/destroys UHID keyboard+mouse devices
│   │   ├── UhidKeyboardHandler.ts    # Keyboard events -> USB HID key reports
│   │   ├── UhidMouseHandler.ts       # Pointer lock mouse -> USB HID mouse reports
│   │   ├── KeyInputHandler.ts        # Legacy scrcpy keycode input (Android keycodes)
│   │   ├── hid-usage-tables.ts       # Browser code -> USB HID keycode mapping tables
│   │   └── toolbox/                  # Toolbar UI (GoogToolBox)
│   ├── controlMessage/
│   │   ├── ControlMessage.ts         # Base class, type constants (0-17, 101-102)
│   │   ├── TouchControlMessage.ts    # 32-byte binary touch event
│   │   ├── KeyCodeControlMessage.ts  # Android keycode event
│   │   ├── ScrollControlMessage.ts   # Scroll event with position
│   │   ├── UhidCreateMessage.ts      # UHID device creation with HID descriptors
│   │   ├── UhidInputMessage.ts       # UHID input reports (keyboard 8-byte, mouse 4-byte)
│   │   └── UhidDestroyMessage.ts     # UHID device teardown
│   ├── client/
│   │   ├── BaseClient.ts             # URL parameter parsing, session setup
│   │   ├── DeviceProbeClient.ts      # Browser-side probe: WebSocket to server DeviceProbe
│   │   └── HostTracker.ts            # Multi-host device discovery
│   ├── ScrcpyDemuxer.ts              # WebSocket channel demultiplexer (browser-side)
│   └── index.ts                      # Browser entry point
├── server/                            # Node.js server
│   ├── ScrcpyConnection.ts           # TCP-to-WebSocket bridge (the core server middleware)
│   ├── FrameReader.ts                # Parses scrcpy frame format from TCP stream
│   ├── ScrcpyOptions.ts              # Builds scrcpy-server CLI arguments
│   ├── DeviceProbe.ts                # Probes device for available encoders via ADB
│   ├── AdbClient.ts                  # ADB command wrapper (push, shell, reverse)
│   ├── Config.ts                     # Configuration loader (env vars + config.json)
│   ├── index.ts                      # Server entry point, service/middleware registration
│   ├── mw/
│   │   ├── Mw.ts                     # Middleware base class
│   │   ├── WebsocketMultiplexer.ts   # Multiplexes sub-protocols over a single WS
│   │   └── HostTracker.ts            # Server-side device tracker broadcast
│   └── services/
│       ├── HttpServer.ts             # Static file server
│       └── WebSocketServer.ts        # WS upgrade handler, routes to middleware
├── common/                            # Shared between server and browser
│   ├── ChannelId.ts                  # Channel enum: VIDEO=0, AUDIO=1, CONTROL=2, DEVICE_MSG=3, METADATA=4
│   ├── ScrcpyCodec.ts               # Codec ID constants (4-byte magic values) and name lookup
│   ├── Constants.ts                  # Server version, package name, device paths
│   ├── Action.ts                     # WebSocket action identifiers (STREAM_SCRCPY, PROBE_DEVICE, etc.)
│   ├── ProbeResult.ts                # Probe response interface
│   └── TypedEmitter.ts              # Type-safe event emitter
└── style/app.css                      # Home-page CSS (@imports ws-scrcpy.css for stream/toolbar styles)
```

---

## 2. Communication Protocol

### 2.1 WebSocket Multiplexing

All communication between browser and server flows through a single WebSocket connection. Every message is prefixed with a 1-byte channel identifier:

| Channel | ID | Direction | Purpose |
|---------|-----|-----------|---------|
| `VIDEO` | `0` | Server -> Browser | Encoded video frames |
| `AUDIO` | `1` | Server -> Browser | Encoded audio frames |
| `CONTROL` | `2` | Browser -> Server | Touch, key, scroll, UHID commands |
| `DEVICE_MSG` | `3` | Server -> Browser | Clipboard, ACK from device |
| `METADATA` | `4` | Server -> Browser | Session metadata (sent once at start) |

Wire format for every WebSocket message:

```
[1 byte: channel ID] [N bytes: payload]
```

The channel byte is prepended by `ScrcpyConnection.sendChannel()` on the server and stripped by `ScrcpyDemuxer.onMessage()` in the browser.

### 2.2 Session Metadata

Sent once on channel 4 immediately after the TCP sockets are established. The payload is a UTF-8 JSON string:

```json
{
    "deviceName": "Pixel 7",
    "videoCodec": "h265",
    "screenWidth": 1080,
    "screenHeight": 2400,
    "audioCodec": "opus",
    "videoEncoder": "c2.qcom.hevc.encoder"
}
```

The browser uses this to initialize the player canvas dimensions, configure the audio decoder, and populate the quality stats overlay.

### 2.3 Media Frame Format

Video (channel 0) and audio (channel 1) frames share an identical wire format:

```
[8 bytes: PTS (uint64 big-endian)] [4 bytes: size (uint32 big-endian)] [size bytes: encoded data]
```

The 12-byte header is defined in both `FrameReader.ts` (server) and `ScrcpyDemuxer.ts` (browser) as `FRAME_HEADER_SIZE = 12`.

### 2.4 PTS Flag Bits

The top two bits of the 64-bit PTS field carry frame type information:

| Bit | Mask | Meaning |
|-----|------|---------|
| 63 (MSB) | `0x8000000000000000` | Config packet (SPS/PPS, AudioSpecificConfig, etc.) |
| 62 | `0x4000000000000000` | Keyframe (IDR for H.264/H.265, key OBU for AV1) |

The actual presentation timestamp is extracted by masking with `0x3FFFFFFFFFFFFFFF`:

```typescript
const isConfig = (rawPts & PTS_FLAG_CONFIG) !== 0n;
const isKeyframe = (rawPts & PTS_FLAG_KEYFRAME) !== 0n;
const pts = rawPts & PTS_CLEAR_FLAGS;
```

These flags are set by scrcpy-server on the TCP stream, parsed by `FrameReader` on the server, then re-encoded into the WebSocket frame headers by `ScrcpyConnection.startForwarding()`. The browser's `ScrcpyDemuxer.handleMediaFrame()` parses them again.

### 2.5 Control Messages (Browser -> Server)

Control messages are sent on channel 2. The browser prepends the channel byte, and the server's `ScrcpyConnection.onSocketMessage()` strips it before forwarding the raw payload to the scrcpy-server control socket.

Each control message type is identified by its first byte:

| Type | ID | Description |
|------|----|-------------|
| `TYPE_KEYCODE` | `0` | Android keycode press/release |
| `TYPE_TEXT` | `1` | Text injection |
| `TYPE_TOUCH` | `2` | Touch event (32 bytes payload) |
| `TYPE_SCROLL` | `3` | Scroll event with position |
| `TYPE_BACK_OR_SCREEN_ON` | `4` | Back button or wake screen |
| `TYPE_GET_CLIPBOARD` | `8` | Request clipboard content (payload: `copy_key` u8) |
| `TYPE_SET_CLIPBOARD` | `9` | Set clipboard content (payload: sequence u64 BE, paste u8, length u32 BE, text) |
| `TYPE_UHID_CREATE` | `12` | Create UHID virtual device |
| `TYPE_UHID_INPUT` | `13` | Send HID input report |
| `TYPE_UHID_DESTROY` | `14` | Destroy UHID virtual device |

---

## 3. Video Pipeline

### 3.1 Server Side: TCP to WebSocket Bridge

The connection lifecycle in `ScrcpyConnection.start()`:

1. **Push binary:** ADB-push `scrcpy-server.jar` to `/data/local/tmp/scrcpy-server.jar`
2. **TCP server:** Create an ephemeral-port TCP server on `127.0.0.1`
3. **ADB reverse tunnel:** `adb reverse localabstract:scrcpy_<scid> tcp:<port>` so scrcpy-server can connect back
4. **Launch scrcpy-server:** Via `adb shell` with `CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 3.3.4 <options>`
5. **Accept 3 TCP sockets:** Video, audio, and control, in that order (10-second timeout)
6. **Parse metadata:** 76 bytes from the video socket:
   - Bytes 0-63: Device name (null-terminated UTF-8, padded to 64 bytes)
   - Bytes 64-67: Video codec ID (uint32 BE, e.g., `0x68323635` = "h265")
   - Bytes 68-71: Screen width (uint32 BE)
   - Bytes 72-75: Screen height (uint32 BE)
   - Audio socket: 4 bytes for audio codec ID (or `0x00000000` disabled / `0x00000001` error)
7. **Send metadata:** JSON on channel 4 to the browser
8. **Start forwarding:** `FrameReader` instances on video and audio TCP sockets parse the frame-header format and forward via `sendChannel()`

The `FrameReader` accumulates TCP chunks into an internal buffer and drains complete frames (12-byte header + payload). It emits typed `ScrcpyFrame` objects with `type: 'config' | 'keyframe' | 'frame'`.

### 3.2 Browser Side: Demuxer to Player

`ScrcpyDemuxer` receives binary WebSocket messages, strips the channel byte, and dispatches:

```
WebSocket -> ScrcpyDemuxer.onMessage()
    -> channel 0 -> handleMediaFrame() -> videoCallback(data, pts, isConfig, isKeyframe)
    -> channel 1 -> handleMediaFrame() -> audioCallback(data, pts, isConfig)
    -> channel 3 -> deviceMsgCallback(payload)
    -> channel 4 -> handleMetadata() -> metadataCallback(parsed JSON)
```

`StreamClientScrcpy` wires the callbacks:
- `onVideoFrame` -> `WebCodecsPlayer.pushVideoFrame()`
- `onAudioFrame` -> `AudioPlayer.pushFrame()`
- `onMetadata` -> Initialize audio player, set canvas dimensions

### 3.3 Codec Detection and Configuration

`WebCodecsPlayer.parseConfig()` receives config packets (PTS bit 63 set) and auto-detects the codec by inspecting the bitstream:

**H.264 detection:** Looks for Annex B start codes (`00 00 00 01` or `00 00 01`), then checks if the first NALU type is 7 (SPS). Parses the SPS via `parseSPS()` from `h264-utils.ts` to extract profile, level, and dimensions. Generates a WebCodecs codec string like `avc1.42E01E`.

**H.265 detection:** Same start code scan, but checks for HEVC NALU types VPS (32) or SPS (33) using `hevcNalType()`. Parses via `parseHevcSPS()` from `h265-utils.ts`. Generates codec strings like `hev1.1.6.L93.B0`.

**AV1 detection:** No Annex B start codes present. First tries `parseAv1ConfigRecord()` (4-byte AV1CodecConfigurationRecord with marker bit = 1), then falls back to raw OBU Sequence Header parsing via `parseAv1SequenceHeader()`. Generates codec strings like `av01.0.04M.08`.

### 3.4 Config Prepending

A critical difference between codecs:

- **H.264 and H.265:** The `configData` (SPS/PPS or VPS/SPS/PPS) must be prepended to every keyframe before passing to `VideoDecoder.decode()`. Without this, the decoder cannot decode the keyframe independently.
- **AV1:** Config prepending is not needed. Keyframes are self-contained.

```typescript
if (this.detectedCodec === 'av1') {
    // AV1: decode keyframe directly
    this.decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: Number(pts), data }));
} else {
    // H.264/H.265: prepend config data
    const fullData = new Uint8Array(this.configData.length + data.length);
    fullData.set(this.configData);
    fullData.set(data, this.configData.length);
    this.decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: Number(pts), data: fullData }));
}
```

### 3.5 Decoder Configuration

When a config packet arrives, `WebCodecsPlayer` calls `VideoDecoder.configure()` with:

```typescript
this.decoder.configure({
    codec: result.codec,       // e.g., "hev1.1.6.L93.B0"
    codedWidth: codedW,        // From SPS parse (may include alignment padding)
    codedHeight: codedH,       // e.g., 1088 for a 1080p stream
    optimizeForLatency: true,
});
```

The canvas is sized to the **display dimensions** (from scrcpy metadata), not the coded dimensions. This distinction matters; see [Known Issues](#111-h265-coded-vs-display-dimensions).

### 3.6 Canvas Rendering

`drawDecoded()` pulls decoded `VideoFrame` objects from a queue and renders them to a 2D canvas:

```typescript
protected drawDecoded = (): void => {
    const frame: VideoFrame = this.decodedFrames.shift().frame;
    if (frame.displayWidth !== frame.codedWidth || frame.displayHeight !== frame.codedHeight) {
        // Edge H.265 fix: use 8-arg drawImage with full coded rect as source
        this.context.drawImage(frame, 0, 0, frame.codedWidth, frame.codedHeight, 0, 0, cw, ch);
    } else {
        this.context.drawImage(frame, 0, 0);
    }
    frame.close();
};
```

The frame queue is drained via `requestAnimationFrame`. When the queue is empty, the rAF loop stops and restarts when new frames arrive.

---

## 4. Audio Pipeline

### 4.1 Codec Support

| Codec | WebCodecs String | Config Handling | Notes |
|-------|-----------------|-----------------|-------|
| Opus | `opus` | No config packet needed; configure immediately | Default codec, most reliable |
| AAC | `mp4a.40.2` | Config packet = AudioSpecificConfig; reconfigure decoder on receipt | |
| FLAC | `flac` | Config packet = STREAMINFO block; reconfigure decoder on receipt | |
| Raw PCM | N/A | Bypasses AudioDecoder entirely | S16LE interleaved stereo, converted to Float32 |

### 4.2 AudioPlayer Architecture

```
ScrcpyDemuxer (channel 1)
    -> AudioPlayer.pushFrame(data, pts, isConfig)
        -> isConfig? Store configData, (re)configure decoder
        -> raw? pushRawPcm() -> convert S16LE -> Float32 -> worklet
        -> else: AudioDecoder.decode() -> postDecodedAudio() -> worklet
```

The `AudioContext` is created with `latencyHint: 'interactive'` and `sampleRate: 48000`. A `GainNode` between the worklet and destination provides volume control.

### 4.3 PcmWorklet Ring Buffer

The `PcmWorklet` is loaded via Blob URL (the source code is an inline string in `PcmWorklet.ts`). It implements a simple ring buffer:

- Decoded audio frames arrive as `Float32Array[]` channel data via `port.postMessage()`
- The `process()` callback reads from the queue, filling the 128-sample output buffer
- On underrun, remaining samples are filled with silence (zeros)
- Transferable arrays are used for zero-copy message passing

### 4.4 Autoplay Policy

Browsers block audio playback until a user gesture. `StreamClientScrcpy` registers one-shot `click` and `keydown` listeners on `document` to call `AudioPlayer.resume()` (which resumes a suspended `AudioContext`).

---

## 5. Input Pipeline

### 5.1 Touch and Mouse Input

**InteractionHandler** (base class) registers static `document.body` event listeners shared across all handler instances. Events are filtered by checking `event.target === this.tag` (the touchable canvas element). This design means only one set of body-level listeners exists regardless of how many device streams are active.

**FeaturedInteractionHandler** extends the base with two input modes, toggled via a toolbar button:

**D-pad mode** (default — d-pad icon in toolbar):
- **Left-click → DPAD_CENTER:** Sends `KeyCodeControlMessage` with keycode 23 — works in all Android TV / Leanback apps (Peacock, Netflix, etc.) that ignore touch events
- **Scroll up/down → DPAD_UP/DOWN:** One keypress per physical scroll click via fire-then-debounce (400ms cooldown absorbs hardware burst)
- **Shift+scroll → DPAD_LEFT/RIGHT:** Horizontal d-pad navigation via mouse wheel
- **Right-click → BACK:** `event.button === 2` sends keycode 4 (AKEYCODE_BACK)
- **Middle-click → HOME:** `event.button === 1` sends keycode 3 (AKEYCODE_HOME)

**Touch mode** (finger icon in toolbar):
- **Left-click → TouchControlMessage:** Tap at screen coordinates, works in touch-aware apps and games
- **Scroll → ScrollControlMessage:** 30ms throttling, i16 fixed-point encoding (`sc_float_to_i16fp`): raw tick divided by 128 (tuned for latent streams; scrcpy desktop uses /16), clamped to [-1, 1], mapped to int16 range [-32768, 32767]
- **Right-click → BACK, Middle-click → HOME:** Same as D-pad mode
- **Multi-touch simulation:** Ctrl+click creates a second mirrored touch point (Ctrl+Shift allows custom center)

**Coordinate translation** in `buildTouchOnClient()`:

1. Get canvas bounding rect
2. Translate client coordinates to canvas-relative coordinates
3. Handle aspect ratio letterboxing (adjust for black bars)
4. Scale to device screen dimensions
5. Create `Position(Point(x, y), Size(screenWidth, screenHeight))`

### 5.2 TouchControlMessage Wire Format

Total size: 32 bytes (1 type + 31 payload)

```
Offset  Size  Field
0       1     type (0x02 = TYPE_TOUCH)
1       1     action (DOWN=0, UP=1, MOVE=2)
2       4     pointerId high 32 bits (always 0)
6       4     pointerId low 32 bits
10      4     x position (uint32 BE)
14      4     y position (uint32 BE)
18      2     screen width (uint16 BE)
20      2     screen height (uint16 BE)
22      2     pressure (uint16 BE, 0x0000-0xFFFF)
24      4     actionButton (uint32 BE)
28      4     buttons (uint32 BE)
```

Pressure is normalized: browser `TouchEvent.force` (0.0-1.0) is multiplied by `0xFFFF`.

### 5.3 Touch State Validation

`InteractionHandler.validateMessage()` maintains a `Map<pointerId, TouchControlMessage>` to track active pointers. It handles edge cases:

- **Stale DOWN:** If a new DOWN arrives for a pointer that already has an active DOWN (e.g., mouseup was lost during a reconnection), a synthetic UP is injected first
- **Orphan MOVE:** If a MOVE arrives with no preceding DOWN, a synthetic DOWN is emitted
- **Mouse leave:** When the cursor leaves the canvas, all active pointers are released with synthetic UPs

### 5.4 UHID Hardware Input

UHID (User-space HID) creates virtual USB devices on the Android device via scrcpy-server's UHID control message types. This provides hardware-level input that works with any app, including those that ignore injected events.

**UhidManager** orchestrates the lifecycle:
- On enable: sends `UhidCreateMessage` for keyboard (ID=1) and mouse (ID=2)
- On disable: sends `UhidDestroyMessage` for both
- When active, disables the regular touch handler and keyboard handler

**UhidKeyboardHandler:**
- Listens to `document` keydown/keyup events
- Maps browser `event.code` (e.g., `"KeyA"`) to USB HID usage codes via `CODE_TO_HID` table
- Tracks modifier state (Ctrl, Shift, Alt, Meta) as a bitmask
- Sends 8-byte keyboard reports: `[modifier, reserved, key1, key2, key3, key4, key5, key6]`
- Maximum 6 simultaneous keys (USB HID boot protocol limit)
- On detach, sends an empty report to release all keys

**UhidMouseHandler:**
- Uses Pointer Lock API (`canvas.requestPointerLock()`) for relative mouse movement
- Maps `event.movementX/Y` to signed 8-bit deltas (clamped to -127..127)
- Sends 4-byte mouse reports: `[buttons, dx, dy, wheel]`
- Button state tracked as bitmask: bit 0 = left, bit 1 = right, bit 2 = middle
- On pointer lock release, sends a zero report to release all buttons

**HID Descriptors** (in `UhidCreateMessage.ts`):
- Keyboard: Standard boot protocol descriptor (Usage Page 0x07, 8-byte reports)
- Mouse: Standard 3-axis relative device (5 buttons, X/Y movement, scroll wheel)

---

## 6. Public Stream API

`WsScrcpy.startStream(container, deviceId, options)` is the canonical public API for rendering a scrcpy stream into any DOM element. It ships as three artifacts from `dist/public/`:

- `ws-scrcpy.umd.js` -- UMD bundle exposing `window.WsScrcpy`
- `ws-scrcpy.esm.js` -- native ES module with named `startStream` export
- `ws-scrcpy.d.ts` -- bundled TypeScript declarations

`embed.html` (also shipped in `dist/public/`) is a thin wrapper that reads URL parameters and calls the same library. There is one code path; the home page's own `ConnectModal` dogfoods it too.

### 6.1 UMD Usage

```html
<script src="/ws-scrcpy.umd.js"></script>
<script>
  const handle = WsScrcpy.startStream(
      document.getElementById('stream-container'),
      'ip:5555',
      {
          codec: 'h265',
          onConnect: (info) => console.log('connected:', info),
      },
  );
  // handle.stop(); // tear down later
</script>
```

### 6.2 ESM Usage

```js
import { startStream } from '/ws-scrcpy.esm.js';

const handle = startStream(container, 'ip:5555', { codec: 'h265' });
```

In TypeScript projects, point your compiler at the shipped declaration file to get typed `StartStreamOptions` / `StreamHandle` / `StreamInfo` interfaces.

### 6.3 `StartStreamOptions`

The full options interface (source: `src/app/public/types.ts`):

```ts
export interface StartStreamOptions {
    // Connection (optional — defaults to current location)
    host?: string;
    port?: number;
    secure?: boolean;
    pathname?: string;

    // Stream settings (optional — smart auto-selection if omitted)
    codec?: 'h264' | 'h265' | 'av1';
    encoder?: string;
    bitrate?: number;
    maxFps?: number;
    maxSize?: number;

    // Features
    audio?: boolean;      // default true
    keyboard?: boolean;   // default true

    // Lifecycle callbacks
    onConnect?: (info: StreamInfo) => void;
    onDisconnect?: (reason?: string) => void;
    onError?: (err: Error) => void;
}
```

**Connection**

| Field | Purpose |
|-------|---------|
| `host` | Server hostname. Defaults to `location.hostname`. |
| `port` | Server port. Defaults to `location.port`. |
| `secure` | Use `wss://` / `https://` when `true`. Defaults to `location.protocol === 'https:'`. |
| `pathname` | HTTP path prefix for the WebSocket endpoint. Defaults to `location.pathname`. |

**Stream settings** — all optional. Omit them and the library runs smart auto-selection against the device's probed encoder list (H.265 preferred, then H.264, then AV1, filtered by what the browser can decode).

| Field | Purpose |
|-------|---------|
| `codec` | Force a specific codec: `'h264'`, `'h265'`, or `'av1'`. |
| `encoder` | Force a specific encoder name (e.g. `'c2.mtk.hevc.encoder'`). Must be paired with a valid `codec`. |
| `bitrate` | Target video bitrate in bits per second. |
| `maxFps` | Frame rate cap. |
| `maxSize` | Pixel bound on the longest dimension (scrcpy will scale to fit). |

**Features**

| Field | Purpose |
|-------|---------|
| `audio` | Enable audio streaming. Default `true`. |
| `keyboard` | Capture keyboard input from the container and forward it. Default `true`. |

**Lifecycle callbacks** — see section 6.5.

### 6.4 `StreamHandle`

`startStream()` returns a handle:

```ts
export interface StreamHandle {
    stop(): void;
    readonly isConnected: boolean;
    readonly deviceId: string;
}
```

- `stop()` closes the WebSocket, disposes the decoder and audio worklet, and empties the container. Idempotent — calling it twice is a no-op.
- `isConnected` flips to `true` when session metadata arrives and back to `false` when the stream ends (for any reason).
- `deviceId` echoes the `deviceId` argument regardless of connection success.

Calling `startStream()` a second time on the same container without first calling `stop()` throws `Error('container already has an active stream; call stop() first')`.

### 6.5 Lifecycle Callbacks

- **`onConnect(info)`** fires once, as soon as session metadata is received. `info` contains the actual resolved `codec`, `encoder`, and `resolution` strings. Note: this fires at metadata receipt, not first decoded frame — the codebase has no first-frame signal today. This is a deliberate simplification. A future `onFirstFrame` callback would be a non-breaking addition.
- **`onDisconnect(reason?)`** fires once when the stream ends for any reason: the device disconnects, the WebSocket closes, or the caller invokes `handle.stop()`. `reason` is a short human-readable string when available.
- **`onError(err)`** fires on startup failures (missing `deviceId`, device probe failure, WebSocket refused) and on abnormal WebSocket close codes. A startup error does NOT also fire `onDisconnect` — it's an error that prevented connection, not a disconnect. `handle.isConnected` stays `false`.

### 6.6 `embed.html` URL Parameters

`/embed.html` is a zero-config iframe target. It reads these URL parameters, maps them to `StartStreamOptions`, and calls the library. Unknown parameters are silently ignored for forward compatibility.

| URL Param   | Type   | Default                          | Notes                                                     |
|-------------|--------|----------------------------------|-----------------------------------------------------------|
| `device`    | string | **required**                     | ADB serial or `ip:port`. Missing -> error, no stream.     |
| `host`      | string | `location.hostname`              | Server hostname.                                          |
| `port`      | int    | `location.port`                  | Parsed via `parseInt`; `NaN` falls back to the default.   |
| `secure`    | bool   | `location.protocol === 'https:'` | `"true"` / `"false"` string-to-bool.                      |
| `pathname`  | string | `location.pathname`              | HTTP path prefix for the WebSocket endpoint.              |
| `codec`     | string | auto                             | Only `"h264"`, `"h265"`, `"av1"` accepted; others ignored.|
| `encoder`   | string | auto                             | Forced encoder name.                                      |
| `bitrate`   | int    | auto                             | Video bitrate in bps.                                     |
| `maxFps`    | int    | auto                             | Frame rate cap.                                           |
| `maxSize`   | int    | auto                             | Longest-dimension pixel bound.                            |
| `audio`     | bool   | `true`                           | `"true"` / `"false"`. Server force-disables on Android 10 or older. |
| `audioSource` | string | `output`                         | `"playback"` / `"output"` / `"mic"`. `output` (default) silences device audio during the session, matching scrcpy's own default. `playback` requires Android 13+ and uses `--audio-dup` to keep device audio playing during capture. |
| `audioCodec`  | string | `opus`                            | `"opus"` / `"aac"` / `"flac"` / `"raw"`. `aac` is the documented fallback when a device's Opus encoder fails. |
| `keyboard`  | bool   | `true`                           | `"true"` / `"false"`.                                     |

`embed.html` sets `body { background: transparent }` so iframe consumers can place any background they like behind the video. A small status overlay in the top-left shows `connecting...`, then `connected <codec> <resolution>` (auto-hides after 2 s), or an error / disconnect message.

### 6.7 Migration from the Old Embed Mode

This section replaces the previous CSS-hack embed mode. Breaking changes:

- **`#!action=stream&udid=...` hash routing is REMOVED.** Direct-link stream access now uses `/embed.html?device=<udid>` (or call `startStream()` directly from your own page).
- **`?embed=true` URL param is REMOVED** along with the `body.embed` CSS class. `embed.html` always runs with a transparent background — there is no flag to toggle.
- **The `more-box` overflow UI is REMOVED** (YAGNI — all its functions were already duplicated in the toolbar). Clipboard sync is now first-class: the toolbar has separate GET and SET clipboard buttons.
- **TypeScript types are shipped** as `dist/public/ws-scrcpy.d.ts`, bundled so no `src/**` imports leak.

### 6.8 Internal Architecture

`StreamClientScrcpy` (in `src/app/googDevice/client/`) is the rendering engine. It handles the WebSocket connection, video demuxer, WebCodecs decoder, audio worklet, touch / keyboard / UHID input, and toolbar wiring.

The public API in `src/app/public/` is a thin typed facade:

- `types.ts` -- `StartStreamOptions`, `StreamInfo`, `StreamHandle` interfaces
- `startStream.ts` -- validates options, constructs the underlying parameter objects, invokes `StreamClientScrcpy`, returns a handle with lifecycle wiring
- `index.ts` -- re-exports `startStream` and `version` for the library bundles
- `embed-entry.ts` -- `embed.js` source: URL-param parsing + `startStream()` call + status overlay

The home page's `ConnectModal` imports `startStream` from the same TypeScript source that the library bundles are built from. This is deliberate: one code path, one set of bugs, and any regression that breaks external consumers also breaks the home page.

---

## 7. Quality Protection System

The quality protection system in `StreamClientScrcpy` detects when the video encoder's output quality has degraded (typically due to scrcpy-server's internal rate control) and automatically refreshes the stream to request a fresh keyframe.

### 7.1 Frame Size Monitoring

```
frameSizes[]: rolling window of 30 non-config frame sizes (in bytes)
baselineFrameSize: average of the first 30 frames (established once)
degradationCount: consecutive windows that fail the threshold check
```

Every non-config video frame's byte size is appended to `frameSizes[]`. After the first 30 frames establish the baseline, the window shifts (oldest frame removed) and `checkForDegradation()` runs.

### 7.2 Degradation Detection

```typescript
const avg = frameSizes.reduce((a, b) => a + b, 0) / frameSizes.length;
if (avg < baselineFrameSize * 0.10) {
    degradationCount++;
    if (degradationCount >= 5) {
        // 5 consecutive bad windows -> refresh
    }
} else {
    degradationCount = 0;  // Reset on recovery
}
```

The threshold is 10% of baseline. The 10% value was tuned after 25% proved too sensitive for static content (screensavers, idle screens produce legitimately small delta frames).

### 7.3 Stream Refresh

`refreshStream()` performs a full reconnection cycle:

1. Set `isRefreshing = true` (protects the touch handler from being destroyed)
2. Close the existing `ScrcpyDemuxer`
3. Stop the `AudioPlayer`
4. Stop and re-pause the player (clears decoded frame queue)
5. Create a new `ScrcpyDemuxer` with the same stream URL
6. Re-wire all callbacks
7. Set `isRefreshing = false`

This triggers a new scrcpy-server session on the server side, which starts with a fresh keyframe.

### 7.4 Cooldown

A 30-second cooldown (`lastRefreshTime`) prevents refresh storms. The cooldown was increased from 10 seconds after testing showed encoder quality sometimes needs time to stabilize after a refresh.

---

## 8. Device Probe and Codec Selection

### 8.1 Probe Flow

```
Browser                          Server
  |                                |
  |-- WS (action=probe, udid) --> |
  |                                |-- adb shell dumpsys media.player
  |                                |-- adb shell wm size
  |                                |-- adb shell wm density
  |                                |
  | <-- JSON ProbeResult ---------|
  |                                |-- WS close(1000)
```

`DeviceProbeClient` opens a one-shot WebSocket to the server. `DeviceProbe` (server middleware) runs three ADB shell commands in parallel, parses the output for encoder names (matching patterns like `.avc.`, `.hevc.`, `.av1.`), screen dimensions, and density, then sends a `ProbeResult` JSON and closes.

### 8.2 Auto-Selection Algorithm

`detectBestCodecAndEncoder()` in `StreamClientScrcpy.ts`:

1. **Probe the device** for available encoders
2. **For each codec in preference order** (`h265` > `h264` > `av1`):
   a. Check if the device has an encoder for this codec (pattern match in encoder names)
   b. Check if the browser can decode it (`VideoDecoder.isConfigSupported()`)
   c. If both pass, select this codec
3. **Pick the best encoder** for the selected codec:
   - Hardware encoders preferred: match against `/\.mtk\.|\.qcom\.|\.exynos\.|\.intel\.|\.nvidia\./i`
   - Fall back to first available (typically `c2.android.*` software encoders)
4. **Fallback:** If probe fails entirely, try browser-only detection (same codec preference order) and default to H.264

### 8.3 Firefox Quirk

Firefox's `VideoDecoder.isConfigSupported()` incorrectly returns `false` for some H.264 profile strings (e.g., `avc1.42E01E`) despite being able to decode them. The workaround:

```typescript
async function browserSupportsCodec(codec: string): Promise<boolean> {
    if (codec === 'h264') return true;  // Skip the check for H.264
    // ... normal isConfigSupported check for h265/av1
}
```

---

## 9. Server Architecture

### 9.1 Entry Point

`src/server/index.ts` starts the server:

1. **Services:** `HttpServer` (static files) and `WebSocketServer` (WS upgrade handler) are started
2. **Direct WebSocket middleware** (registered on `WebSocketServer`):
   - `ScrcpyConnection` -- handles `action=stream` (video/audio/control bridging)
   - `DeviceProbe` -- handles `action=probe` (encoder enumeration)
   - `WebsocketMultiplexer` -- handles `action=multiplex` (sub-protocol multiplexing)
3. **Multiplexed middleware** (registered on `WebsocketMultiplexer`):
   - `HostTracker` -- device discovery
   - `DeviceTracker` -- ADB device list broadcast
   - `RemoteShell` -- terminal access via node-pty (messages: `start`, `resize`, `stop`)
   - `FileListing` -- file manager operations

### 9.2 Middleware Pattern

All middleware extends `Mw` (base class):

```typescript
export abstract class Mw {
    static processRequest(ws: WS, params: RequestParameters): Mw | undefined;
    protected abstract onSocketMessage(event: WS.MessageEvent): void;
    public release(): void;
}
```

The `WebSocketServer` iterates registered `MwFactory` objects and calls `processRequest()` for each incoming WebSocket. The first factory that returns a non-undefined `Mw` instance claims the connection.

### 9.3 ScrcpyConnection Lifecycle

```
Browser WS connect (action=stream, udid=xxx, videoCodec=h265, ...)
    -> ScrcpyConnection created
    -> ADB push scrcpy-server
    -> Create TCP server (ephemeral port)
    -> ADB reverse tunnel
    -> Launch scrcpy-server process
    -> Accept 3 TCP sockets (video, audio, control)
    -> Parse 76-byte video metadata + 4-byte audio metadata
    -> Send metadata JSON to browser (channel 4)
    -> Start FrameReader on video + audio sockets
    -> Forward: TCP frames -> channel prefix -> WS send
    -> Forward: WS channel 2 -> control TCP socket
    -> On disconnect: kill process, remove reverse, close sockets
```

### 9.4 Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `8000` | HTTP/WS server port |
| `ADB_PATH` | `adb` | Path to ADB executable |
| `CONFIG_PATH` | `config.json` | Path to config file |

---

## 10. Build and Development

### 10.1 Scripts

| Command | Purpose |
|---------|---------|
| `npm run build` | Production webpack build (output to `dist/`) |
| `npm run build:dev` | Development build with source maps |
| `npm start` | Build + run (`node dist/index.js`) |
| `npm test` | Run tests with Vitest |
| `npm run lint` | Check code style with Biome |
| `npm run format` | Auto-fix code style |

### 10.2 Stack

- **Runtime:** Node.js 24 LTS
- **Language:** TypeScript 6.x
- **Bundler:** Webpack 5 (separate configs for dev/prod in `webpack/`)
- **Linter/Formatter:** Biome 2.x (replaces ESLint + Prettier)
- **Tests:** Vitest 4.x
- **Runtime dependencies:** `ws` (WebSocket server, bundled into webpack output), `node-pty` (terminal emulation, native addon)
- **Browser APIs:** WebCodecs (`VideoDecoder`, `AudioDecoder`), AudioWorklet, Pointer Lock, Canvas 2D

### 10.3 Webpack Configuration

Two separate webpack configs:
- `webpack/ws-scrcpy-web.prod.ts` -- production (minified, no source maps)
- `webpack/ws-scrcpy-web.dev.ts` -- development (source maps, faster builds)

The build produces a server bundle (`dist/index.js`) and a browser bundle (served as static files). Node.js built-ins (`net`, `crypto`, `path`, etc.) are externalized from the server bundle. The browser bundle avoids any Node.js polyfills.

---

## 11. Known Issues and Fixes

### 11.1 H.265 Coded vs Display Dimensions

**Problem:** H.265 encoders commonly align coded dimensions to multiples of 8 or 16. A 1920x1080 display produces coded dimensions of 1920x1088 (1080 rounded up to nearest multiple of 8). When the canvas was sized to coded dimensions, two issues appeared:

1. Touch coordinates sent to scrcpy-server used 1088 as the screen height, but scrcpy-server expects the actual display height (1080). Touches were rejected or offset.
2. The video had an 8-pixel black bar at the bottom.

**Fix (WebCodecsPlayer):** The canvas is always sized to **display dimensions** from scrcpy metadata (`metadataWidth`, `metadataHeight`), while `VideoDecoder.configure()` receives the **coded dimensions** from the SPS parser. This ensures touch coordinates match what scrcpy-server expects, while the decoder can handle alignment padding internally.

```typescript
const codedW = result.width || this.metadataWidth;     // From SPS (e.g., 1088)
const codedH = result.height || this.metadataHeight;
const displayW = this.metadataWidth || result.width;    // From metadata (e.g., 1080)
const displayH = this.metadataHeight || result.height;
this.scaleCanvas(displayW, displayH);                   // Canvas = display dims
this.decoder.configure({ codec, codedWidth: codedW, codedHeight: codedH, ... });
```

### 11.2 Edge H.265 Canvas Rendering

**Problem:** Microsoft Edge reports `VideoFrame.displayWidth !== VideoFrame.codedWidth` for H.265 content (e.g., displayWidth=1920, codedWidth=1920 but displayHeight=1080, codedHeight=1088). The default `drawImage(frame, 0, 0)` call would only render the display rect, leaving artifacts or stretching.

**Fix:** When display and coded dimensions differ, use the 8-argument form of `drawImage` to explicitly source from the full coded rect and scale to the canvas:

```typescript
if (frame.displayWidth !== frame.codedWidth || frame.displayHeight !== frame.codedHeight) {
    this.context.drawImage(frame, 0, 0, frame.codedWidth, frame.codedHeight, 0, 0, cw, ch);
} else {
    this.context.drawImage(frame, 0, 0);
}
```

### 11.3 Touch Handler Destroyed During Stream Refresh (Race Condition)

**Problem:** When `refreshStream()` closed the old demuxer, the WebSocket `onclose` event fires **asynchronously** — after `refreshStream()` has already finished and created the new demuxer. The original fix used an `isRefreshing` flag, but this flag was set back to `false` synchronously within `refreshStream()`. The async `onclose` event from the old demuxer would then see `isRefreshing === false` and destroy the touch handler. Since `FeaturedInteractionHandler` was the only handler in the set, `unbindListeners` would also remove the `document.body` event listener entirely, making all subsequent mouse events invisible.

**Fix:** Detach the disconnect callback from the old demuxer before closing it, so its async `onclose` event cannot trigger `onDisconnected()`:

```typescript
public refreshStream(): void {
    // Detach old demuxer's disconnect callback before closing
    if (this.demuxer) {
        this.demuxer.onDisconnect(() => {});
    }
    this.demuxer?.close();
    // ... reconnect with new demuxer ...
    this.demuxer = new ScrcpyDemuxer(streamUrl);
    this.demuxer.onDisconnect(this.onDisconnected);
}
```

### 11.4 WebSocket Close Reason Exceeding 123-Byte Limit

**Problem:** When a device is offline, ADB error messages (e.g., `Command failed: adb -s 192.168.86.169:5555 push ...`) can exceed the 123-byte WebSocket close frame reason limit defined by RFC 6455. The `ws` library throws an unhandled `RangeError` that crashes the entire Node.js process. With Control Menu's auto-restart, this created a crash loop (3 crashes in 30 seconds, then give-up).

**Fix:** Truncate error messages to 123 bytes before passing to `ws.close()`, and wrap the close call in try/catch for defense in depth:

```typescript
try {
    if (ws.readyState === ws.OPEN) {
        ws.close(4005, err.message.slice(0, 123));
    }
} catch (closeErr) {
    console.error(TAG, `Failed to close WebSocket:`, closeErr);
}
```

Applied in both `ScrcpyConnection.ts` and `DeviceProbe.ts`.

### 11.5 Firefox H.264 isConfigSupported False Rejection

**Problem:** Firefox's `VideoDecoder.isConfigSupported()` returns `{ supported: false }` for the H.264 profile string `avc1.42E01E`, despite being fully capable of decoding H.264 content. This caused the auto-detection algorithm to skip H.264 and fall back to worse options on Firefox.

**Fix:** The `browserSupportsCodec()` function unconditionally returns `true` for H.264, bypassing the `isConfigSupported` check:

```typescript
async function browserSupportsCodec(codec: string): Promise<boolean> {
    if (codec === 'h264') return true;
    // ...
}
```

This is safe because H.264 baseline profile support is universal across all browsers that implement WebCodecs.

---

## 12. Release Checklist

Before building a new version of ws-scrcpy-web, check the following:

### Build-time dependencies (require recompile)

Run `npm outdated` to check all at once. Update one at a time, build + test after each.

| # | Package | Current | Purpose | Update notes |
|---|---------|---------|---------|--------------|
| 1 | `typescript` | 6.0.2 | Compiles TypeScript source to JavaScript | Major versions may need `tsconfig.json` changes |
| 2 | `webpack` | 5.106.2 | Bundles source into server and browser output | Patch updates are safe |
| 3 | `webpack-cli` | 7.0.2 | Command-line interface for webpack | Major versions usually just drop old Node support |
| 4 | `css-loader` | 7.1.4 | Processes CSS imports for webpack bundling | Major versions may need webpack config changes |
| 5 | `mini-css-extract-plugin` | 2.10.2 | Extracts CSS into separate .css files | Tied to webpack version |
| 6 | `ts-loader` | 9.5.7 | Lets webpack process TypeScript files | Must be compatible with TypeScript version |
| 7 | `ts-node` | 10.9.2 | Runs webpack config files written in TypeScript | Must be compatible with TypeScript version |
| 8 | `@biomejs/biome` | 2.4.12 | Linter and code formatter (replaces ESLint + Prettier) | Major versions need config migration (`npx @biomejs/biome migrate`) |
| 9 | `@types/node` | 24.12.2 | TypeScript type definitions for Node.js APIs | Must match target Node.js LTS major version (even numbers only, never odd) |
| 10 | `@types/ws` | 8.18.1 | TypeScript type definitions for ws library | Must match `ws` major version |
| 11 | `vitest` | 4.1.4 | Test runner for unit and integration tests | Usually safe to update |
| 12 | `@xterm/xterm` | 6.0.0 | Terminal emulator rendered in the browser (Microsoft) | Major versions may have API changes affecting `ShellClient.ts` and `ShellModal.ts` |
| 13 | `@xterm/addon-attach` | 0.12.0 | Connects xterm to a WebSocket for remote shell | Must match `@xterm/xterm` major version |
| 14 | `@xterm/addon-fit` | 0.11.0 | Auto-resizes terminal to fit its container | Must match `@xterm/xterm` major version |

### Runtime dependency bundled into build

| # | Package | Current | Purpose | Update notes |
|---|---------|---------|---------|--------------|
| 15 | `ws` | 8.20.0 | WebSocket server powering all browser-to-server communication | Bundled into webpack output; not user-updatable. Stable, rarely updates. Check before every release. |

### Runtime dependencies managed by in-app updater

These are not npm packages in the build -- they are external binaries bundled in the `dependencies/` folder and updatable by users through the app UI.

| # | Dependency | Current | Purpose | Update source | Update notes |
|---|------------|---------|---------|---------------|--------------|
| 16 | `node-pty` | 1.1.0 | Provides pseudo-terminal for ADB shell sessions in the browser | npm prebuilt binaries | Native DLL (conpty.dll + OpenConsole.exe) is ABI-locked to Node.js version. Must update together with Node.js. |
| 17 | Node.js | 24.14.1 LTS | JavaScript runtime that runs the ws-scrcpy-web server | nodejs.org | Paired with node-pty (#16). Only use LTS (even-numbered) releases. |
| 18 | ADB (platform-tools) | latest | Communicates with Android devices (push, shell, tunnel) | Google SDK | Standalone zip download and extract |
| 19 | scrcpy-server | 3.3.4 | Runs on Android device to capture screen, audio, and accept input | Genymobile/scrcpy releases | Single binary replace. Update `SERVER_VERSION` in `src/common/Constants.ts` to match. |

### Quick check

```bash
npm outdated
```

Shows all npm packages (1-15) with available updates. For runtime dependencies (16-19), check their respective release pages.

---

## 13. Dependency Updater

### 13.1 Architecture

The dependency updater manages runtime dependencies (Node.js + node-pty, ADB, scrcpy-server) through a browser UI on the home page. It allows users to check for updates and install them without leaving the browser.

**Components:**

| File | Responsibility |
|------|----------------|
| `src/common/DependencyTypes.ts` | Shared types (`DependencyInfo`, `DependencyStatus`, `UpdateResult`) and `compareVersions()` |
| `src/server/DependencyDefinitions.ts` | Declarative config for each dependency (version sources, download URLs, platform detection) |
| `src/server/DependencyManager.ts` | Core logic: version detection, remote checking, download, extract, install |
| `src/server/api/DependencyApi.ts` | HTTP REST endpoints under `/api/dependencies/` |
| `src/app/client/DependencyPanel.ts` | Browser-side table UI with status badges and update buttons |
| `start.cmd` / `start.sh` | Launcher scripts that handle restart after Node.js updates |

### 13.2 API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/dependencies` | List all dependencies with current status |
| POST | `/api/dependencies/check` | Check all dependencies for updates |
| POST | `/api/dependencies/:name/update` | Download and install update for named dependency |
| POST | `/api/dependencies/restart` | Restart the server (via launcher script) |

### 13.3 Restart Flow

Node.js cannot replace its own running binary on Windows. The solution uses an external launcher script:

1. User clicks "Update" for Node.js in the browser
2. Server downloads new Node.js, renames running `node.exe` to `node.exe.old`, copies new binary
3. Server writes `.restart` marker file and exits with code 0
4. Launcher script (`start.cmd` / `start.sh`) detects marker, deletes old binary, relaunches
5. Browser polls `/api/dependencies` until server responds, then reloads the page

On Linux, file locking is not an issue -- the binary can be overwritten directly. The launcher script still handles the restart loop for consistency.

### 13.4 Dependencies Folder Structure

```
ws-scrcpy-web/
  dependencies/
    node/       -- node.exe (Windows) or node (Linux) + node-pty native files
    adb/        -- ADB platform-tools (adb, fastboot, etc.)
  dist/
    assets/
      scrcpy-server   -- managed by webpack build, updatable via the UI
  start.cmd           -- Windows launcher
  start.sh            -- Linux launcher
```

### 13.5 Adding a New Managed Dependency

To add a new dependency to the updater:

1. Add a new `DependencyDefinition` entry in `src/server/DependencyDefinitions.ts` with:
   - `checkInstalled()` -- how to detect the installed version
   - `checkLatest()` -- how to check for the latest version online
   - `getDownloadUrl()` -- platform-aware download URL
2. Add an install handler in `DependencyManager.ts` for the new dependency
3. The UI and API automatically pick up new definitions -- no frontend changes needed

---

## 14. Home Page Architecture

The home page (`http://localhost:8000`) is a single-page view with three sections on one scrollable page. No navigation system -- everything is visible at a glance.

**Page layout:** All content is wrapped in a centered `.page-container` with `max-width: 1800px` (fits up to 5 device cards on 4K monitors). Page structure is created in `src/app/index.ts` in fixed order before `HostTracker.start()` to prevent race conditions across browsers.

**Theme toggle:** A sun/moon button in the top-right corner switches between dark (default) and light themes. Preference is saved to localStorage (`ws-scrcpy-web-theme`). Themes use `data-theme` attribute on `<html>` with CSS custom properties. Colors match the Control Menu project palette.

**Components:**
- `src/app/client/ThemeToggle.ts` -- theme initialization and toggle button
- `src/style/app.css` -- theme color variables (`[data-theme="dark"]` and `[data-theme="light"]`)

### 14.1 Connected Devices

Rendered by `DeviceTracker` via WebSocket updates from `ControlCenter`. The server polls `adb devices` every 5 seconds (`ControlCenter.POLL_INTERVAL`). Devices appear automatically when ADB detects them.

**Card layout:** CSS grid with `auto-fill` columns (minimum 340px). Active devices have a green left border accent; offline devices have red with reduced opacity. Tracker header shows "Connected Devices [hostname]".

**Card structure:** Each device card contains three sections separated by subtle divider lines:

1. **Info table** -- full-width table with aligned label column:
   - Model (smart dedup: skips manufacturer if model already starts with it)
   - Device ID (the ADB serial/IP:port)
   - Android version + action buttons (disconnect + sleep/wake, right-aligned via rowspan)
   - SDK version

2. **"opens in overlay" section** -- all action buttons in a single section. All modals use native `<dialog>` with `.showModal()` via the `Modal` base class (`src/app/ui/Modal.ts`):
   - `configure stream` -- codec/encoder selection modal (own line). Escape, backdrop click, and X all dismiss.
   - `shell` -- ADB shell terminal modal (xterm.js + node-pty). Escape and backdrop click blocked (both are valid terminal actions). X button shows "End the shell session?" confirmation when a session is active. Wider sizing (`clamp(500px, 90vw, 1600px)`) and taller (`min-height: 600px`). Red resize warning between header and terminal. Server supports `resize` message type for PTY dimension updates via `ResizeObserver`.
   - `list files` -- opens ListFilesModal: modern file browser inside a native `<dialog>`. Breadcrumb path navigation with clickable segments, sortable columns (name/size/date, dirs always first), selection with checkboxes and select-all, bulk operations in footer (upload/delete/download), single-file actions on hover (download/delete), drag-and-drop upload with progress rows, configurable icon sizes (16-32px via localStorage preference with picker on first open), 6 SVG file type icons (folder/file/image/video/audio/text), client-side filename filter, delete via `POST /api/devices/files/delete` REST endpoint with always-confirm. Uses two-level multiplexing: root mux → FSLS channel → command sub-channels (STAT/LIST/RECV). Escape, backdrop, and X all dismiss; confirm if transfers active. Header includes a size-picker button (via `Modal.addHeaderButton()`) alongside the theme toggle. Row layout: `[check][icon][name][actions][size][date]` — the actions column is a reserved-width container (`calc(var(--file-icon-size) * 2 + 20px)`) with `visibility: hidden`/`visible` children so size/date never shift on hover or between file rows (2 buttons) and folder rows (1 button). Action buttons are SVGs sized via `--file-icon-size`, matching the file-type icons. The column header is `position: sticky; top: 0` inside the scrollable `.list-files-body` (with a matching inner `.list-files-rows` container) so the header and rows share the same scroll viewport width — prevents column mis-alignment when a scrollbar appears.
   - `connect` -- opens ConnectModal: full stream experience (video + toolbar + audio + UHID + touch) inside a native `<dialog>`. Auto-detects best codec/encoder. Escape and backdrop blocked (UHID keyboard capture). X button disconnects. Home page stays visible behind dimmed backdrop. `StreamClientScrcpy` renders into the modal body via a `container` parameter instead of `document.body`. Two entry paths: "configure stream" → pick settings → "connect" opens ConnectModal; or "connect" directly with auto-detected settings.

**Action buttons:** The Android/SDK rows share a rowspan cell containing a flexbox wrapper with up to two buttons:

- **Disconnect** -- shown only for network-connected devices (serial contains `:`). Calls `POST /api/devices/disconnect`. On the next poll cycle (5s), `ControlCenter` detects the device is gone, broadcasts a disconnect state update via WebSocket, and removes the device from its maps. The client-side `BaseDeviceTracker.updateDescriptor()` splices disconnected devices from the descriptors array, and `buildDeviceTable()` re-renders without them -- the card disappears.
- **Sleep/Wake** -- shown for all devices. Displays "turn off" (red) when awake, "turn on" (green) when asleep, "checking..." (gray) while state is unknown. Clicking calls `POST /api/devices/sleep-wake` with the opposite action. State is tracked server-side and pushed to browsers via WebSocket -- see section 17.

Both buttons are built via DOM manipulation (not the `html` template tag) because the template's XSS protection escapes raw HTML strings.

**Interface auto-selection:** The interface dropdown was removed. The best connection path is selected automatically: WiFi interface (direct IP) is preferred, falls back to the first available interface, then to ADB proxy as a last resort.

**Removed legacy features:**
- Interface dropdown (replaced by auto-selection)
- Server PID button (was a no-op -- server lifecycle is managed by `ScrcpyConnection`)
- "WebCodecs" link label (renamed to "connect")
- "opens in new tab" section (all buttons unified into single "opens in overlay" section)

**Modal system:** All modals use native HTML `<dialog>` element with `.showModal()`, inheriting from the abstract `Modal` base class (`src/app/ui/Modal.ts`). This provides: top-layer rendering (no z-index conflicts), automatic focus trapping, built-in `::backdrop` for dimming, pointer event blocking on the underlying page (no manual scroll lock needed), and the `cancel` event for Escape key handling. Styling is in `src/style/modal.css` with glassmorphism effects and `@starting-style` CSS transitions for both open and close animations (pure CSS, no JS timing). Each modal controls its dismiss behavior via overridable hooks (`onEscapeKey`, `onBackdropClick`, `onCloseButtonClick`). Current modals: `ConfigureScrcpy` (settings, all dismiss vectors), `ConnectModal` (stream experience, escape/backdrop blocked), `ShellModal` (terminal, escape/backdrop blocked, close confirmation), `ListFilesModal` (file browser, all dismiss vectors, confirm if transfers active). **Header controls:** all headers expose a `.modal-header-controls` flexbox container (`gap: 40px`) holding a theme toggle button (sun/moon icon) and the close X — the page is inert behind `showModal()` and the main theme toggle is unreachable, so each modal gets its own. Subclasses can inject their own header buttons via `protected addHeaderButton(btn)` on the base class, which inserts at the **far left** of the controls so the theme toggle and X stay adjacent on the right for consistent UX across modals (used by ListFilesModal for its size-picker ⊞ button). The theme button reuses the home-page `.theme-toggle` style, but `modal.css` resets its `position: fixed; top: 12px; right: 12px; width/height/border-radius` so the button actually flows inside the header controls flex container instead of floating at the viewport corner. `StreamClientScrcpy.start()` accepts an optional `container` parameter — when provided, the stream renders into that container instead of `document.body`, and `setBodyClass('stream')` is skipped. ConnectModal passes `this.bodyEl` as the container. The `start()` method returns a `{ instance, stop }` object; ConnectModal stores the `stop` function and calls it in `onBeforeClose()`. Server disconnect triggers an `onDisconnect` callback that auto-closes the modal.

### 14.2 Available Network Devices

A two-channel discovery model: **mDNS** advertisement (modern devices) plus a **TCP port-5555 sweep** (older devices that don't advertise mDNS — e.g. pre-Android-11 tablets with wireless debugging enabled on a fixed port). A scan is driven from a configuration dialog rather than running as a one-shot action.

**User flow:**

1. Click **scan network** -> `ScanNetworkModal` opens.
2. Dialog shows the auto-detected gateway subnet plus any user-added subnets (restored from `localStorage`).
3. User can add subnets via `AddSubnetModal` (CIDR, bare IP, or IP range), edit an existing row via the **✎** icon (opens `AddSubnetModal` in edit mode with the current value pre-filled), or remove via **×**.
4. If the combined scan size exceeds 2,048 hosts, `LargeSubnetWarningModal` prompts for confirmation with a per-subnet breakdown.
5. Scan streams over a WebSocket; hits render as cards under "Available Network Devices" with an optional name input and Connect button.

A **manually add** button sits next to **scan network** and opens an inline form (IP / port / optional label) for the "I just need to add one specific address" case. Reuses `POST /api/devices/connect`.

#### 14.2.1 HTTP Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/devices/scan` | **Legacy.** Kept as a REST compatibility shim returning mDNS-only results with the pre-rewrite behavior. External consumers that pre-date `/ws-scan` still work. |
| GET | `/api/devices/scan/subnet` | Returns the auto-detected gateway subnet as `{ cidr, hostCount }`, or `null` if detection failed. Called by `ScanNetworkModal` on open. |
| POST | `/api/devices/connect` | JSON body `{ address, serial?, label? }`. On success, label is persisted keyed by both `ro.serialno` AND MAC (see 14.2.3). |
| POST | `/api/devices/disconnect` | JSON body `{ address }`. |
| GET | `/api/devices/labels` | All labels as `{ key: label }` where key is serial or MAC. |
| PUT | `/api/devices/labels` | `{ serial, label }`. Empty label deletes. |
| GET | `/api/devices/screen-state` | `?udid=ip:port` -> `{ awake }` via `dumpsys power > mWakefulness`. |
| POST | `/api/devices/sleep-wake` | `{ udid, action: 'sleep'|'wake' }` -> sends keyevent 223/224, re-checks after 500 ms. |

#### 14.2.2 Scan WebSocket (`/ws-scan`)

Path exported as `SCAN_WS_PATH` in `src/common/ScanMessage.ts`. All message shapes live in that file as well.

**Client -> server:**

| Type | Fields |
|---|---|
| `scan.start` | `subnets: string[]` (raw user-typed strings — server re-parses via `SubnetParser`) |
| `scan.cancel` | (none) |

**Server -> client:**

| Type | Fields |
|---|---|
| `scan.started` | `totalHosts, totalSubnets, startedAt` |
| `scan.progress` | `checked, total, foundSoFar` (emitted every `scanProgressInterval` checks) |
| `scan.hit` | `source: 'mdns' | 'tcp', address, serial, name, label` |
| `scan.draining` | (none) — fires after `scan.cancel` while in-flight probes wind down |
| `scan.complete` | `found` |
| `scan.cancelled` | `found` |
| `scan.error` | `reason, details?: [{ subnet, error }]` |

Lifecycle: `scan.started -> [progress | hit]* -> (complete | draining -> cancelled | error)`. Late-joining spectators receive a snapshot of current progress + hits on connection.

#### 14.2.3 Server-Side Components

| File | Purpose |
|---|---|
| `src/server/mw/ScanMw.ts` | WebSocket middleware. `ScanMw.attach(ws)` is registered at `SCAN_WS_PATH` in `src/server/index.ts`. Handles client messages, proxies to `NetworkScanner`, and removes its message handler on any close transition (clean or abnormal) to avoid listener leaks. |
| `src/server/network/NetworkScanner.ts` | Singleton orchestrator. State machine `idle -> scanning -> draining -> idle`. Bounded-concurrency probe pool sized by `scanConcurrency`. Cancel drains in-flight probes instead of killing them. Emits the full server message stream plus snapshot replay for mid-scan reconnects. |
| `src/server/network/AdbHandshakeProbe.ts` | Single-socket CNXN handshake probe: TCP connect -> write CNXN -> read reply header -> close. Replaced an earlier two-socket path (`adb connect` for liveness then `adb disconnect`) that older embedded adbd stacks (notably the SM-T550) silently dropped on the second connection. CNXN packet matches AOSP byte-for-byte: version `0x01000001`, `max_data` `0x00100000`, full `host::features=shell_v2,cmd,stat_v2,...` banner, byte-sum `data_check` (the field is misnamed `data_crc32` in the AOSP struct — historical). Successful replies (`CNXN` or `AUTH`) are logged as hits. |
| `src/server/network/SubnetDetector.ts` | Gateway subnet auto-detection with a three-level fallback: (1) parse `route print` (Windows) / `ip route` (Linux) for the default route, filtering Windows' synthetic `On-link` and `0.0.0.0` rows; (2) enumerate RFC1918 interfaces and pick the first usable; (3) return null. Exposed via `GET /api/devices/scan/subnet`. |
| `src/server/network/MacResolver.ts` | ARP-cache lookup after probe traffic primes the table: `arp -a <ip>` on Windows, `ip neigh show to <ip>` on Linux (2s command timeout). Returns a lowercase colon-normalized MAC or `null`. Stateless — each `resolveMac()` call spawns the OS command fresh. |
| `src/server/DeviceLabelStore.ts` | Label persistence (JSON file, in-memory cache). The store itself is a single-key map — the **dual-key storage** is a call-site pattern in `DeviceDiscoveryApi.connect()`: on a successful network connect, the label is written under *both* the device's real serial (`getprop ro.serialno`) and its MAC (resolved via `MacResolver`). Scanner hit lookup then does `labelFor(mac) ?? labelFor(serial)` — MAC-first catches TCP hits (where serial isn't known until after a follow-up connect), serial-fallback catches mDNS hits. |
| `src/server/api/DeviceDiscoveryApi.ts` | HTTP endpoint handler (scan, scan/subnet, connect, disconnect, labels, screen-state, sleep-wake). |
| `src/server/AdbClient.ts` | `mdnsServices()`, `connect()`, `disconnect()`, plus `parseMdnsOutput()` and `parseSerialFromMdnsName()` parsers. mDNS display name normalizes to `adb-{parsedSerial}` format across `_adb._tcp` and `_adb-tls-connect._tcp` service types. |
| `src/common/SubnetParser.ts` | Input parser used in both client (live validation) and server (re-parse on `scan.start`). Accepts CIDR (`192.168.1.0/24`, prefix `/16` to `/32`), bare IP (treated as `/32`), long-form range (`192.168.1.10-192.168.1.50`), and shorthand range (`192.168.1.10-50`). Range cap: 65,536 literal addresses. When a range aligns to a subnet boundary (first IP ends in `.0` and/or last IP ends in `.255`), the host generator skips those network/broadcast addresses, matching CIDR expansion exactly — so `10.0.0.0-10.0.255.255` yields 65,534 scannable hosts, identical to `10.0.0.0/16`. |
| `src/common/ScanMessage.ts` | Shared message types + `SCAN_WS_PATH` constant. |

#### 14.2.4 Client-Side Components

| File | Purpose |
|---|---|
| `src/app/client/NetworkDiscoveryPanel.ts` | Panel header (scan / manually add buttons), the manual-add inline form, and the results grid. Owns `.discovery-info` — the empty-state card below the grid. On scan start, the default info text is swapped out and `ScanProgressChip` mounts there; on chip dismiss, the default text is restored (guards against overwriting an error message that may already be in place). |
| `src/app/client/ScanNetworkModal.ts` | Primary configuration dialog. Lists the gateway subnet and any user-added subnets, each with a host count and annotation. User subnets carry a stable monotonic ID so the **✎ edit** path can target by ID rather than index (which can drift on edit). Pencil opens `AddSubnetModal` in edit mode with `initialValue` pre-filled; × removes. Start-scan button is disabled when total host count is zero, fires `LargeSubnetWarningModal` when > 2,048, otherwise hands off to `NetworkDiscoveryPanel.startScanWs()`. Subnet list persisted to `localStorage` under key `ws-scrcpy-web:scan-subnets`. |
| `src/app/client/AddSubnetModal.ts` | Add-or-edit dialog. Accepts `{ onSubmit, mode?: 'add' \| 'edit', initialValue?: string }`. Edit mode re-titles to "Edit Subnet", switches the button to "save", pre-fills the input, and re-runs validation so a valid pre-filled value leaves save enabled immediately. Live validation via `parseSubnetInput`; error messages embed a clickable link to the subnet cheat sheet when relevant. |
| `src/app/client/LargeSubnetWarningModal.ts` | Fires when combined scan size > 2,048 hosts. Shows total host count + per-subnet breakdown, user confirms or cancels. Nested-modal readability handled by a CSS `:has()` rule in `src/style/modal.css` that makes the topmost stacked dialog use a fully opaque frame (instead of compounding the glassmorphism of both layers). |
| `src/app/client/ScanProgressChip.ts` | Lifecycle chip with four states: `scanning`, `draining`, `complete`, `cancelled`. Full-width inside its slot with `min-height: 32px` so all three label states occupy the same footprint regardless of which child button (cancel / × / none) is visible. `setScanning` is a no-op after the chip leaves `scanning` state — prevents stale `scan.progress` messages arriving during drain from resurrecting the scanning label. Drain label holds for a minimum 1200 ms before transitioning to `cancelled` (the real drain can complete in ~300 ms, which is too fast to read). Auto-dismisses 5 s after `complete` / 10 s after `cancelled`, via the `onDismiss?` callback restoring the panel's default info text. |
| `public/help/subnets.html` | Subnet/CIDR cheat sheet. Opens in a new tab from `ScanNetworkModal` (the "New to CIDR?" link) and from `AddSubnetModal` validation-error messages. Back-link uses `window.close()` so the tab actually closes instead of navigating the new tab back to the app (which would accumulate stale tabs on repeat cheat-sheet visits). |

#### 14.2.5 Config Tuning Knobs

Defaults in `src/server/Config.ts`, overridable via env var or `config.json` keys:

| Key (config.json) | Env var | Default | Purpose |
|---|---|---|---|
| `scanConcurrency` | `SCAN_CONCURRENCY` | 64 | Max in-flight TCP connects in the probe pool. |
| `scanTcpTimeoutMs` | `SCAN_TCP_TIMEOUT_MS` | 300 | Per-host TCP connect timeout. |
| `scanAdbConnectTimeoutMs` | `SCAN_ADB_CONNECT_TIMEOUT_MS` | 5000 | CNXN handshake reply timeout — needs headroom for slow embedded adbd stacks. |
| `scanProgressInterval` | `SCAN_PROGRESS_INTERVAL` | 10 | Hosts checked per `scan.progress` emission. Lower = more frequent UI updates, higher = less WS chatter. |

#### 14.2.6 Diagnostic Scripts

Useful when touching the probe path — kept in-tree for ADB-protocol debugging.

| Script | Purpose |
|---|---|
| `scripts/dump-cnxn.js` | Prints the CNXN packet we send in hex, for byte-level comparison against a real adb capture. |
| `scripts/test-probe-single.js <host> [port]` | Fires one single-socket CNXN probe and reports the reply (`CNXN` / `AUTH` / timeout) plus round-trip time. Cheapest reproduction tool for older-Android regressions. |

**Requirement:** Devices must have wireless debugging (Settings -> Developer options) enabled and be on the same local network. mDNS discovery works on standard home networks; TCP port-5555 sweep works even on networks where mDNS is blocked or the device doesn't advertise.

### 14.3 Dependencies

The dependency updater panel (section 13) shows installed vs. latest versions for Node.js + node-pty, ADB, and scrcpy-server with update controls. See section 13 for full details.

---

## 15. Logging

All server-side logging goes through `src/server/Logger.ts`, a lightweight utility that tees output to both the console and a persistent log file.

### 15.1 Usage

```typescript
import { Logger } from './Logger';
const log = Logger.for('MyModule');

log.info('Server started on port', port);   // stdout + file
log.error('Connection failed:', err.message); // stderr + file
```

`Logger.for(tag)` returns a tagged logger instance. The tag is automatically wrapped in brackets for consistent formatting.

### 15.2 Log File

| Property | Value |
|----------|-------|
| **Location** | `ws-scrcpy-web.log` in the project root (next to `start.cmd`) |
| **Format** | `{ISO 8601 timestamp} [{tag}] {message}` for info, `{ISO 8601 timestamp} [{tag}] ERROR {message}` for errors |
| **Writes** | Synchronous (`fs.appendFileSync`) so crash output is never lost in a buffer |
| **Rotation** | On startup, if the log file exceeds 5MB it is renamed to `ws-scrcpy-web.log.1` (one backup kept) |

Example output:

```
2026-04-16T05:53:28.179Z [Server] Listening on:
	http://htpc:8000/ http://localhost:8000/
2026-04-16T05:53:28.181Z [Server] 	http://192.168.86.3:8000/ http://127.0.0.1:8000/
2026-04-16T06:01:12.445Z [ScrcpyConnection] Starting session for 192.168.86.43:5555 (scid=1a2b3c4d)
2026-04-16T06:01:14.102Z [ScrcpyConnection] Session ready: Google TV Streamer 1920x1080
```

### 15.3 Modules Using Logger

All 12 server-side files use the Logger. No raw `console.log` or `console.error` calls exist outside of `Logger.ts` itself.

| Module | Tag | Typical messages |
|--------|-----|-----------------|
| `index.ts` | `Server` | Startup, shutdown, signal handling |
| `ScrcpyConnection.ts` | `ScrcpyConnection` | Session lifecycle (start, ready, release, exit) |
| `DeviceProbe.ts` | `DeviceProbe` | Encoder/display probing |
| `Utils.ts` | `Server` | Network interface listing |
| `WebSocketServer.ts` | `WebSocket Server {tcp:PORT}` | WS server stop |
| `WebsocketMultiplexer.ts` | `WebsocketMultiplexer` | Service init failures |
| `ControlCenter.ts` | `ControlCenter` | Device list errors, init failures |
| `Device.ts` | Per-device tag | Max update attempts reached |
| `DeviceTracker.ts` | `DeviceTracker` | Command parse errors |
| `RemoteShell.ts` | `RemoteShell` | Shell message parse errors |
| `FileListing.ts` | `FileListing` | Invalid messages, wrong commands |
| `FilePushReader.ts` | `FilePushReader` | Push errors |

### 15.4 Adding Logging to New Code

When adding a new server-side module:

1. Import the Logger: `import { Logger } from './Logger';` (adjust relative path)
2. Create a module-level logger: `const log = Logger.for('ModuleName');`
3. Use `log.info()` for normal flow and `log.error()` for failures
4. For classes with instance-specific tags (like `Device.ts`), call `Logger.for(this.TAG)` where needed

### 15.5 Crash Handlers

`src/server/index.ts` registers `uncaughtException` and `unhandledRejection` handlers that log to file before the process exits. These catch errors that bypass the Logger (e.g., unguarded `ws.send()` on a closed socket). Look for `Uncaught exception:` or `Unhandled rejection:` in the log file.

---

## 16. Device Labels

User-assigned names for devices that persist across sessions, disconnects, and restarts.

### 16.1 Data Storage

Labels are stored in `device-labels.json` in the project root, keyed by either hardware serial (`ro.serialno`) or MAC address. On a successful network connect, the label is written under BOTH keys when available — serial via `adb -s <addr> shell getprop ro.serialno`, MAC via `MacResolver` from the system ARP cache. A file may therefore mix key types:

```json
{
  "49241HFAG07SUG": "Living Room TV",
  "47121FDAQ000WC": "Jamie's Pixel 9",
  "aa:bb:cc:dd:ee:ff": "Living Room TV"
}
```

The scanner's hit-lookup order is `labelFor(mac) ?? labelFor(serial) ?? ''` — MAC-first catches TCP hits (where the serial isn't known until after a follow-up `adb connect`), serial-fallback catches mDNS hits (where the serial is authoritatively in the service name). See 14.2.3 for the dual-key write site in `DeviceDiscoveryApi.connect()`.

**`DeviceLabelStore`** (`src/server/DeviceLabelStore.ts`):
- Singleton with `getInstance()` / `resetInstance()`
- `get(key)`, `set(key, label)`, `delete(key)`, `getAll()` — key is just a string; the dual-key semantics live in the caller.
- Reads file on first access, caches in memory, sync writes on every change
- File path resolves from `__dirname` (dist/) + `..` to project root (same pattern as Logger)

### 16.2 Device Identification

**Hardware serial** (`ro.serialno`) is the stable identifier. It never changes across reboots, IP changes, or reconnects.

**Connected devices:** `ro.serialno` is fetched via `getprop` as part of the normal property polling cycle. Added to the `Properties` array in `src/server/goog-device/Properties.ts` and the `GoogDeviceDescriptor` type. Flows to the browser automatically via the WebSocket device update pipeline.

**Scan results (mDNS):** Serial is parsed from the mDNS service name using `parseSerialFromMdnsName()` in `src/server/AdbClient.ts`:
- `adb-49241HFAG07SUG` (plain `_adb._tcp`) -> `49241HFAG07SUG`
- `adb-47121FDAQ000WC-7vmR8a` (`_adb-tls-connect._tcp`) -> `47121FDAQ000WC` (TLS instance suffix stripped)

**Scan results (TCP port-5555 sweep):** The single-socket CNXN probe in `AdbHandshakeProbe` identifies liveness but does not expose the real serial. On a TCP hit the scanner emits `scan.hit` with `serial = address` (the ip:port used as a placeholder identifier) — MAC is resolved via `MacResolver` from the system ARP cache and threaded through the label lookup as the primary key. Real `ro.serialno` is only fetched later when the user clicks **Connect** on the card: `DeviceDiscoveryApi.connect()` runs `adb connect <address>` then `adb -s <address> shell getprop ro.serialno`, and at that point the label is (re)written under both the real serial and the MAC per the dual-key scheme in 14.2.3. For render-time label display, TCP hits therefore rely on the MAC-keyed lookup path.

### 16.3 Connected Device Cards

Each device card has a "Device Name:" row as the first table row:

| Device Name: | Living Room TV &emsp;&emsp; [pencil icon] |
|---|---|
| Model: | Google TV Streamer |

- **Labeled devices:** Name shown in bold (15px, weight 600)
- **Unlabeled devices:** "Unnamed Device" shown in italic, dimmed (opacity 0.5)
- **Pencil icon:** Always visible, right-aligned in the cell. Clicking it enters edit mode.
- **Edit mode:** Text input replaces the label span, pencil becomes a checkmark. Enter or checkmark saves (PUT `/api/devices/labels`). Escape cancels. The label lookup uses `ro.serialno` from the device descriptor.

Built via DOM manipulation in `DeviceTracker.buildLabelCell()` because the `html` template tag XSS-escapes values and cannot host interactive elements.

### 16.4 Network Scan Cards

Each scan result card includes an optional "Name this device..." text input. If a name is entered before clicking Connect, it is sent with the connect request and saved server-side. If the device was previously named, the input is pre-filled.

### 16.5 Components

| File | Purpose |
|------|---------|
| `src/server/DeviceLabelStore.ts` | Label persistence (JSON file, singleton) |
| `src/server/AdbClient.ts` | `parseSerialFromMdnsName()` helper |
| `src/server/api/DeviceDiscoveryApi.ts` | REST endpoints for labels |
| `src/app/googDevice/client/DeviceTracker.ts` | `buildLabelCell()` -- inline edit UI |
| `src/app/client/NetworkDiscoveryPanel.ts` | Optional name input on scan cards |
| `src/style/devicelist.css` | Label row, pencil icon, edit input styles |
| `src/style/home.css` | Discovery card actions layout |

---

## 17. Sleep/Wake Toggle

Device cards show a sleep/wake button that reflects the current screen state and lets users turn devices on or off.

### 17.1 Architecture

Screen state is polled **server-side** and pushed to browsers via the existing WebSocket device update channel. This ensures the cost scales with device count only, not with the number of open browser tabs.

```
ControlCenter.pollDevices() [every 5s]
  └─ for each connected device (concurrent):
       Device.checkScreenState()
         └─ adb shell "dumpsys power 2>/dev/null | grep mWakefulness"
         └─ if state changed → update descriptor → emit('update') → WebSocket push

Browser (DeviceTracker)
  └─ receives descriptor with screen.state field
  └─ buildDeviceRow() renders button based on descriptor['screen.state']
```

The browser **never polls**. State flows passively via WebSocket, so an unfocused tab costs nothing.

### 17.2 State Detection

**ADB command:** `dumpsys power 2>/dev/null | grep mWakefulness`

The `2>/dev/null` suppresses "Broken pipe" stderr noise that occurs when grep exits before dumpsys finishes writing.

**State mapping:**
| `mWakefulness` value | `screen.state` | Button label | Button color |
|----------------------|-----------------|-------------|--------------|
| `Awake` | `awake` | "turn off" | Red (#f06c75) |
| `Asleep` | `asleep` | "turn on" | Green (#4ade80) |
| `Dozing` | `asleep` | "turn on" | Green (#4ade80) |
| (unknown/error) | `unknown` | "checking..." | Gray, disabled |

Dozing is the screensaver/ambient mode -- functionally asleep from the user's perspective.

### 17.3 Toggle Mechanism

Clicking the button calls `POST /api/devices/sleep-wake` with `{ udid, action: "sleep"|"wake" }`.

| Action | ADB keyevent | Android constant |
|--------|-------------|-----------------|
| sleep | `input keyevent 223` | KEYCODE_SLEEP |
| wake | `input keyevent 224` | KEYCODE_WAKEUP |

These are explicit sleep/wake events (not KEYCODE_POWER which is a toggle). The endpoint waits 500ms for the device to respond, then re-checks state and returns `{ awake: boolean }`. The button updates immediately from the API response; the server-side poll confirms and broadcasts the state on the next 5s cycle.

### 17.4 Performance

Benchmarks on Google TV Streamer 4K (hardwired Ethernet):
- `dumpsys power | grep mWakefulness`: ~240ms average (234-281ms over 5 runs)
- `dumpsys power` reads in-memory PowerManagerService state -- no disk I/O on the device
- At 5s intervals with concurrent `Promise.all`, even 500 devices adds ~240ms wall time per poll cycle

### 17.5 Descriptor Field

`GoogDeviceDescriptor['screen.state']` -- added as `'awake' | 'asleep' | 'unknown'`. Initialized to `'unknown'` when a device first connects. The first poll cycle (within 5s) resolves it to a real state.

### 17.6 Components

| File | Purpose |
|------|---------|
| `src/types/GoogDeviceDescriptor.d.ts` | `screen.state` field definition |
| `src/server/goog-device/Device.ts` | `checkScreenState()` -- ADB query, change detection, emit |
| `src/server/goog-device/services/ControlCenter.ts` | Concurrent screen state polling in `pollDevices()` |
| `src/server/api/DeviceDiscoveryApi.ts` | `screen-state` GET and `sleep-wake` POST endpoints |
| `src/app/googDevice/client/DeviceTracker.ts` | Button rendering from descriptor state, click handler |
| `src/style/devicelist.css` | Button styles (`.sleep-wake-btn`, `.state-on`, `.state-off`, `.state-unknown`) |
