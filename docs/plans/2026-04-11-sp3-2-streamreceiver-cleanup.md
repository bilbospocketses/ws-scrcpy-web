# SP3-2: StreamReceiver Cleanup + Metadata Probe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy StreamReceiver/StreamReceiverScrcpy data pipeline with a lightweight metadata probe so ConfigureScrcpy can discover device encoders and display info without starting a full stream session.

**Architecture:** A new server-side `DeviceProbe` middleware accepts a WebSocket with `action=probe`, runs `adb shell` commands to discover encoders (via `dumpsys media.player`) and display info (via `wm size`/`wm density`), sends a single JSON response, and closes. On the client side, `DeviceProbeClient` wraps the WS round-trip as a Promise. ConfigureScrcpy switches from the event-driven StreamReceiverScrcpy to the one-shot probe, and gains codec selection dropdowns (video: H.264/H.265/AV1; audio: Opus/AAC/FLAC/Raw). StreamReceiver.ts and StreamReceiverScrcpy.ts are then deleted.

**Tech Stack:** TypeScript, WebSocket, ADB shell commands, JSON

**Spec:** `docs/specs/2026-04-11-sp3-feature-additions.md` (SP3-2 section)

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `src/common/ProbeResult.ts` | Shared interface: `{ width, height, density, videoEncoders, audioEncoders }` |
| `src/server/DeviceProbe.ts` | Server middleware: runs ADB commands, sends ProbeResult JSON over WS |
| `src/app/client/DeviceProbeClient.ts` | Browser client: opens WS, receives ProbeResult, returns Promise |

### Modified Files
| File | Change |
|------|--------|
| `src/common/Action.ts` | Add `PROBE_DEVICE = 'probe'` |
| `src/server/index.ts` | Register DeviceProbe in mwList |
| `src/app/googDevice/client/ConfigureScrcpy.ts` | Replace StreamReceiverScrcpy with DeviceProbeClient, add codec dropdowns |
| `src/app/googDevice/client/DeviceTracker.ts` | Remove StreamReceiverScrcpy import if present |

### Deleted Files
| File | Reason |
|------|--------|
| `src/app/client/StreamReceiver.ts` | Replaced by DeviceProbeClient |
| `src/app/googDevice/client/StreamReceiverScrcpy.ts` | Replaced by DeviceProbeClient |

---

## Task 1: Add PROBE_DEVICE action + ProbeResult interface

**Files:**
- Modify: `src/common/Action.ts`
- Create: `src/common/ProbeResult.ts`

- [ ] **Step 1: Add action to Action.ts**

In `src/common/Action.ts`, add a new action after the existing entries:

```typescript
// Add after FILE_LISTING = 'list-files':
    PROBE_DEVICE = 'probe',
```

- [ ] **Step 2: Create ProbeResult interface**

```typescript
// src/common/ProbeResult.ts

export interface ProbeResult {
    width: number;
    height: number;
    density: number;
    videoEncoders: string[];
    audioEncoders: string[];
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`
Expected: `compiled successfully`

- [ ] **Step 4: Commit**

```bash
git add src/common/Action.ts src/common/ProbeResult.ts
git commit -m "feat(sp3-2): add PROBE_DEVICE action and ProbeResult interface"
```

---

## Task 2: Create DeviceProbe server middleware

**Files:**
- Create: `src/server/DeviceProbe.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Create DeviceProbe**

The probe connects to the device via ADB, runs two shell commands to discover encoders and display info, sends a JSON response, and closes.

```typescript
// src/server/DeviceProbe.ts
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type WS from 'ws';
import { ACTION } from '../common/Action';
import type { ProbeResult } from '../common/ProbeResult';
import { AdbClient } from './AdbClient';
import { Mw, type RequestParameters } from './mw/Mw';

const TAG = '[DeviceProbe]';

export class DeviceProbe extends Mw {
    private adbClient = new AdbClient();

