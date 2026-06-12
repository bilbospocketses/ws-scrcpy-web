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
18. [node-pty Prebuilt Resolution](#18-node-pty-prebuilt-resolution)
19. [Service Mode Architecture](#19-service-mode-architecture)
20. [Launcher Architecture](#20-launcher-architecture)
21. [Tray Helper](#21-tray-helper)
22. [In-App Updater (Velopack)](#22-in-app-updater-velopack)
23. [First-Run Modal Gating](#23-first-run-modal-gating)

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

`DeviceProbeClient` opens a one-shot WebSocket to the server. `DeviceProbe` (server middleware) runs three ADB shell commands in parallel, parses the output for encoder names (matching patterns like `.avc.`, `.hevc.`, `.av1.`), screen dimensions, density, and `sdkInt` (the device's Android SDK version from `ro.build.version.sdk`), then sends a `ProbeResult` JSON and closes. The `sdkInt` field enables downstream consumers (e.g. Control Menu) to gate audio settings by SDK version without issuing a redundant `adb shell getprop` call.

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

In production (MSI/AppImage), the Rust launcher (`ws-scrcpy-web-launcher.exe`) spawns Node as a supervised child process: `node dist/index.js`. The launcher handles restarts (exit code 75 or `.restart` marker), tray supervision, UAC elevation, and the operation-server for service transitions. See sections 20-21 for details. In dev mode, `npm start` runs `node dist/index.js` directly.

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
| `DEPS_PATH` | see below | Absolute path to the dep-manager's writable folder. Resolution priority: env → `config.json` `dependenciesPath` → `<dataRoot>/dependencies/` on Windows (where `<dataRoot>` defaults to `%PROGRAMDATA%\WsScrcpyWeb\`) or `<entryDir>/../dependencies/` on Linux. Production deployments (Velopack, Docker) must set it explicitly. Dev mode on Windows resolves automatically via `<dataRoot>`; on Linux, place the repo such that `<entry>/../dependencies` is writable. Hard-fail with instructive startup error if unset and the platform fallback is unavailable. |

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
| 3 | `webpack-cli` | 7.0.3 | Command-line interface for webpack | Major versions usually just drop old Node support |
| 4 | `css-loader` | 7.1.4 | Processes CSS imports for webpack bundling | Major versions may need webpack config changes |
| 5 | `mini-css-extract-plugin` | 2.10.2 | Extracts CSS into separate .css files | Tied to webpack version |
| 6 | `ts-loader` | 9.6.0 | Lets webpack process TypeScript files | Must be compatible with TypeScript version |
| 7 | `ts-node` | 10.9.2 | Runs webpack config files written in TypeScript | Must be compatible with TypeScript version |
| 8 | `@biomejs/biome` | 2.4.16 | Linter and code formatter (replaces ESLint + Prettier) | Major versions need config migration (`npx @biomejs/biome migrate`) |
| 9 | `@types/node` | 24.12.2 | TypeScript type definitions for Node.js APIs | Must match target Node.js LTS major version (even numbers only, never odd) |
| 10 | `@types/ws` | 8.18.1 | TypeScript type definitions for ws library | Must match `ws` major version |
| 11 | `vitest` | 4.1.8 | Test runner for unit and integration tests | Usually safe to update |
| 12 | `@xterm/xterm` | 6.0.0 | Terminal emulator rendered in the browser (Microsoft) | Major versions may have API changes affecting `ShellClient.ts` and `ShellModal.ts` |
| 13 | `@xterm/addon-attach` | 0.12.0 | Connects xterm to a WebSocket for remote shell | Must match `@xterm/xterm` major version |
| 14 | `@xterm/addon-fit` | 0.11.0 | Auto-resizes terminal to fit its container | Must match `@xterm/xterm` major version |

### Runtime dependency bundled into build

| # | Package | Current | Purpose | Update notes |
|---|---------|---------|---------|--------------|
| 15 | `ws` | 8.21.0 | WebSocket server powering all browser-to-server communication | Bundled into webpack output; not user-updatable. Stable, rarely updates. Check before every release. |

### Runtime dependencies managed by in-app updater

These are not npm packages in the build -- they are external binaries bundled in the `dependencies/` folder and updatable by users through the app UI.

| # | Dependency | Current | Purpose | Update source | Update notes |
|---|------------|---------|---------|---------------|--------------|
| 16 | `node-pty` | 1.1.0 | Provides pseudo-terminal for ADB shell sessions in the browser | npm prebuilt binaries | Native DLL (conpty.dll + OpenConsole.exe) is ABI-locked to Node.js version. Must update together with Node.js. |
| 17 | Node.js | 24.14.1 LTS | JavaScript runtime that runs the ws-scrcpy-web server | nodejs.org | Paired with node-pty (#16). Only use LTS (even-numbered) releases. |
| 18 | ADB (platform-tools) | latest | Communicates with Android devices (push, shell, tunnel) | Google SDK | Standalone zip download and extract |
| 19 | scrcpy-server | 3.3.4 (bundled seed) | Runs on Android device to capture screen, audio, and accept input | Genymobile/scrcpy releases | Single binary replace via the in-app dep panel — installed version is tracked at `<deps>/scrcpy-server/.version` and read by `src/server/scrcpyServerVersion.ts`; both the UI display and the wire-protocol arg passed to `app_process` resolve from the marker. `SERVER_VERSION` in `src/common/Constants.ts` is the fallback for legacy seed installs predating the marker — bump it only when bumping the bundled seed binary, not on every user-facing scrcpy release. |

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
| `src/server/DependencyManager.ts` | Core logic: version detection, remote checking, download, extract, install, `autoInstallMissing()` first-run bootstrap primitive, never-auto-downgrade in `resolveStatus` |
| `src/server/api/DependencyApi.ts` | HTTP REST endpoints under `/api/dependencies/` |
| `src/app/client/DependencyPanel.ts` | Browser-side table UI with status badges and update buttons |
| `src/app/client/FirstRunBanner.ts` | Home-page banner shown when any managed dep is in `Error` state or `Unknown` with null `installedVersion`. Offers a Retry button for offline-at-first-boot recovery. |
| `start.cmd` / `start.sh` | Launcher scripts. Handle restart after Node.js updates (via `.restart` marker at `$DEPS_PATH/.restart` and/or exit code 75). Probe `dependencies/node/` first, fall back to `seed/node/` (Velopack-bundled location) before hard-failing. |

### 13.2 API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/dependencies` | List all dependencies with current status |
| POST | `/api/dependencies/check` | Check all dependencies for updates |
| POST | `/api/dependencies/:name/update` | Download and install update for named dependency |
| POST | `/api/dependencies/restart` | Restart the server (via launcher script) |
| POST | `/api/dependencies/retry-install` | Re-run `checkAll` + `autoInstallMissing`; returns `{ success, installed, stillMissing, errors }`. Used by `FirstRunBanner`'s Retry button. Always responds 200 regardless of `success` value — client reads banner state by re-fetching `/api/dependencies`. |

### 13.3 Restart Flow

Node.js cannot replace its own running binary on Windows. The solution uses an external supervisor:

1. User clicks "Update" for Node.js in the browser
2. Server downloads new Node.js, renames running `node.exe` to `node.exe.old`, copies new binary
3. Server writes `.restart` marker at `<depsPath>/.restart` **and** exits with code `75` (the belt-and-suspenders primitive — consumers pick whichever signal fits their supervisor shape)
4. The Rust launcher (production) or launcher script (dev mode) detects either the marker OR exit code `75`, deletes old binary, relaunches
5. Browser polls `/api/dependencies` until server responds, then reloads the page

In production, the Rust launcher's supervisor loop (section 20) handles the restart. The launcher monitors the Node child's exit code and the `.restart` marker, then respawns Node automatically. In dev mode, the `start.cmd` / `start.sh` scripts provide the same loop.

On Linux, file locking is not an issue — the binary can be overwritten directly. The launcher/script still handles the restart loop for consistency.

**Supervisor integration:** the exit-75 convention means the Rust launcher, Docker `restart: on-failure`, or a systemd unit with `RestartForceExitStatus=75` can all restart the server without needing to read the marker file.

### 13.3.1 First-Run Bootstrap

Fresh Velopack installs arrive with `dependencies/` empty. SP2b adds an auto-install primitive that fills it in on first boot:

1. Launcher probe chain finds Node: `dependencies/node/` first, `seed/node/` (Velopack-bundled) fallback.
2. Server boots and runs the standard `checkAll()` — populates `installedVersion` + `latestVersion` for every dep.
3. `DependencyManager.autoInstallMissing()` runs right after: walks dep state, calls `update(name)` for any dep with `installedVersion === null && latestVersion !== null`. Sequential (no network-saturation storm). Idempotent. Offline-tolerant (skips deps whose latest check failed — the banner path handles those).
4. If any dep is still in `Error` or `Unknown+null-installed` after the sweep, `FirstRunBanner` renders on the home page with a Retry button. Click → `POST /api/dependencies/retry-install` → re-runs checkAll + autoInstallMissing → banner re-polls state and hides on success.

In practice, Node ships via Velopack seed (never null), scrcpy-server seed-promotes from `<install>/current/seed/scrcpy-server/` to `<deps>/scrcpy-server/scrcpy-server` on first run (idempotent — falls back to network download from Genymobile if the seed is absent), and ADB is the only dep that always downloads on first run.

> **v0.1.10 architectural correction:** pre-v0.1.10, `scrcpy-server` was bundled into `dist/assets/scrcpy-server` via a webpack `import` and `checkInstalled` returned `SERVER_VERSION` unconditionally. The dep updater wrote to `<deps>/scrcpy-server/` but no runtime code read from there — it was a load-bearing-but-invisible bug. v0.1.10 makes the runtime path the source of truth: `DeviceProbe.serverFile()` and `ScrcpyConnection.serverFile()` resolve via `Config.dependenciesPath`, `checkInstalled` does an `fs.existsSync` against that path, and `DependencyManager.promoteSeedScrcpyServer()` covers offline first-run installs by copying the seed in from the Velopack image (anchored at `__dirname` to handle the `<base>/current/` layout).

### 13.3.2 Option D — Node version gating against node-pty prebuilts

`nodejs.checkLatest()` filters candidate Node LTS releases by whether our node-pty prebuilt manifest (published by SP1/SP1b at GH Releases, cached at `dependencies/node-pty/manifest.json`) has coverage for the major's ABI. Mechanics:

- `NODE_LTS_ABI: Record<number, string>` maps Node major → `process.versions.modules` ABI string. Hardcoded table in `DependencyDefinitions.ts` (20 → 115, 22 → 127, 24 → 137). Add new majors as the prebuilt matrix ships them.
- For each LTS release from `nodejs.org/dist/index.json`, look up its major's ABI. If that ABI is in `Manifest.coveredAbis`, keep it. Else drop it.
- Return the newest surviving candidate.
- If `loadManifest()` returns null (first-run corner case), fall back to unfiltered newest LTS with a WARN.

**Never-auto-downgrade:** if `compareVersions(installedVersion, filteredLatest) > 0` (a user on a Node major that fell out of the matrix), `resolveStatus` keeps status `UpToDate` with an INFO log — we never suggest an "update" that would go backward.

### 13.4 Dependencies Folder Structure

```
ws-scrcpy-web/                           -- installFolder (depsPath parent)
  dependencies/                          -- survives Velopack app updates
    node/                                -- node.exe / node (dep-manager writes here)
    adb/                                 -- ADB platform-tools (adb, fastboot, etc.)
    node-pty/                            -- SP1b two-source resolver cache
      manifest.json                      -- latest prebuilt coverage
      v{version}/{platform}-{arch}[-{libc}]/pty.node
    .restart                             -- transient marker (server → launcher)
  seed/                                  -- Velopack-shipped Node fallback (SP3)
    node/                                -- probed only when dependencies/node/ is empty
  dist/
    assets/
      scrcpy-server                      -- bundled by webpack, updatable via the UI
    index.js                             -- server entry
  start.cmd                              -- Windows launcher
  start.sh                               -- Linux launcher
```

**Key invariants:**
- `dependencies/` is the dep-manager's canonical writable location. It survives Velopack app updates.
- `seed/` is shipped by the Velopack installer as a fallback Node (read-only from the app's perspective, refreshed on every Velopack app update).
- Dev mode running `node dist/index.js` from the repo resolves dependencies the same way an MSI install does — via `<dataRoot>/dependencies/` on Windows (where `<dataRoot>` defaults to `%PROGRAMDATA%\WsScrcpyWeb\`), via `<entryDir>/../dependencies/` on Linux. The launcher's `paths.rs::compute` and the server's `resolveDependenciesPath` produce the same result on Windows; tests in `config.depsPath.test.ts` lock that contract.

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

**Design tokens (both themes):** New work on the home page should reach for these named variables rather than hardcoding hex values. Each is defined in both theme blocks in `app.css` so switching themes Just Works. Dark-mode values are in parentheses after light-mode.

| Token | Purpose | Light | Dark |
|---|---|---|---|
| `--text-color` | Primary text / headings | `#212529` | `#e0e0e0` |
| `--text-color-light` | Secondary / helper / placeholder text | `#495057` | `#a8a8a8` |
| `--section-border-color` | Outer frame around home-page sections | `#8f959d` | `#5a5a5a` |
| `--device-border-color` | Inner card outlines, input borders | `#c0c6cc` | `#444444` |
| `--button-border-color` | Default button border (neutral) | `#c0c6cc` | `#444444` |
| `--success-color` | Outlined green actions + badges | `#15803d` | `#4ade80` |
| `--success-hover-bg` | Hover fill for outlined green | `rgba(21, 128, 61, 0.1)` | `rgba(74, 222, 128, 0.1)` |
| `--danger-color` | Outlined red actions + badges | `#b91c1c` | `#f06c75` |
| `--danger-hover-bg` | Hover fill for outlined red | `rgba(185, 28, 28, 0.1)` | `rgba(240, 108, 117, 0.1)` |
| `--warning-color` | Outlined amber badges (`.dep-warn`) | `#b45309` | `#fbbf24` |
| `--info-color` | Outlined blue badges (`.dep-info`) | `#0969da` | `#60a5fa` |

All action-button pairs on the home page (`.discovery-connect-btn` + `.discovery-dismiss-btn`; `.sleep-wake-btn.state-off` + `.state-on`; `.disconnect-btn`) use the outlined treatment — transparent bg, colored border + text — and pull their colors from `--success-color` / `--danger-color` so light mode gets legible contrast automatically. The status pills in the Dependencies section (`.dep-ok` / `.dep-warn` / `.dep-info` / `.dep-error` / `.dep-unknown`) use the same pattern, with the shared `.dep-badge` rule declaring `border: 0.5px solid currentColor; background: transparent;` — each status only needs to set its text color, and the border matches automatically via `currentColor`.

The subnet cheat sheet (`public/help/subnets.html`) is a standalone HTML page served from `/help/subnets.html`. It defines its own local `--bg` / `--panel` / `--text` / `--muted` / `--accent` / `--border` variables keyed on `[data-theme="dark"]` / `[data-theme="light"]`, and runs a small inline script at the top of `<head>` that reads `ws-scrcpy-web-theme` from localStorage and applies `data-theme` before the first paint so the cheat sheet matches whatever theme the user left the app on — no flash.

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
| `src/server/network/AdbHandshakeProbe.ts` | Single-socket CNXN handshake probe: TCP connect -> write CNXN -> read reply header -> close. Replaced an earlier two-socket path (`adb connect` for liveness then `adb disconnect`) that older embedded adbd stacks (notably the SM-T550) silently dropped on the second connection. CNXN packet matches AOSP byte-for-byte: version `0x01000001`, `max_data` `0x00100000`, full `host::features=shell_v2,cmd,stat_v2,...` banner, byte-sum `data_check` (the field is misnamed `data_crc32` in the AOSP struct — historical). Successful replies (`CNXN` or `AUTH`) are logged as hits. **Close behavior:** confirmed-ADB hits are shut down with `socket.end()` (FIN) plus a 250 ms safety-net `destroy()`, so adbd sees a clean teardown; closed-port and timeout paths call `destroy()` immediately to stay fast. The RST-on-probe behavior it replaced caused intermittent `adb connect` failures right after a scan — embedded adbd treated the abort as an in-progress session and refused new connections for its cleanup window. |
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
| `src/app/client/NetworkDiscoveryPanel.ts` | Panel header (scan / manually add buttons), the manual-add inline form, and the results grid. Owns `.discovery-info` — the empty-state card below the grid. On scan start, the default info text is swapped out and `ScanProgressChip` mounts there; on chip dismiss, the default text is restored (guards against overwriting an error message that may already be in place). Scan-card `Connect` failures render the server's `result.message` inline via `.discovery-card-result` (same pattern as the manual-add form's `.discovery-manual-result`) — previously the button just silently re-enabled with no feedback. |
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

### 15.2 Log Files

Production installs (MSI/AppImage) write all logs to `<dataRoot>/logs/` (Windows: `C:\ProgramData\WsScrcpyWeb\logs\`). All log files use ISO 8601 timestamps.

| File | Source | Content |
|------|--------|---------|
| `ws-scrcpy-web.log` | Node `Logger` utility | **Canonical Node-server log** — application-level logging (this section's subject) |
| `launcher.log` | Rust `common::log` | **Canonical launcher log** — supervisor lifecycle, control markers, elevated runner, operation-server |
| `tray.log` | Rust `common::log` (tray helper) | **Canonical tray log** — tray lifecycle, per-session mutex, balloon notifications |
| `server.log` | Rust launcher (Node child stdout/stderr redirect) | **Thin crash-catcher** — `Logger` suppresses its own echo under the launcher (`isTTY` gate); only fills on raw crashes / native failures |
| `service.log` | Service manager (launcher stderr capture) | **Thin crash-catcher** (service mode only) — launcher suppresses normal lines under a service (`is_terminal()` gate); only fills on raw launcher panics |
| `post-stop.log` | `post-stop.bat` (generated by elevated runner) | Service uninstall and update-apply post-stop actions |

**`ws-scrcpy-web.log` specifics:**

| Property | Value |
|----------|-------|
| **Location** | `<dataRoot>/logs/ws-scrcpy-web.log` (installed) or project root (dev mode) |
| **Format** | `{ISO 8601 timestamp} [{tag}] {message}` for info, `{ISO 8601 timestamp} [{tag}] ERROR {message}` for errors |
| **Writes** | Synchronous (`fs.appendFileSync`) so crash output is never lost in a buffer |
| **Rotation** | Per write, if the log file reaches 10 MB it is renamed to `ws-scrcpy-web.log.1` (one backup kept) |

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

## 18. node-pty Prebuilt Resolution

`node-pty` is a native Node module used by the shell modal to spawn an
interactive terminal. Historically it required a C++ toolchain at install
time; as of SP1+SP1b (April 2026) the app uses a two-source prebuilt chain
so no user ever compiles native code. `node-pty` is an `optionalDependency`;
the repo's `.npmrc` sets `ignore-scripts=true` globally so the package's
native `node-gyp rebuild` install hook is skipped. The binary arrives via
our own prebuilt matrix.

### 18.1 Runtime Resolution

At server startup, `src/server/NodePtyResolver.ts` executes a chain
and caches the result:

0. **Bundled-first (v0.1.10+).** Try `import('node-pty')` directly,
   gated by `cacheDirHasBinary(node_modules/node-pty/build/Release/)`.
   The Velopack image ships `pty.node` from `npm ci --omit=dev` at
   `<base>/current/node_modules/node-pty/build/Release/`, so on a fresh
   install the bundled binary already covers the running Node ABI. If
   the import succeeds, we're done — no manifest fetch, no network.
   Pre-v0.1.10 the resolver always went through manifest fetch, so a
   clean VM with restrictive networking returned `available: false`
   even with a working `pty.node` already on disk.

1. **Load manifest** — only when the bundled import isn't viable. Fetch
   `manifest.json` from our GH Release `node-pty-prebuilds-latest`
   (falls back to a cached copy at `dependencies/node-pty/manifest.json`
   for offline boot). The manifest names the current upstream node-pty
   version and the Node ABIs covered.

2. **Local cache** — look under
   `dependencies/node-pty/v{upstreamVersion}/{platform}-{arch}[-{libc}]/`.
   Populated by a prior run, by `npm run fetch-prebuilts`, or (eventually)
   by the installer / Docker image.

3. **Download if cache misses** — fetch the tarball from
   `node-pty-prebuilds-v{upstreamVersion}`, verify SHA256 against the
   release's `SHA256SUMS`, extract with `tar --strip-components=1` into
   the cache directory.

Either way, the resolver then copies the cache directory contents into
`node_modules/node-pty/build/Release/`. Upstream `node-pty`'s standard
loader (`lib/utils.js`) iterates `build/Release/`, `build/Debug/`, and
`prebuilds/{platform}-{arch}/` uniformly on all platforms, so the binary
is found with no platform-specific branching.

If the manifest doesn't cover the current ABI, or download fails, or
`require('node-pty')` rejects, the resolver returns
`{ available: false, reason }`. `/api/capabilities` reports
`{ shell: false }`, and the shell anchor on every device card is
disabled-via-CSS + `aria-disabled` + tooltip. Every other feature
continues to work.

### 18.2 Fallback Publisher Workflow

A GitHub Actions workflow at `.github/workflows/node-pty-prebuilds.yml`
runs weekly (Mondays 09:00 UTC) and on manual dispatch. A pre-check
compares tracked state in `.github/state/node-pty-prebuilds-state.json`
against the latest Node LTS list from `nodejs.org/dist/index.json` and
the latest `microsoft/node-pty` upstream release. On any change, a 10-row
matrix builds prebuilts for:

```
{win32 x64, win32 arm64, linux x64 glibc, linux arm64 glibc, linux x64 musl}
× {current LTS, prior LTS}
```

`linux arm64 musl` is intentionally excluded: GitHub Actions' JS-action
runtime (checkout, setup-node, upload-artifact) cannot execute inside an
Alpine container on an ARM64 runner. Hosts on arm64+musl land in the
`{ available: false, reason: 'no-prebuilt-for-abi-...' }` path and use the
shell-disabled UI. See `actions/runner#801`.

The workflow attaches the tarballs + `SHA256SUMS` + `manifest.json` to a
versioned GitHub Release and updates a `node-pty-prebuilds-latest`
release whose only asset is the manifest (used by the consumer resolver).
Any failed matrix row auto-opens an issue tagged `prebuild-failure` with
a link to the run.

### 18.3 Libc Detection

`src/server/libcDetect.ts` probes three signals to determine whether the
runtime uses glibc or musl:

- `process.report.header.glibcVersionRuntime` (Node 15.6+)
- `/etc/alpine-release` file existence
- `ldd --version` stderr output

This ensures minimal containers without one or two signals still get a
correct answer.

### 18.4 Capability Surface

`GET /api/capabilities` returns `{ shell: boolean }`. `DeviceTracker`
fetches this once on mount and renders the shell anchor on each device
card as disabled-via-CSS + `aria-disabled` + tooltip when
`shell === false`.

### 18.5 Files

| File | Purpose |
|------|---------|
| `src/server/NodePtyResolver.ts` | Two-source resolution chain: local cache → download-if-missing |
| `src/server/libcDetect.ts` | glibc vs musl detection via process.report, alpine-release, ldd |
| `src/server/api/CapabilitiesApi.ts` | `GET /api/capabilities` endpoint returning `{ shell: boolean }` |
| `src/app/googDevice/client/DeviceTracker.ts` | Fetch capabilities on mount, gate shell anchor client-side |
| `scripts/fetch-prebuilts.mjs` | Pure-JS CLI for pre-fetching prebuilts (air-gapped setups, CI pre-test) |
| `vitest.globalSetup.ts` | Runs fetch-prebuilts before any test to ensure node-pty binary is present |
| `.github/workflows/node-pty-prebuilds.yml` | Weekly/manual dispatch CI; 10-row matrix, SHA256 verification, release publish |
| `.github/state/node-pty-prebuilds-state.json` | Tracked build state (Node LTS versions, upstream release) |
| `scripts/compute-matrix-versions.mjs` | Pre-check script for workflow matrix computation |
| `.npmrc` | `ignore-scripts=true` — prevents node-pty's install script from firing node-gyp rebuild |

### 18.6 Reference Docs

- **SP1 design spec:** `docs/superpowers/specs/2026-04-21-sp1-node-pty-prebuilts-design.md`
- **SP1 implementation plan:** `docs/superpowers/plans/2026-04-21-sp1-node-pty-prebuilts.md`
- **SP1b design spec:** `docs/superpowers/specs/2026-04-21-sp1b-node-pty-direct-design.md`
- **SP1b implementation plan:** `docs/superpowers/plans/2026-04-21-sp1b-node-pty-direct.md`

---

## 19. Service Mode Architecture

Service mode lets ws-scrcpy-web run as a Windows service (via [Servy](https://github.com/nicedayzhu/servy)) or a Linux **systemd** unit, so the app starts at boot and survives logouts. Both platforms share the same browser UI and `/api/service/*` endpoints (sections 19.3–19.4) but use different OS mechanics:

- **Windows** (sections 19.1–19.2) uses an **operation-server pattern** — privileged work is deferred to a `post-stop.bat` Servy hook, so uninstall needs no UAC prompt and there is no port-sweep delay.
- **Linux** (section 19.5) drives **systemd** directly, with an out-of-cgroup `systemd-run` teardown helper so an uninstall can stop the very unit that triggered it. User and system scopes are both supported; system scope is hardened for SELinux and Local-Dependencies-Only.

### 19.1 Windows Install Flow (Servy)

1. User clicks "Install as service" in the welcome modal or Settings.
2. Browser calls `POST /api/service/install`.
3. `ServiceApi` invokes the elevated runner (section 20.3), which triggers UAC once for `servy-cli install`.
4. `ServiceOperationModal` opens in the browser, displaying "Installing service, please wait..."
5. The modal polls `GET /api/service/status` until it detects that the service-mode Node has started and written a new `webPort` to `config.json`.
6. On detection, the modal auto-navigates to the service-mode URL.

### 19.2 Windows Uninstall Flow (Operation-Server Pattern)

The uninstall flow avoids UAC by deferring privileged work to a `post-stop.bat` script that Servy runs after the service Node exits:

1. User clicks "Uninstall service" in Settings.
2. Browser calls `POST /api/service/uninstall`.
3. The service-mode Node writes an `uninstall-pending` marker file and spawns the Rust **operation-server** binary on the same port.
4. The service-mode Node exits. Servy's post-stop hook runs `post-stop.bat`, which detects the `uninstall-pending` marker and runs `servy-cli uninstall` (no UAC needed because the service process context has sufficient privileges).
5. `post-stop.bat` spawns a fresh user-session launcher (`ws-scrcpy-web-launcher.exe --local-takeover`).
6. The operation-server serves a static "please wait" transition page to the browser while the fresh launcher boots.
7. The fresh launcher writes its `webPort` to `config.json` and drops a stop marker. The operation-server detects the stop marker (or the fresh Node's readiness via `/api/discover`) and winds down.
8. The browser's `ServiceOperationModal` detects the `config.json` mtime change, reads the new `webPort`, and navigates to the local-mode URL.

### 19.3 API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/service/status` | Returns current service state (installed, running, mode). Always 200. |
| POST | `/api/service/install` | Install the service. Triggers UAC. Returns 501 if not a Velopack install. |
| POST | `/api/service/uninstall` | Uninstall the service via the operation-server pattern (no UAC). |
| POST | `/api/service/install-system-wide` | (Linux) Relocate a local install to a machine-wide `/opt` install under one `pkexec` prompt; re-execs from `/opt`. |
| POST | `/api/service/uninstall-app` `{keep}` | (Linux) Complete app uninstall — cascades through any service + `/opt` in one pass; `keep` preserves `config.json` + logs. |

### 19.4 Config.json Port Discovery

The mtime-based discovery mechanism replaces the old `discoverServicePort` approach. Both install and uninstall flows use it:

- **Install:** `ServiceOperationModal` polls `/api/service/status` until the service-mode Node starts and writes a fresh `webPort`.
- **Uninstall:** `ServiceOperationModal` monitors `config.json` mtime. When the fresh user-session launcher writes its port, the mtime changes and the modal reads the new value.
- The operation-server exposes `/api/discover` for the browser to detect when the fresh launcher is ready.

### 19.5 Linux Service Mode (systemd)

On Linux the service is a systemd unit managed by `SystemdClient` (`src/server/service/SystemdClient.ts`) — the cross-platform `ServiceClient` counterpart to the Windows `ServyClient`. The install UI offers two **scopes**:

| Scope | Unit file | Elevation | Starts | Notes |
|-------|-----------|-----------|--------|-------|
| **user** | `~/.config/systemd/user/<name>.service` | none | at login | `loginctl enable-linger` (best-effort) keeps it running after logout; a `~/.config/autostart/ws-scrcpy-web-tray.desktop` autostarts the tray |
| **system** | `/etc/systemd/system/<name>.service` | `pkexec` (one prompt) | at boot | hardened for SELinux + Local-Dependencies-Only (below); no tray autostart (headless-dominant) |

The unit body (`renderUnitFile`) is `Type=simple`, `Restart=on-failure` / `RestartSec` (5s user, 2s system — the shorter system value drives the desktop port-takeover retry), with `StartLimitIntervalSec`/`StartLimitBurst` in `[Unit]` (systemd silently ignores them in `[Service]`), and `StandardOutput`/`StandardError=append:` to the log. `WantedBy` is `default.target` (user) or `multi-user.target` (system). Running state is read with `systemctl is-active` (machine-readable), not `systemctl status`.

**System scope — SELinux + Local-Dependencies-Only.** A system unit runs under the `init_t` domain, which SELinux (e.g. Fedora enforcing) forbids from exec'ing a `user_home_t` AppImage — and a root service has no `HOME`. So a system install (the `installSystemService` core in `systemServiceCli.ts`, run as root via `sudo … --install-system-service` headless or one awaited `pkexec … --install-system-service` from the desktop) stages everything into a root-owned `/opt/ws-scrcpy-web/` tree:

- `WsScrcpyWeb.AppImage` and a copy of the user's `dependencies/` → labelled **`bin_t`** (persistent `semanage fcontext` + `restorecon`) so `init_t` may exec them, and so the service runs its **own** deps instead of reaching into a user's home.
- Config + logs live in **`/var/lib/ws-scrcpy-web`**, which the policy's built-in `/var/lib(/.*)?` rule labels **`var_lib_t`** automatically — **no custom rule** (a `restorecon` is belt-and-suspenders). `/var/opt` was impossible: Fedora's `file_contexts.subs_dist` aliases `/var/opt → /opt`, so semanage rejects a `var_lib_t` rule beneath it — the bug that broke the system install on every SELinux distro since beta.41.
- The unit's `Environment=` sets `DATA_ROOT=/var/lib/ws-scrcpy-web` + `DEPS_PATH=/opt/ws-scrcpy-web/dependencies` (`buildServiceUnitEnv`), and a seeded `config.json` (`buildSystemSeedConfig`: `installMode=system-service`, `firstRunComplete=true`, the installing user's `webPort`) lands in `/var/lib/ws-scrcpy-web` so the service boots a correct, persistent config on the same port — no stray WelcomeModal, and it survives reboot. The whole label step is isolated with a trailing `|| true` so a non-SELinux host doesn't abort the install.

**Uninstall — out-of-cgroup teardown.** Calling `systemctl stop` from inside the service unit's own cgroup would kill the calling process mid-operation (item 32). So `ServiceApi` launches the teardown entry via `systemd-run` (its own transient unit / separate cgroup) — the staged `/opt` AppImage for system scope, the home launcher for user scope — with `--linux-service-teardown --scope <user|system> --unit <name>`; `linux_service.rs` then runs, best-effort: `stop` → `disable` → `reset-failed` → remove the unit file → (system scope) `rm -rf /opt/ws-scrcpy-web` + `/var/lib/ws-scrcpy-web` + `semanage fcontext -d` the `/opt` `bin_t` rule → `daemon-reload` → reap the escaped adb daemon. **User scope** then relaunches the home AppImage in local mode via `systemd-run --user --collect` (path read from the `<dataRoot>/control/local-appimage` marker); **system scope** does not auto-relaunch (the admin relaunches their own AppImage).

**Complete uninstall (beta.49).** Distinct from the service teardown above, `POST /api/service/uninstall-app {keep}` removes the *entire* app — any user/system service, a machine-wide `/opt` install, the user data root, the start-menu `.desktop` + icon, and the SELinux fcontext rules — in a single pass. `app_uninstall_commands` (`launcher/src/linux_app_uninstall.rs`) is a pure builder splitting the teardown into a `privileged` group (root-owned: `/opt`, `/var/lib`, `.desktop`/icon, fcontext) and an unelevated `user_owned` group (stray processes, user-scope unit, the `~/.local` data root). `--linux-app-uninstall` runs `user_owned` directly and elevates `privileged` per uid (mirroring the service-update split): a root system-service runs them directly; a non-root caller re-invokes the launcher under **one** `pkexec` (`--linux-app-uninstall-elevated`), and a declined prompt aborts before anything is removed, relaunching the app so the user is never stranded. `keep=true` deletes only the regenerable `dependencies`/`bin`/`control` subdirs — preserving `config.json` + `logs/` (at the data root's owner, `~/.local` or `/var/lib`) — and resets `installMode` so a later reinstall comes up clean.

### 19.6 Components

| File | Purpose |
|------|---------|
| `src/server/api/ServiceApi.ts` | REST endpoints; Windows `post-stop` handoff + Linux `systemd-run` teardown launch |
| `src/server/service/ServiceClient.ts` | Cross-platform service interface (`install`/`uninstall`/`status`/scope) |
| `src/server/service/ServyClient.ts` | Windows implementation (servy-cli) |
| `src/server/service/SystemdClient.ts` | Linux implementation (systemd; both scopes; `/opt` staging + SELinux labelling) |
| `src/server/service/systemTools.ts` | Absolute-path resolver for OS tools (`systemctl`, `pkexec`, `semanage`, …) — Local-Dependencies-Only |
| `src/app/client/ServiceOperationModal.ts` | Browser-side transition modal with polling |
| `src/app/client/SettingsModal.ts` | Service install/uninstall controls + scope radios in the Settings panel |
| `launcher/src/operation_server.rs` | Rust binary that serves the transition page during uninstall/update (Windows) |
| `launcher/src/elevated_runner.rs` | Generates `post-stop.bat` with uninstall/update-apply logic (Windows) |
| `launcher/src/linux_app_uninstall.rs` | (Linux, beta.49) Pure `app_uninstall_commands` builder + `--linux-app-uninstall` dispatch for the in-app complete uninstall (getuid-aware `pkexec` elevation) |
| `launcher/src/linux_service.rs` | Out-of-cgroup systemd teardown + user-scope local relaunch (Linux) |

---

## 20. Launcher Architecture

The Rust launcher is the production entry point for MSI and AppImage installs — `ws-scrcpy-web-launcher.exe` on Windows, the same binary (no `.exe`) wired as the AppImage's `mainExe` on Linux. It replaces the `start.cmd` / `start.sh` scripts (which remain for dev mode only). The supervisor loop (20.1) is cross-platform; sections 20.2–20.7 are Windows-specific OS integration, and section 20.8 covers the Linux-only subcommands.

### 20.1 Supervisor Loop

The launcher's main loop in `launcher/src/spawn.rs`:

1. Spawn Node as a child process: `node dist/index.js`
2. Redirect Node stdout/stderr to `<dataRoot>/logs/server.log` (thin crash-catcher; normal app output is in `ws-scrcpy-web.log`)
3. Wait for the child to exit
4. On exit code `75` or `.restart` marker: clean up old binaries, respawn
5. On normal exit (code 0): shut down
6. On unexpected exit: log the error and shut down

The supervisor also watches for the `.restart` marker at `<depsPath>/.restart`, written by the dependency updater after a Node.js update.

### 20.2 Tray Supervisor

`launcher/src/tray_supervisor.rs` manages the standalone tray helper (section 21):

- Spawns `ws-scrcpy-web-tray.exe` as a separate process on launcher startup
- Polls every 10 seconds; if the tray process has exited, respawns it
- Automatically recovers after user kills, upgrades, or mode changes
- Passes the current mode (local vs. service) and web port as arguments

### 20.3 Elevated Runner (UAC)

`launcher/src/elevated_runner.rs` handles operations requiring administrator privileges:

- Uses `ShellExecuteExW` with the `runas` verb for UAC elevation (no PowerShell intermediary)
- Generates `post-stop.bat` scripts for Servy's post-stop hook, with branches for `uninstall-pending` and `apply-update-pending` markers
- Spawns user-session launchers via `WTSQueryUserToken` + `CreateProcessAsUser` for the service-to-local transition

### 20.4 Job Object

`launcher/src/job_object.rs` creates a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. All child processes (Node, tray, operation-server) are assigned to the job. If the launcher is killed, Windows automatically terminates all children — no orphaned processes.

### 20.5 Single-Instance Mutex

The launcher acquires a named mutex at startup to prevent multiple instances. If the mutex is already held, the launcher exits immediately. This prevents the user from accidentally spawning duplicate servers.

### 20.6 Session ID Resolution

All Rust binaries use `common::session::active_interactive_session()` (in `common/src/session.rs`) to find the active user session. This replaces the earlier `WTSGetActiveConsoleSessionId` call with a `WTSEnumerateSessionsW`-based resolver that correctly identifies the interactive session even in RDP and fast-user-switching scenarios.

### 20.7 Console Window Flash Elimination

`launcher/src/hooks.rs` provides a `silent_command` helper that spawns processes with the `CREATE_NO_WINDOW` creation flag. All subprocess launches (Node, tray, ADB, operation-server) use this helper to prevent console window flashes during normal operation.

### 20.8 Linux Launcher Subcommands

On Linux the launcher binary is also the entry point for several one-shot, out-of-process operations, dispatched by argv at startup (each returns an exit code and skips the supervisor loop):

| Flag | Module | Purpose |
|------|--------|---------|
| `--linux-apply --staged <p> --target <p>` | `linux_apply.rs` | Swap a downloaded AppImage over `$APPIMAGE` and relaunch (local-mode update apply). Launched via `systemd-run --collect` so it survives the app's exit (item #27). |
| `--linux-apply … --service-restart <user\|system> --unit <name> [--relabel]` | `linux_apply.rs` | Service-mode update apply (item 39): stop the unit → swap → (`--relabel`, system scope) re-apply the `bin_t` label → start the unit. System scope runs as root via `systemd-run` (no `--user`), so it self-updates headlessly with no `pkexec`. |
| `--install-system-service [--port N]` / `--uninstall-system-service [--keep-state]` / `--system-service-status` | `system_service_cli.rs` | Run the privileged system-service install/uninstall/status core as root (headless `sudo` or one awaited `pkexec` from the desktop); spawns the Node one-shot, which executes the `systemServiceCli.ts` core. |
| `--linux-service-teardown --scope <user\|system> --unit <name>` | `linux_service.rs` | Out-of-cgroup service-uninstall teardown (section 19.5). |
| `--local-takeover` | `supervisor.rs` | Forces local (non-service) mode for the instance the service-uninstall teardown relaunches. |

The Linux data root is resolved by `common/src/config.rs` (`DATA_ROOT` → `XDG_DATA_HOME` → `~/.local/share/WsScrcpyWeb`), mirroring the Node `resolveDataRoot`. The AppImage runtime itself is swapped to the static type-2 runtime at **build** time (`scripts/swap-appimage-runtime.mjs`), so it launches without host `libfuse2` (see the README "libfuse2" note).

### 20.9 Key Files

| File | Purpose |
|------|---------|
| `launcher/src/main.rs` | Entry point, argument parsing, single-instance mutex |
| `launcher/src/spawn.rs` | Node supervisor loop, exit-code handling, `.restart` marker |
| `launcher/src/tray_supervisor.rs` | Tray helper spawn + 10s poll respawn |
| `launcher/src/elevated_runner.rs` | UAC elevation, `post-stop.bat` generation, user-session spawn |
| `launcher/src/job_object.rs` | Kill-on-close job object for child process cleanup |
| `launcher/src/operation_server.rs` | Transition-page HTTP server for service install/uninstall |
| `launcher/src/hooks.rs` | `silent_command` helper with `CREATE_NO_WINDOW` |
| `launcher/src/linux_apply.rs` | Linux update-apply: local swap + relaunch, and `--service-restart` |
| `launcher/src/linux_service.rs` | Linux service teardown + user-scope local relaunch |
| `launcher/src/paths.rs` | Path resolution (`dataRoot`, `depsPath`, `logsDir`) |
| `launcher/src/log.rs` | Launcher-side logging to `launcher.log` |
| `common/src/config.rs` | Shared data-root resolution; Linux `DATA_ROOT`/XDG, fails loudly instead of `/tmp` |
| `common/src/session.rs` | `active_interactive_session()` — `WTSEnumerateSessionsW`-based resolver (Windows) |

---

## 21. Tray Helper

`ws-scrcpy-web-tray.exe` is a standalone Rust binary that shows a system tray icon. It is supervised by the launcher (section 20.2) rather than running as an in-process thread.

### 21.1 Lifecycle

- Spawned by the launcher's tray supervisor on startup
- Acquires a per-session named mutex to prevent duplicate tray instances
- If the mutex is already held (e.g., from a prior launcher run that didn't clean up), the new instance exits and the supervisor retries on the next poll cycle
- On launcher shutdown, the job object kills the tray process automatically

### 21.2 Mode-Aware Behavior

The tray text and tooltip reflect the current operating mode:

| Mode | Tray text |
|------|-----------|
| Local (user-mode) | "ws-scrcpy-web (local)" |
| Service | "ws-scrcpy-web (service)" |

The tray provides:
- **Open in browser** — launches the default browser to `http://localhost:<port>`
- **Balloon notifications** — shown on startup and mode transitions

### 21.3 Key Files

| File | Purpose |
|------|---------|
| `tray/src/main.rs` | Tray entry point, per-session mutex, menu, balloon notifications |

---

## 22. In-App Updater (Velopack)

The in-app updater uses [Velopack](https://velopack.io/) to apply full-application updates (as distinct from the runtime dependency updater in section 13, which handles Node/ADB/scrcpy-server).

### 22.1 UpdateService

`src/server/UpdateService.ts` wraps the Velopack `UpdateManager`:

- **Check:** Polls the GitHub release feed for new versions. The feed URL is constructed from `config.json` fields (`githubOwner`, `channel`). The `channel` field selects between `releases.json` (stable) and `releases.beta.json` (beta).
- **Download:** Downloads the update delta/full package with progress reporting to the browser via WebSocket events.
- **Apply (Windows):** Calls `UpdateManager.waitExitThenApplyUpdate()`, which signals the launcher to exit, apply the update, and relaunch. **On Linux this Velopack path is inert** — its `UpdateNix apply` aborts before touching any file — so `applyUpdate()` branches to a download-and-swap flow instead (section 22.5).

### 22.2 Upgrade Server

During the Velopack apply phase, the Rust launcher spawns an **upgrade-server** — a minimal HTTP server (in `launcher/src/operation_server.rs`) that serves a static "Updating, please wait..." page on the same port. This prevents the browser from showing a connection error while the update is being applied.

The upgrade-server's wind-down probe detects when the new Node process is ready:
1. Polls `http://localhost:<port>/api/service/status` (or the root endpoint) periodically
2. When the new Node responds, the upgrade-server sends a redirect to the browser and shuts down
3. If the port changes during the update (e.g., the old port is no longer free), the upgrade-server detects this via the `config.json` mtime mechanism and redirects to the new port

### 22.3 Update Markers

| Marker file | Written by | Read by | Purpose |
|-------------|-----------|---------|---------|
| `control/apply-update-pending` | Node (UpdateService) | `post-stop` handler | (Windows) tells the post-stop step to run the Velopack apply |
| `control/local-appimage` | Node (install) | `linux_service.rs` | (Linux) home AppImage path, used to relaunch local mode after a user-scope service uninstall |
| `.restart` | Node (DependencyManager) | Launcher supervisor | Triggers a Node respawn after dep updates |

### 22.4 Dev-Mode Safety

The `requiresLauncher` flag in `DependencyDefinitions.ts` gates Node.js and ADB updates in dev mode. When running without the Rust launcher (i.e., `npm start`), these updates are blocked because there is no supervisor to handle the restart. The browser UI shows the updates as available but disables the apply button with an explanatory tooltip.

### 22.5 Linux Apply (download + swap)

Velopack's `UpdateNix apply` is inert on the AppImage layout — it re-derives its own locator and aborts in under a millisecond, before touching any file (diagnosed on Fedora; see CHANGELOG v0.1.30-beta.27). So on Linux `applyUpdate()` does **not** delegate to Velopack. For every Linux install mode it instead:

1. Downloads the published AppImage for the target version from the GitHub release and verifies it against the release `SHA256SUMS`.
2. Hands off to the launcher's `--linux-apply` helper (section 20.8), launched via `systemd-run --collect` so it survives the app's own exit (separate cgroup — item #27).
3. Spawns the operation-server (22.2) to serve the "updating…" transition page.

The helper shape is selected by `installMode`:

| Mode | Helper args | Behaviour |
|------|-------------|-----------|
| local | `--linux-apply --staged <s> --target <t>` | back up + swap `$APPIMAGE`, relaunch |
| user-service | `… --service-restart user --unit <name>` | stop unit → swap home AppImage → start (user manager) |
| system-service | `… --service-restart system --unit <name> --relabel` | stop unit → swap the `/opt` copy → re-apply `bin_t` → start (system manager, root, no `pkexec`) |

Windows and the Windows-service apply path are unchanged (Velopack `waitExitThenApplyUpdate`).

### 22.6 Key Files

| File | Purpose |
|------|---------|
| `src/server/UpdateService.ts` | Velopack wrapper (check, download); Windows apply + Linux download-and-swap branch |
| `src/server/api/UpdatesApi.ts` | REST + WebSocket endpoints for the browser update UI |
| `src/server/Config.ts` | `autoUpdate`, `updateCheckIntervalMinutes`, `channel` fields + control-marker paths |
| `launcher/src/linux_apply.rs` | Linux AppImage swap + relaunch + `--service-restart` |
| `launcher/src/operation_server.rs` | Upgrade-server and uninstall-server (shared binary) |

---

## 23. First-Run Modal Gating

`src/app/client/firstRunGate.ts` orchestrates the first-run experience, ensuring the user sees the right modal on the right instance.

### 23.1 Decision Flow

On page load, `src/app/index.ts` fetches the config envelope from `GET /api/config` and evaluates:

```
config.installMode is service AND config.serviceFirstRunSeen is false?
    → show ServiceFirstRunModal (section 23.3)
config.firstRunComplete is false?
    → show WelcomeModal (section 23.2)
else
    → no modal, proceed to home page
```

### 23.2 WelcomeModal

Shown on the first page load of a local-mode (non-service) instance. Lets the user choose their install mode:

- **Just for me (local)** — runs as a user-session process, starts when the user launches the app
- **Install as a service** — triggers service installation (section 19.1 on Windows, 19.5 on Linux)

On dismissal, `firstRunComplete = true` is persisted to `config.json` server-side. This survives port shifts and browser clears because it is stored on the server, not in localStorage.

### 23.3 ServiceFirstRunModal

Shown on the first page load of a service-mode instance (after the service has been installed). Informs the user:

- The service runs at boot — this URL stays valid across reboots
- The current port is the one to bookmark

On dismissal, `serviceFirstRunSeen = true` is persisted to `config.json`.

### 23.4 Config.json Persistence

The first-run and bookmark-dismissal flags are stored in `config.json` rather than localStorage:

| Field | Default | Set by |
|-------|---------|--------|
| `firstRunComplete` | `false` | WelcomeModal dismissal |
| `serviceFirstRunSeen` | `false` | ServiceFirstRunModal dismissal |
| `bookmarkDismissedForPort` | `null` | PortChangeModal "got it" (stamps the current port) |
| `bookmarkDismissedGlobally` | `false` | PortChangeModal "don't show again — ever" |

This design means the state survives port changes, browser cache clears, and machine reboots (localStorage is unreliable on the Linux AppImage, which can treat each launch as a different origin). The **Settings → Server** panel includes a **"reset welcome and bookmark prompts"** button (`resetPromptsPayload()`) that clears all four fields at once — `firstRunComplete` and `serviceFirstRunSeen` back to `false`, `bookmarkDismissedForPort` to `null`, and `bookmarkDismissedGlobally` to `false` — re-triggering the first-run flow.

### 23.5 Port Change Modal

`PortChangeModal` fires when the server's port has changed since the user last dismissed the welcome flow. It prompts the user to update their bookmarks. The `firstRunGate` module tracks a `bookmarkDismissedPort` to suppress the port-change modal during the initial welcome flow (where the port is already visible).

### 23.6 Key Files

| File | Purpose |
|------|---------|
| `src/app/client/firstRunGate.ts` | Gate logic, bookmark-dismissed-port tracking |
| `src/app/client/WelcomeModal.ts` | First-run mode selection modal |
| `src/app/client/ServiceFirstRunModal.ts` | Service-instance first-run info modal |
| `src/app/client/PortChangeModal.ts` | Port-changed notification modal |
| `src/app/client/SettingsModal.ts` | "Reset welcome prompts" button |
