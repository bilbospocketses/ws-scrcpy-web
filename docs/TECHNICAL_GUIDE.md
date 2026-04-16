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
6. [Embed Mode](#6-embed-mode)
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
│   │   ├── FeaturedInteractionHandler.ts  # Mouse-to-touch mapping, right-click=BACK, scroll
│   │   └── SimpleInteractionHandler.ts    # Minimal touch handler
│   ├── googDevice/
│   │   ├── client/
│   │   │   ├── StreamClientScrcpy.ts # Main client: connects demuxer, player, touch, audio, UHID
│   │   │   ├── ConfigureScrcpy.ts    # Stream configuration dialog UI
│   │   │   └── DeviceTracker.ts      # Device list UI
│   │   ├── UhidManager.ts            # Creates/destroys UHID keyboard+mouse devices
│   │   ├── UhidKeyboardHandler.ts    # Keyboard events -> USB HID key reports
│   │   ├── UhidMouseHandler.ts       # Pointer lock mouse -> USB HID mouse reports
│   │   ├── KeyInputHandler.ts        # Legacy scrcpy keycode input (Android keycodes)
│   │   ├── hid-usage-tables.ts       # Browser code -> USB HID keycode mapping tables
│   │   └── toolbox/                  # Toolbar UI (GoogToolBox, GoogMoreBox)
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
└── style/app.css                      # All CSS including embed mode rules
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
| `TYPE_GET_CLIPBOARD` | `8` | Request clipboard content |
| `TYPE_SET_CLIPBOARD` | `9` | Set clipboard content |
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

## 6. Embed Mode

Embed mode provides a streamlined UI for iframe integration, used by the Control Menu project's `ScrcpyMirror.razor` component.

### 6.1 Activation

URL parameter `embed=true` triggers embed mode in `StreamClientScrcpy.parseParameters()`, which sets `fitToScreen: true`. The `body.embed` CSS class is applied.

### 6.2 CSS Rules

```css
body.embed {
    background: transparent;        /* Blends with parent page */
}
body.embed .more-box {
    display: none !important;       /* Hides settings/info panel */
}
body.embed .device-view {
    float: none;
    display: flex;
    width: 100%;
    height: 100%;                   /* Fills iframe */
}
body.embed .video {
    float: none;
    flex: 1;
    max-height: 100vh;
    max-width: 100vw;
    background: transparent;
}
```

### 6.3 Click-to-Focus

In embed mode, a one-time `click` listener on the video container calls `video.focus()`, ensuring keyboard events are captured by the iframe.

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
   - `RemoteShell` -- terminal access via node-pty
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
| 12 | `@xterm/xterm` | 6.0.0 | Terminal emulator rendered in the browser (Microsoft) | Major versions may have API changes affecting `ShellClient.ts` |
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
   - Android version + disconnect button (network devices only, right-aligned via rowspan)
   - SDK version

2. **"opens in overlay" section** -- buttons that open UI overlays on the current page:
   - `configure stream` -- codec/encoder selection dialog

3. **"opens in new tab" section** -- buttons that open in a new browser tab:
   - `connect` -- opens a mirroring session using WebCodecs
   - `shell` -- opens an ADB shell terminal (xterm.js + node-pty)
   - `list files` -- opens the file manager

**Disconnect button:** Shown only for network-connected devices (serial contains `:`). Calls `POST /api/devices/disconnect`. On the next poll cycle (5s), `ControlCenter` detects the device is gone, broadcasts a disconnect state update via WebSocket, and removes the device from its maps. The client-side `BaseDeviceTracker.updateDescriptor()` splices disconnected devices from the descriptors array, and `buildDeviceTable()` re-renders without them -- the card disappears. Built via DOM manipulation (not the `html` template tag) because the template's XSS protection escapes raw HTML strings.

**Interface auto-selection:** The interface dropdown was removed. The best connection path is selected automatically: WiFi interface (direct IP) is preferred, falls back to the first available interface, then to ADB proxy as a last resort.

**Removed legacy features:**
- Interface dropdown (replaced by auto-selection)
- Server PID button (was a no-op -- server lifecycle is managed by `ScrcpyConnection`)
- "WebCodecs" link label (renamed to "connect")

### 14.2 Network Discovery

**API Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/devices/scan` | Discover ADB devices on local network via mDNS. Returns serial + existing label for each device. |
| POST | `/api/devices/connect` | Connect to a discovered device (JSON body: `{ "address": "ip:port", "serial": "...", "label": "..." }`). Serial and label are optional -- if both provided, label is saved. |
| POST | `/api/devices/disconnect` | Disconnect a network device by address (JSON body: `{ "address": "ip:port" }`) |
| GET | `/api/devices/labels` | Return all device labels as `{ serial: label }` |
| PUT | `/api/devices/labels` | Set or delete a device label (JSON body: `{ "serial": "...", "label": "..." }`). Empty label deletes. |

The "Scan Network" button calls `POST /api/devices/scan` which runs `adb mdns services` to discover ADB-enabled devices advertising via mDNS on the local network. Results are filtered to any `_adb` service except `_adb-tls-pairing`, and exclude already-connected devices. Each result includes a `serial` field (parsed from the mDNS name via `parseSerialFromMdnsName`) and a `label` field (from `DeviceLabelStore`, or empty). Discovered devices are displayed as cards with an optional name input and "Connect" button.

Connecting calls `POST /api/devices/connect` with the device address plus optional serial and label. If a name was entered, it is saved to `device-labels.json` before connecting. On success, the card shows "Connected" briefly and then disappears. The device appears in the Connected Devices section via the normal WebSocket update flow from `ControlCenter`.

**Requirement:** Devices must have wireless debugging enabled and be on the same local network. mDNS discovery works on standard home networks.

**Components:**
- `src/server/api/DeviceDiscoveryApi.ts` -- HTTP endpoint handler (scan, connect, disconnect, labels)
- `src/server/AdbClient.ts` -- `mdnsServices()`, `connect()`, `disconnect()` methods + `parseMdnsOutput()` + `parseSerialFromMdnsName()` parsers
- `src/server/DeviceLabelStore.ts` -- label persistence (JSON file, in-memory cache)
- `src/app/client/NetworkDiscoveryPanel.ts` -- browser-side scan UI with optional name input

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

Labels are stored in `device-labels.json` in the project root, keyed by hardware serial number (`ro.serialno`):

```json
{
  "49241HFAG07SUG": "Living Room TV",
  "47121FDAQ000WC": "Jamie's Pixel 9"
}
```

**`DeviceLabelStore`** (`src/server/DeviceLabelStore.ts`):
- Singleton with `getInstance()` / `resetInstance()`
- `get(serial)`, `set(serial, label)`, `delete(serial)`, `getAll()`
- Reads file on first access, caches in memory, sync writes on every change
- File path resolves from `__dirname` (dist/) + `..` to project root (same pattern as Logger)

### 16.2 Device Identification

**Hardware serial** (`ro.serialno`) is the stable identifier. It never changes across reboots, IP changes, or reconnects.

**Connected devices:** `ro.serialno` is fetched via `getprop` as part of the normal property polling cycle. Added to the `Properties` array in `src/server/goog-device/Properties.ts` and the `GoogDeviceDescriptor` type. Flows to the browser automatically via the WebSocket device update pipeline.

**Scan results (mDNS):** Serial is parsed from the mDNS service name using `parseSerialFromMdnsName()` in `src/server/AdbClient.ts`:
- `adb-49241HFAG07SUG` (plain `_adb._tcp`) -> `49241HFAG07SUG`
- `adb-47121FDAQ000WC-7vmR8a` (`_adb-tls-connect._tcp`) -> `47121FDAQ000WC` (TLS instance suffix stripped)

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