    public static processRequest(ws: WS, params: RequestParameters): DeviceProbe | undefined {
        const { action, url } = params;
        if (action !== ACTION.PROBE_DEVICE) {
            return;
        }
        const udid = url.searchParams.get('udid');
        if (!udid) {
            ws.close(4003, `${TAG} Missing "udid" parameter`);
            return;
        }
        return new DeviceProbe(ws, udid);
    }

    private constructor(ws: WS, private readonly serial: string) {
        super(ws);
        this.probe().catch((err) => {
            console.error(TAG, `Probe failed for ${this.serial}:`, err.message);
            if (ws.readyState === ws.OPEN) {
                ws.close(4005, err.message);
            }
        });
    }

    private async probe(): Promise<void> {
        console.log(TAG, `Probing ${this.serial}`);

        const [encoderOutput, sizeOutput, densityOutput] = await Promise.all([
            this.adbClient.shell(this.serial, 'dumpsys media.player'),
            this.adbClient.shell(this.serial, 'wm size'),
            this.adbClient.shell(this.serial, 'wm density'),
        ]);

        const videoEncoders = this.parseEncoders(encoderOutput, ['avc', 'hevc', 'av1']);
        const audioEncoders = this.parseEncoders(encoderOutput, ['opus', 'aac', 'flac']);
        const { width, height } = this.parseSize(sizeOutput);
        const density = this.parseDensity(densityOutput);

        const result: ProbeResult = { width, height, density, videoEncoders, audioEncoders };
        console.log(TAG, `Probe result for ${this.serial}:`, JSON.stringify(result));

        if (this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify(result));
            this.ws.close(1000, 'Probe complete');
        }
    }

    private parseEncoders(output: string, codecs: string[]): string[] {
        const encoders: string[] = [];
        const regex = /Encoder "([^"]+)" supports/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(output)) !== null) {
            const name = match[1];
            if (codecs.some((c) => name.includes(`.${c}.`))) {
                encoders.push(name);
            }
        }
        return encoders;
    }

    private parseSize(output: string): { width: number; height: number } {
        // Prefer "Override size" if present, fall back to "Physical size"
        const override = output.match(/Override size:\s*(\d+)x(\d+)/);
        if (override) {
            return { width: Number.parseInt(override[1], 10), height: Number.parseInt(override[2], 10) };
        }
        const physical = output.match(/Physical size:\s*(\d+)x(\d+)/);
        if (physical) {
            return { width: Number.parseInt(physical[1], 10), height: Number.parseInt(physical[2], 10) };
        }
        return { width: 1920, height: 1080 };
    }

    private parseDensity(output: string): number {
        const match = output.match(/(?:Override|Physical) density:\s*(\d+)/);
        return match ? Number.parseInt(match[1], 10) : 320;
    }

    protected onSocketMessage(): void {
        // Probe is one-shot server→client; no incoming messages expected
    }
}
```

- [ ] **Step 2: Register in server/index.ts**

In `src/server/index.ts`, add the import and registration:

```typescript
// Add import after ScrcpyConnection import:
import { DeviceProbe } from './DeviceProbe';

// Change mwList (line 14):
// Before:
const mwList: MwFactory[] = [ScrcpyConnection, WebsocketMultiplexer];
// After:
const mwList: MwFactory[] = [ScrcpyConnection, DeviceProbe, WebsocketMultiplexer];
```

- [ ] **Step 3: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`
Expected: `compiled successfully`

- [ ] **Step 4: Quick manual test**

Start the server and test the probe with a raw WS connection:

```bash
npm run build:dev && node dist/index.js &
# In another terminal or via Node:
node -e "const ws = new (require('ws'))('ws://localhost:8000/?action=probe&udid=192.168.86.43:5555'); ws.on('message', d => { console.log(d.toString()); ws.close(); process.exit(); });"
```

Expected: JSON with videoEncoders, audioEncoders, width, height, density.

