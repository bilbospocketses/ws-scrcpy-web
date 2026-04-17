# ConnectModal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the full stream experience (video, toolbar, audio, UHID, touch) into a native `<dialog>` modal overlay, keeping the home page visible behind the backdrop.

**Architecture:** Thin `ConnectModal extends Modal` + surgical refactor of `StreamClientScrcpy` to accept a `container` parameter. ConnectModal passes `this.bodyEl` as the container. Event listeners stay on `document.body` (events bubble from dialog). CSS scoped under `dialog.connect-modal`.

**Tech Stack:** TypeScript 6.x, native `<dialog>` API, CSS flexbox, Vitest, webpack 5

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/app/googDevice/client/ConnectModal.ts` | Thin Modal subclass — starts stream in bodyEl, stores stop function |
| Modify | `src/app/googDevice/client/StreamClientScrcpy.ts` | Accept container param, return stop function, onDisconnect callback, skip setBodyClass when containerized |
| Modify | `src/app/googDevice/client/ConfigureScrcpy.ts` | `openStream()` creates ConnectModal instead of calling `StreamClientScrcpy.start()` |
| Modify | `src/app/googDevice/client/DeviceTracker.ts` | Intercept "connect" link click → ConnectModal instead of new-tab navigation |
| Modify | `src/app/googDevice/toolbox/GoogMoreBox.ts` | Remove disconnect button |
| Modify | `src/style/modal.css` | Add `dialog.connect-modal` sizing and layout rules |

---

### Task 1: Add ConnectModal CSS to modal.css

**Files:**
- Modify: `src/style/modal.css`

- [ ] **Step 1: Add connect-modal styles to the end of modal.css**

Append after the existing shell modal overrides:

```css
/* ── Connect modal overrides ── */
dialog.connect-modal .modal-frame {
    max-height: 90vh;
    width: auto;
    max-width: 95vw;
}

dialog.connect-modal .modal-body {
    padding: 0;
    display: flex;
    flex-direction: row;
    overflow: hidden;
    background: #000;
}

dialog.connect-modal .device-view {
    display: flex;
    float: none;
}

dialog.connect-modal .video {
    flex: 1;
    float: none;
    max-height: calc(90vh - 2.5rem);
    background: #000;
    position: relative;
}

dialog.connect-modal .video-layer,
dialog.connect-modal .touch-layer {
    max-height: calc(90vh - 2.5rem);
    max-width: none;
}