- [ ] **Step 5: Commit**

```bash
git add src/server/DeviceProbe.ts src/server/index.ts
git commit -m "feat(sp3-2): add DeviceProbe server middleware for encoder/display discovery"
```

---

## Task 3: Create DeviceProbeClient

**Files:**
- Create: `src/app/client/DeviceProbeClient.ts`

- [ ] **Step 1: Create DeviceProbeClient**

```typescript
// src/app/client/DeviceProbeClient.ts
import { ACTION } from '../../common/Action';
import type { ProbeResult } from '../../common/ProbeResult';

export class DeviceProbeClient {
    /**
     * Probe a device for available encoders and display info.
     * Opens a WebSocket, receives a single JSON message, and closes.
     */
    static probe(udid: string, baseUrl?: { hostname: string; port: number; secure: boolean }): Promise<ProbeResult> {
        return new Promise((resolve, reject) => {
            const host = baseUrl?.hostname || window.location.hostname;
            const port = baseUrl?.port || Number.parseInt(window.location.port, 10) || (baseUrl?.secure ? 443 : 80);
            const protocol = baseUrl?.secure ? 'wss' : 'ws';
            const url = new URL(`${protocol}://${host}:${port}/`);
            url.searchParams.set('action', ACTION.PROBE_DEVICE);
            url.searchParams.set('udid', udid);

            const ws = new WebSocket(url.toString());
            let received = false;

            ws.onmessage = (event) => {
                try {
                    const result: ProbeResult = JSON.parse(event.data as string);
                    received = true;
                    resolve(result);
                } catch (err) {
                    reject(new Error(`Invalid probe response: ${err}`));
                }
            };

            ws.onerror = () => {
                if (!received) reject(new Error('Probe WebSocket error'));
            };

            ws.onclose = (event) => {
                if (!received) reject(new Error(`Probe closed without response: ${event.code}`));
            };
        });
    }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`
Expected: `compiled successfully`

- [ ] **Step 3: Commit**

```bash
git add src/app/client/DeviceProbeClient.ts
git commit -m "feat(sp3-2): add DeviceProbeClient for browser-side probe requests"
```

---

## Task 4: Rewire ConfigureScrcpy to use DeviceProbeClient

**Files:**
- Modify: `src/app/googDevice/client/ConfigureScrcpy.ts`

This is the main integration task. ConfigureScrcpy currently uses StreamReceiverScrcpy (event-driven, connects to multiplexed WS). Replace with DeviceProbeClient (one-shot Promise).

- [ ] **Step 1: Read ConfigureScrcpy.ts completely**

Understand the full file before making changes.

- [ ] **Step 2: Replace imports**

```typescript
// Remove these imports:
import { StreamReceiverScrcpy } from './StreamReceiverScrcpy';
// (and any DisplayCombinedInfo, ClientsStats imports that are only used by StreamReceiver events)

// Add these imports:
import { DeviceProbeClient } from '../../client/DeviceProbeClient';
import type { ProbeResult } from '../../../common/ProbeResult';
```

- [ ] **Step 3: Replace StreamReceiverScrcpy field and initialization**

Remove the `streamReceiver: StreamReceiverScrcpy` field and `createStreamReceiver()` method.

Replace with a probe call in the constructor or init method:

```typescript
// In the constructor, after creating UI, replace createStreamReceiver() with:
this.runProbe();
```

Add new method:

```typescript
private async runProbe(): Promise<void> {
    this.setStatus('Probing...');
    try {
        const result = await DeviceProbeClient.probe(this.udid, {
            hostname: this.params.hostname,
            port: this.params.port,
            secure: this.params.secure,
        });
        this.onProbeResult(result);
    } catch (err) {
        this.setStatus(`Probe failed: ${(err as Error).message}`);
    }
}
```

- [ ] **Step 4: Replace event handlers with onProbeResult**

Remove `attachEventsListeners()`, `detachEventsListeners()`, `onEncoders()`, `onDisplayInfo()`, `onConnected()`, `onDisconnected()`.

Add a single handler:

```typescript
private onProbeResult(result: ProbeResult): void {
    // Populate encoder dropdown with video encoders
    if (this.encoderSelect) {
        this.encoderSelect.innerHTML = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '(default)';
        this.encoderSelect.appendChild(defaultOption);
        for (const encoder of result.videoEncoders) {
            const option = document.createElement('option');
            option.value = encoder;
            option.textContent = encoder;
            this.encoderSelect.appendChild(option);
        }
    }

    // Populate video codec dropdown
    if (this.videoCodecSelect) {
        this.videoCodecSelect.innerHTML = '';
        const codecs = this.detectCodecs(result.videoEncoders);
        for (const codec of codecs) {
            const option = document.createElement('option');
            option.value = codec;
            option.textContent = codec.toUpperCase();
            this.videoCodecSelect.appendChild(option);
        }
    }

    // Populate audio codec dropdown
    if (this.audioCodecSelect) {
        this.audioCodecSelect.innerHTML = '';
        const codecs = this.detectAudioCodecs(result.audioEncoders);
        for (const codec of codecs) {
            const option = document.createElement('option');
            option.value = codec;
            option.textContent = codec.toUpperCase();
            this.audioCodecSelect.appendChild(option);
        }
    }

    this.setStatus('Ready');
    // Enable the Open button
    if (this.okButton) this.okButton.disabled = false;
}

private detectCodecs(encoders: string[]): string[] {
    const codecs: string[] = [];
    if (encoders.some((e) => e.includes('.avc.') || e.includes('.h264.'))) codecs.push('h264');
    if (encoders.some((e) => e.includes('.hevc.'))) codecs.push('h265');
    if (encoders.some((e) => e.includes('.av1.'))) codecs.push('av1');
    return codecs.length ? codecs : ['h264'];
}

private detectAudioCodecs(encoders: string[]): string[] {
    const codecs: string[] = [];
    if (encoders.some((e) => e.includes('.opus.'))) codecs.push('opus');
    if (encoders.some((e) => e.includes('.aac.'))) codecs.push('aac');
    if (encoders.some((e) => e.includes('.flac.'))) codecs.push('flac');
    codecs.push('raw');
    return codecs.length ? codecs : ['opus'];
}
```

- [ ] **Step 5: Add codec dropdown UI elements to createUI**

In the `createUI()` method, add video codec and audio codec dropdowns near the encoder dropdown. Add class fields:

```typescript
private videoCodecSelect?: HTMLSelectElement;
private audioCodecSelect?: HTMLSelectElement;
private encoderSelect?: HTMLSelectElement;
private okButton?: HTMLButtonElement;
```

In createUI, before the encoder dropdown, add:

```typescript
// Video codec selector
const videoCodecLabel = document.createElement('label');
videoCodecLabel.textContent = 'Video codec:';
const videoCodecSelect = document.createElement('select');
this.videoCodecSelect = videoCodecSelect;
videoCodecLabel.appendChild(videoCodecSelect);
body.appendChild(videoCodecLabel);