dialog.connect-modal .control-buttons-list {
    float: none;
    flex-shrink: 0;
}
```

- [ ] **Step 2: Verify file saves correctly**

Run: `ls -la src/style/modal.css`

- [ ] **Step 3: Commit**

```bash
git add src/style/modal.css
git commit -m "feat: add connect-modal CSS rules for stream-in-dialog layout"
```

---

### Task 2: Refactor StreamClientScrcpy to accept a container parameter

**Files:**
- Modify: `src/app/googDevice/client/StreamClientScrcpy.ts`

This is the core refactor. Changes to `start()` and `startStream()` to support rendering into a provided container.

- [ ] **Step 1: Change `start()` signature to accept container and onDisconnect, return stop function**

Replace the current `start()` method (lines 181-189):

```typescript
// Before:
public static start(
    query: URLSearchParams | ParamsStreamScrcpy,
    player?: BasePlayer,
    fitToScreen?: boolean,
    videoSettings?: VideoSettings,
): StreamClientScrcpy {
    const params = query instanceof URLSearchParams ? StreamClientScrcpy.parseParameters(query) : query;
    return new StreamClientScrcpy(params, player, fitToScreen, videoSettings);
}
```

```typescript
// After:
public static start(
    query: URLSearchParams | ParamsStreamScrcpy,
    player?: BasePlayer,
    fitToScreen?: boolean,
    videoSettings?: VideoSettings,
    container?: HTMLElement,
    onDisconnect?: () => void,
): { instance: StreamClientScrcpy; stop: () => void } {
    const params = query instanceof URLSearchParams ? StreamClientScrcpy.parseParameters(query) : query;
    const instance = new StreamClientScrcpy(params, player, fitToScreen, videoSettings, container, onDisconnect);
    return { instance, stop: () => instance.stopStream() };
}
```

- [ ] **Step 2: Update constructor to pass container and onDisconnect through**

Replace the current constructor (lines 191-201):

```typescript
// Before:
protected constructor(
    params: ParamsStreamScrcpy,
    player?: BasePlayer,
    fitToScreen?: boolean,
    videoSettings?: VideoSettings,
) {
    super(params);
    const { udid, player: playerName } = this.params;
    this.startStream({ udid, player, playerName, fitToScreen: fitToScreen ?? params.fitToScreen, videoSettings });
    this.setBodyClass('stream');
}
```

```typescript
// After:
protected constructor(
    params: ParamsStreamScrcpy,
    player?: BasePlayer,
    fitToScreen?: boolean,
    videoSettings?: VideoSettings,
    private readonly container?: HTMLElement,
    private readonly onDisconnectCallback?: () => void,
) {
    super(params);
    const { udid, player: playerName } = this.params;
    this.startStream({ udid, player, playerName, fitToScreen: fitToScreen ?? params.fitToScreen, videoSettings });
    // Only apply body class when NOT in a container (full-page mode / embed mode)
    if (!container) {
        this.setBodyClass('stream');
    }
}
```

- [ ] **Step 3: Add stopStream instance field and method**

Add a `stopFn` field and public `stopStream()` method. Find the existing `stop` closure inside `startStream()` (line 364-376) and store it:

Add field declaration near the other private fields:

```typescript
private stopFn?: () => void;
```

In `startStream()`, after the existing `const stop = (ev?: string | Event) => { ... };` closure (line 364), add:

```typescript
this.stopFn = () => stop();
```

Add the public method after `startStream()`:

```typescript
public stopStream(): void {
    if (this.stopFn) {
        this.stopFn();
        this.stopFn = undefined;
    }
}
```

- [ ] **Step 4: Change DOM appending to use container**

In `startStream()`, replace line 391:

```typescript
// Before:
document.body.appendChild(deviceView);
```

```typescript
// After:
const target = this.container ?? document.body;
target.appendChild(deviceView);
```

- [ ] **Step 5: Add onDisconnect callback to onDisconnected handler**

In the existing `onDisconnected` method (line 324-334), add the callback call at the end:

```typescript
// Before:
public onDisconnected = (): void => {
    this.audioPlayer?.stop();
    this.uhidKeyboard?.detach();
    this.uhidMouse?.detach();
    this.uhidManager?.stop();
    if (!this.isRefreshing) {
        this.touchHandler?.release();
        this.touchHandler = undefined;
    }
};
```

```typescript
// After:
public onDisconnected = (): void => {
    this.audioPlayer?.stop();
    this.uhidKeyboard?.detach();
    this.uhidMouse?.detach();
    this.uhidManager?.stop();
    if (!this.isRefreshing) {
        this.touchHandler?.release();
        this.touchHandler = undefined;
        this.onDisconnectCallback?.();
    }
};
```

Note: the callback only fires when NOT refreshing. During a quality-triggered refresh, the stream reconnects within the same container — we don't want to close the modal.

- [ ] **Step 6: Update callers of start() that use the return value**

The current `start()` returns a `StreamClientScrcpy` instance. After the refactor it returns `{ instance, stop }`. Search for all callers:

Run: `grep -rn "StreamClientScrcpy.start(" src/`

Update any callers that use the return value. The main callers are:
- `ConfigureScrcpy.openStream()` — currently calls `StreamClientScrcpy.start(params, player, fitToScreen, videoSettings)` with no return value capture. No change needed yet (Task 4 will change this to ConnectModal).
- Embed mode / URL-based entry in `src/app/index.ts` — check if it captures the return value.

If `index.ts` uses the return value, update it to destructure `{ instance }` instead.

- [ ] **Step 7: Build and verify**

Run: `npm run build`

Expected: Build succeeds. The embed mode path still works (passes no container, gets `document.body`).

- [ ] **Step 8: Run all tests**

Run: `npm test`

Expected: All 65 tests pass. StreamClientScrcpy isn't directly unit-tested — the changes are validated by build success and manual smoke test.

- [ ] **Step 9: Commit**

```bash
git add src/app/googDevice/client/StreamClientScrcpy.ts
git commit -m "refactor: StreamClientScrcpy accepts container param, returns stop function"
```

---

### Task 3: Create ConnectModal

**Files:**
- Create: `src/app/googDevice/client/ConnectModal.ts`

- [ ] **Step 1: Create the ConnectModal class**

```typescript
import type { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import type BasePlayer from '../../player/BasePlayer';
import type VideoSettings from '../../VideoSettings';
import { Modal } from '../../ui/Modal';
import { StreamClientScrcpy } from './StreamClientScrcpy';

export class ConnectModal extends Modal {
    private stopStream?: () => void;

    constructor(
        params: ParamsStreamScrcpy,
        player: BasePlayer,
        fitToScreen: boolean,
        videoSettings: VideoSettings,
        deviceLabel: string,
    ) {
        super({ title: deviceLabel });
        this.dialog.classList.add('connect-modal');

        const { stop } = StreamClientScrcpy.start(
            params, player, fitToScreen, videoSettings,
            this.bodyEl,
            () => this.close(),
        );
        this.stopStream = stop;
    }

    protected buildBody(_container: HTMLElement): void {
        // Empty — StreamClientScrcpy populates the container after super() completes
    }

    protected onEscapeKey(_event: Event): void {
        // Block — UHID keyboard capture needs Escape
    }

    protected onBackdropClick(_event: MouseEvent): void {
        // Block — protect stream from accidental close
    }

    protected onBeforeClose(): void {
        this.stopStream?.();
    }
}
```

- [ ] **Step 2: Verify imports resolve**

Run: `npm run build`

Expected: Build succeeds. ConnectModal is created but not yet used by any entry point.

- [ ] **Step 3: Commit**

```bash
git add src/app/googDevice/client/ConnectModal.ts
git commit -m "feat: add ConnectModal — stream experience in native <dialog>"
```

---

### Task 4: Wire ConfigureScrcpy "connect" button to ConnectModal

**Files:**
- Modify: `src/app/googDevice/client/ConfigureScrcpy.ts`

- [ ] **Step 1: Update imports**

Add import for ConnectModal at the top of ConfigureScrcpy.ts:

```typescript
import { ConnectModal } from './ConnectModal';
```

- [ ] **Step 2: Update openStream() to create ConnectModal**

Replace the end of the `openStream` method. Currently (lines 652-668):

```typescript
// Before:
this.close(true);

const player = StreamClientScrcpy.createPlayer(playerName, udid, displayInfo);
if (!player) {
    return;
}
player.setVideoSettings(videoSettings, fitToScreen, false);
const params: ParamsStreamScrcpy = {
    ...this.params,
    udid,
    fitToScreen,
    videoCodec,
    audioCodec,
    encoderName,
};
StreamClientScrcpy.start(params, player, fitToScreen, videoSettings);
```

```typescript
// After:
const player = StreamClientScrcpy.createPlayer(playerName, udid, displayInfo);
if (!player) {
    return;
}
player.setVideoSettings(videoSettings, fitToScreen, false);
const params: ParamsStreamScrcpy = {
    ...this.params,
    udid,
    fitToScreen,
    videoCodec,
    audioCodec,
    encoderName,
};

// Get the device label from the modal header before closing
const titleEl = this.dialog.querySelector('.modal-title');
const deviceLabel = titleEl?.textContent || udid;

this.close(true);

new ConnectModal(params, player, fitToScreen, videoSettings, deviceLabel);
```

Note: player creation and params building happen BEFORE `this.close(true)` (which was already the case). The ConnectModal is created AFTER close so we get the two-step transition: configure closes, connect opens.

- [ ] **Step 3: Build and verify**

Run: `npm run build`

Expected: Build succeeds.

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: All 65 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/googDevice/client/ConfigureScrcpy.ts
git commit -m "feat: configure stream 'connect' button opens ConnectModal"
```

---

### Task 5: Wire direct "connect" link to ConnectModal

**Files:**
- Modify: `src/app/googDevice/client/DeviceTracker.ts`

The "connect" link is currently an `<a>` tag with `target="_blank"` that navigates to a new page. We need to intercept the click and open a ConnectModal instead, same pattern as the shell link intercept.

- [ ] **Step 1: Add imports**

Add imports at the top of DeviceTracker.ts:

```typescript
import { ConnectModal } from './ConnectModal';
```

Also ensure these are imported (they may already be):

```typescript
import { StreamClientScrcpy } from './StreamClientScrcpy';
```

- [ ] **Step 2: Intercept connect link clicks**

In the `buildDeviceRow` method, after the existing shell link intercept block (around line 279), add a connect link intercept. Find the end of the shell intercept block and add after it:

```typescript
// Intercept connect links — open ConnectModal instead of navigating to new tab
const connectLinks = overlaySection.querySelectorAll(`a.link-${ACTION.STREAM_SCRCPY}`) as NodeListOf<HTMLAnchorElement>;
connectLinks.forEach((link) => {
    link.removeAttribute('target');
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const href = link.getAttribute('href');
        if (!href) return;
        const url = new URL(href, location.origin);
        const hash = url.hash.startsWith('#!') ? url.hash.slice(2) : url.hash.slice(1);
        const query = new URLSearchParams(hash);
        const params = StreamClientScrcpy.parseParameters(query);

        const nameEl = link.closest('.device')?.querySelector('.device-name-text');
        const label = nameEl?.textContent || device['ro.product.model'] || device.udid;

        // Auto-detect codec/encoder and open ConnectModal
        const playerClass = StreamClientScrcpy.getPlayers()[0];
        if (!playerClass) return;
        const player = StreamClientScrcpy.createPlayer(playerClass.playerFullName, device.udid);
        if (!player) return;

        const videoSettings = player.getVideoSettings();
        const fitToScreen = playerClass.getFitToScreenStatus(device.udid);
        player.setVideoSettings(videoSettings, fitToScreen, false);

        new ConnectModal(params, player, fitToScreen, videoSettings, label);
    });
});
```

Note: This code runs inside `buildDeviceRow` which has `device` (the descriptor) in scope. The connect links are created by `updateLink()` which adds `a.link-stream_scrcpy` anchors. The intercept must happen AFTER `updateLink()` is called (line 299), so place this block after line 306 (after the `updateLink` call).

Wait — there's a timing issue. `updateLink()` is called at the end of `buildDeviceRow()` (line 298-306), and it creates the `<a>` elements inside the `playerTds` divs. The intercept needs to run after `updateLink` creates the links. Since both happen in `buildDeviceRow`, the intercept code should go after the `updateLink` call.

However, `updateLink` uses `getElementsByName` which queries the live DOM, and the elements must already be in the document. The `tbody.appendChild(row)` happens at line 295 — before `updateLink`. So the links exist by line 306. Place the intercept block after line 306.

- [ ] **Step 3: Build and verify**

Run: `npm run build`

Expected: Build succeeds.

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: All 65 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/googDevice/client/DeviceTracker.ts
git commit -m "feat: direct connect link opens ConnectModal instead of new tab"
```

---

### Task 6: Remove disconnect button from GoogMoreBox

**Files:**
- Modify: `src/app/googDevice/toolbox/GoogMoreBox.ts`

- [ ] **Step 1: Remove the disconnect button creation**

In `GoogMoreBox.ts`, find and remove the disconnect button code (lines 237-241):

```typescript
// Remove these lines:
const stopBtn = document.createElement('button') as HTMLButtonElement;
stopBtn.innerText = 'Disconnect';
stopBtn.onclick = stop;

GoogMoreBox.wrap('p', [stopBtn], moreBox);
```

Keep the `stop` closure itself (lines 222-235) — it's still used as the `setOnStop` callback for cleanup when the stream stops. Just remove the button that triggers it via click.

- [ ] **Step 2: Build and verify**

Run: `npm run build`

Expected: Build succeeds.

- [ ] **Step 3: Run tests**

Run: `npm test`

Expected: All 65 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/app/googDevice/toolbox/GoogMoreBox.ts
git commit -m "refactor: remove disconnect button from more-box (X button is disconnect)"
```

---

### Task 7: Manual integration test

**Files:** None — manual verification only.

- [ ] **Step 1: Full build from clean state**

Run: `rm -rf dist && npm run build`

- [ ] **Step 2: Start the server**

Kill any existing process on port 8000, then:
Run: `node dist/index.js`

- [ ] **Step 3: Test configure stream → connect modal flow**

Open `http://localhost:8000`. Click "configure stream" on a device card:
- [ ] Configure modal opens with device label as title
- [ ] Pick codec/encoder settings, click "connect"
- [ ] Configure modal closes
- [ ] ConnectModal opens with device label as title
- [ ] Video stream appears inside the modal
- [ ] Toolbar visible on the right side
- [ ] Toolbar buttons work (volume, power, back, home, d-pad toggle, stats, refresh)
- [ ] More-box opens when "more" checkbox is toggled
- [ ] More-box does NOT have a disconnect button
- [ ] Escape key does NOT close the modal
- [ ] Clicking backdrop does NOT close the modal
- [ ] X button closes the modal — stream disconnects
- [ ] Home page device list is visible and intact after closing
- [ ] Modal has open/close CSS animations

- [ ] **Step 4: Test direct connect flow**

Click "connect" on a device card:
- [ ] ConnectModal opens directly (no configure step)
- [ ] Stream auto-detects codec/encoder and starts playing
- [ ] All toolbar functionality works
- [ ] X button disconnects and closes

- [ ] **Step 5: Test embed mode still works**

Open `http://localhost:8000/#!action=stream_scrcpy&udid=<device>&player=WebCodecsPlayer&ws=<url>&embed=true` in a new tab:
- [ ] Full-page stream (no modal, no home page)
- [ ] `body.stream.embed` classes applied
- [ ] Video fills viewport
- [ ] Toolbar hidden (embed mode)

- [ ] **Step 6: Test edge cases**

- [ ] Open configure → connect → close → open configure again (no stale state)
- [ ] Open connect → device disconnects → modal auto-closes
- [ ] Light theme toggle works with stream modal open
- [ ] Resize browser window while stream modal is open — video scales correctly

- [ ] **Step 7: Run full test suite one final time**

Run: `npm test`

Expected: All 65 tests pass.