// Audio codec selector
const audioCodecLabel = document.createElement('label');
audioCodecLabel.textContent = 'Audio codec:';
const audioCodecSelect = document.createElement('select');
this.audioCodecSelect = audioCodecSelect;
audioCodecLabel.appendChild(audioCodecSelect);
body.appendChild(audioCodecLabel);
```

- [ ] **Step 6: Pass codec selections to stream launch**

In the `openStream()` handler (the "Open" button click), add the selected codecs to the URL params that get passed to StreamClientScrcpy.start():

```typescript
// Add selected codecs to the params that build the stream URL
const videoCodec = this.videoCodecSelect?.value || 'h264';
const audioCodec = this.audioCodecSelect?.value || 'opus';
// These will be picked up by StreamClientScrcpy.buildStreamUrl() → ScrcpyOptions
```

Update the params object to include `videoCodec` and `audioCodec` so they flow through to the server's ScrcpyOptions. This may require adding them as URL search params in the hash fragment.

- [ ] **Step 7: Remove StreamReceiverScrcpy release call**

Find and remove any `this.streamReceiver?.release()` or `this.streamReceiver?.stop()` calls in the dispose/close methods.

- [ ] **Step 8: Verify build**

Run: `npm run build:dev 2>&1 | tail -10`
Expected: `compiled successfully`

- [ ] **Step 9: Commit**

```bash
git add src/app/googDevice/client/ConfigureScrcpy.ts
git commit -m "refactor(sp3-2): rewire ConfigureScrcpy to use DeviceProbeClient with codec dropdowns"
```

---

## Task 5: Delete StreamReceiver and StreamReceiverScrcpy

**Files:**
- Delete: `src/app/client/StreamReceiver.ts`
- Delete: `src/app/googDevice/client/StreamReceiverScrcpy.ts`

- [ ] **Step 1: Search for remaining references**

```bash
grep -rn "StreamReceiver" src/ --include="*.ts" | grep -v ".d.ts"
```

Any remaining imports must be removed before deleting the files.

- [ ] **Step 2: Remove remaining imports**

If any files still import StreamReceiver or StreamReceiverScrcpy (other than ConfigureScrcpy which was already updated), remove those imports and any code that depends on them.

Common places to check:
- `src/app/googDevice/client/DeviceTracker.ts` — may import StreamReceiverScrcpy for type references
- `src/app/index.ts` — may import StreamReceiverScrcpy

- [ ] **Step 3: Delete the files**

```bash
git rm src/app/client/StreamReceiver.ts
git rm src/app/googDevice/client/StreamReceiverScrcpy.ts
```

- [ ] **Step 4: Also delete DisplayInfo.ts if orphaned**

Check if `src/app/DisplayInfo.ts` is still used by anything other than StreamReceiver. If it's only used by StreamReceiver (which is being deleted), it can be deleted too. If other code uses it, leave it.

```bash
grep -rn "DisplayInfo" src/ --include="*.ts" | grep -v StreamReceiver | grep -v ".d.ts"
```

- [ ] **Step 5: Verify build**

Run: `npm run build:dev 2>&1 | tail -10`
Expected: `compiled successfully` — no references to deleted files.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(sp3-2): delete StreamReceiver and StreamReceiverScrcpy"
```

---

## Task 6: Smoke test + cleanup

- [ ] **Step 1: Full build**

```bash
npm run build:dev 2>&1 | tail -20
```

Both frontend and backend must compile successfully.

- [ ] **Step 2: Start server and test device list**

```bash
node dist/index.js
```

Open `http://localhost:8000/` — device tracker should load, showing the device with green status.

- [ ] **Step 3: Test Configure stream dialog**

Click "Configure stream" button. The dialog should:
1. Show "Probing..." status
2. Populate the encoder dropdown with real encoder names from the device
3. Show video codec dropdown (H.264, H.265, AV1 based on device)
4. Show audio codec dropdown (Opus, AAC, FLAC, Raw)
5. Show "Ready" status
6. Open button should be enabled

- [ ] **Step 4: Test stream launch**

Click "Open" (or the WebCodecs link directly). Video stream should work as before.

- [ ] **Step 5: Check server logs**

```bash
cat /tmp/ws-scrcpy-server.log
```

Should see `[DeviceProbe] Probing ...` and `[DeviceProbe] Probe result ...` logs when Configure stream is opened.

- [ ] **Step 6: Verify no StreamReceiver references**

```bash
grep -rn "StreamReceiver" src/ --include="*.ts"
```

Expected: No matches.

- [ ] **Step 7: Commit any final fixes**

If smoke testing revealed issues, fix and commit them.
