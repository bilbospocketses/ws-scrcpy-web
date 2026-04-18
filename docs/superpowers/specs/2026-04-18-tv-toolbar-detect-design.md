# TV-vs-Phone/Tablet Detect — Design Spec

**Date:** 2026-04-18
**Project:** ws-scrcpy-web
**Status:** Design approved, ready for implementation plan

## Goal

Auto-detect whether a connected Android device is a **TV**, **tablet**, or **phone** during device attach. Surface the classification two ways in the UI:

1. **Device-kind badge** on each device card, rendered as an icon inside the connect pill (after the "connect" text).
2. **Smarter stream-toolbar default**: when the user opens a stream, the existing D-pad/Touch input-mode toggle initializes to **D-pad** for TVs and **Touch** for phones/tablets. User can still flip it.

No new UI, no new toolbar layout, no change to protocol or input encoding. This is purely a defaults-and-labeling enhancement.

## Why

Pure quality-of-life improvement. Users don't have to think about which input mode to pick per device, and the device grid shows at a glance what's connected. If a user still picks the wrong mode, they RTFM.

## Non-goals

- No new toolbar buttons or layout changes.
- No toolbar D-pad cluster (↑ ↓ ← → OK buttons) — the existing d-pad-mode click-and-scroll behavior is unchanged.
- No user preference overrides or persistence beyond what the existing toggle already does.
- No tablet-specific UI behavior beyond the badge and toggle default (tablet == phone for toolbar purposes today).

## Architecture

Device kind is **fetched server-side once per device attach, cached on the `Device` instance, stored on `GoogDeviceDescriptor.deviceKind`, pushed to the browser via the existing descriptor WebSocket channel, and consumed by the device card (badge) and stream toolbar (input-mode default).**

### Data flow

```
ADB device appears
  → Device.ts constructor (existing)
  → ControlCenter.pollDevices() runs every 5s (existing)
    → For each connected device, in parallel: checkScreenState(), detectDeviceKind()
    → detectDeviceKind() early-returns if descriptor.deviceKind already set
  → First successful detection: descriptor.deviceKind = 'phone' | 'tablet' | 'tv'
  → emitUpdate() (existing throttled emitter)
  → ControlCenter → WebSocket → browser descriptor update (existing channel)

Browser receives updated descriptor
  → DeviceTracker.buildDeviceRow() rebuilds card → renders badge inside connect pill
  → User opens stream → StreamClientScrcpy passes descriptor.deviceKind
    → GoogToolBox.createToolBox() sets input-mode checkbox default + calls setDpadMode()
```

### Design properties

- **Zero new plumbing.** Descriptor already flows end-to-end; we add one field and one server-side detection call.
- **Cached forever per device session.** Device kind doesn't change at runtime. `detectDeviceKind()` short-circuits if `descriptor.deviceKind` is already set.
- **Graceful pre-detect window.** `deviceKind` is optional. Card renders without the badge until first detection completes; re-renders on descriptor update. Stream toolbar falls back to today's behavior (d-pad default) if `deviceKind` is undefined when the stream opens.

## Server-side detection

### New method on `Device.ts`

Add `detectDeviceKind()` to `src/server/goog-device/Device.ts`. It mirrors `checkScreenState` in shape and lifecycle.

```ts
public async detectDeviceKind(): Promise<void> {
    if (this.descriptor.deviceKind) return;  // cached, never re-run
    if (!this.connected) return;

    const [characteristics, leanback, sizeOut, densityOut] = await Promise.all([
        this.runShellCommand('getprop ro.build.characteristics'),
        this.runShellCommand('pm has-feature android.software.leanback'),
        this.runShellCommand('wm size'),
        this.runShellCommand('wm density'),
    ]);

    let kind: 'phone' | 'tablet' | 'tv';
    if (/\btv\b/.test(characteristics) || leanback.trim() === 'true') {
        kind = 'tv';
    } else {
        const { width, height } = parseWmSize(sizeOut);
        const density = parseWmDensity(densityOut);
        if (!width || !height || !density) return;  // retry on next poll
        const smallestPx = Math.min(width, height);
        const smallestDp = smallestPx / (density / 160);
        kind = smallestDp >= 600 ? 'tablet' : 'phone';
    }

    this.descriptor.deviceKind = kind;
    this.emitUpdate();
}
```

### Invocation point

Called from `ControlCenter.pollDevices()` alongside `checkScreenState()` — same 5s loop. Every poll invokes `detectDeviceKind()` on each connected device; the cache guard (`if (this.descriptor.deviceKind) return`) makes all calls after the first successful detection a no-op. This gives us free retries while detection is pending — if the device is slow or momentarily unresponsive on the first poll, the second poll 5s later picks it up.

### Parse helpers — shared module

`DeviceProbe.ts` already contains `parseSize` and `parseDensity`. Extract both to `src/server/goog-device/wmParsers.ts` as pure functions:

```ts
export function parseWmSize(output: string): { width: number; height: number };
export function parseWmDensity(output: string): number;
```

`DeviceProbe.ts` imports from the shared module; `Device.ts` imports from the shared module. Removes duplication, gives us a single source of truth, and makes both callers unit-testable.

### Detection signal rationale

- **`ro.build.characteristics` contains `"tv"`** — set at OEM build time. Reliable on stock Android TV, Google TV, Fire TV, NVIDIA Shield. Word-boundary regex `\btv\b` avoids false matches on `"nosdcard,default"` or other unrelated values.
- **`pm has-feature android.software.leanback`** — official Android TV feature flag used by Play Store and app manifests. Returns `"true"` on TV devices. Belt-and-suspenders with the characteristics check: catches OEM builds that forget to set characteristics correctly.
- **`smallestWidthDp >= 600`** — the official Android `sw600dp` resource qualifier cutoff. Well-tested across the ecosystem. Formula: `min(widthPx, heightPx) / (density / 160)`.

### Failure behavior

If any shell call throws or returns empty/malformed output, `detectDeviceKind()` leaves `deviceKind` undefined. The next `ControlCenter.pollDevices()` tick (5s later) retries automatically — the cache guard only short-circuits once detection has successfully produced a value. Matches how `checkScreenState` handles errors today: no exceptions bubble up, no state pollution.

## Descriptor change

`src/types/GoogDeviceDescriptor.d.ts`:

```ts
export default interface GoogDeviceDescriptor extends BaseDeviceDescriptor {
    // ... existing fields unchanged ...
    'screen.state': 'awake' | 'asleep' | 'unknown';
    deviceKind?: 'phone' | 'tablet' | 'tv';   // NEW, populated on first successful poll
}
```

The optional type honestly captures the pre-detect window. No initialization in the `Device.ts` descriptor constructor block — undefined is the correct initial state.

**No browser-side plumbing changes.** The descriptor is already serialized to JSON and pushed over the existing WebSocket channel (`ControlCenter.ts:79` → `emit('device', descriptor)`). Adding a field arrives on the browser-side typed descriptor automatically.

## Client-side: badge on device card

### Location

Icon rendered **after** the "connect" link text, inside `a.link-stream`. Rendered by `DeviceTracker.updateLink()` in `src/app/googDevice/client/DeviceTracker.ts`, after `appendChild(link)`.

```ts
if (descriptor.deviceKind) {
    const icon = SvgImage.create(iconForKind(descriptor.deviceKind));
    icon.classList.add('kind-icon');
    link.appendChild(icon);
}
```

### New SVG icons

Add three entries to `src/app/ui/SvgImage.ts`:

- `SvgImage.Icon.DEVICE_TV` — rectangular screen with stand
- `SvgImage.Icon.DEVICE_TABLET` — wide slab
- `SvgImage.Icon.DEVICE_PHONE` — narrow slab

Each distinct — not a color variant of one shared icon. Distinct shapes read faster at a glance than a recolor.

Icons use `currentColor` so they inherit the pill's foreground color across both light and dark themes and both blue/secondary button variants.

### CSS

Add to `src/style/devicelist.css`:

```css
a.link-stream .kind-icon {
    margin-left: 6px;
    width: 14px;
    height: 14px;
    vertical-align: middle;
}
```

## Client-side: stream toolbar default

### Signature change

`GoogToolBox.createToolBox` gains a fourth argument:

```ts
public static createToolBox(
    udid: string,
    player: BasePlayer,
    client: StreamClientScrcpy,
    deviceKind: 'phone' | 'tablet' | 'tv' | undefined,
): GoogToolBox
```

### Initial-state logic

```ts
const inputMode = new ToolBoxCheckbox(DPAD_TITLE, {...}, `input_mode_${udid}_${playerName}`);
const startInTouch = deviceKind === 'phone' || deviceKind === 'tablet';
if (startInTouch) {
    inputMode.getElement().checked = true;
    client.setDpadMode(false);
    inputModeLabel.title = TOUCH_TITLE;
}
// TV and undefined fall through to current defaults (d-pad mode).
```

### How deviceKind reaches the toolbar

When ConnectModal or Configure Stream starts the stream client, it already has a reference to the device descriptor via the `DeviceTracker` cache that powers the card. That same descriptor's `deviceKind` field is passed through to `StreamClientScrcpy.startStream` → `setupVideoTag()` → `createToolBox()`. No new fetch, no new round trip.

### What this does NOT change

- The D-pad/Touch toggle itself works exactly as it does today.
- Click/scroll handling in both modes is unchanged.
- KEYCODE plumbing, touch encoding, scroll i16fp encoding are all unchanged.
- A TV user who prefers touch, or a phone user who wants d-pad, still flips the toggle themselves.

## Testing

### New unit tests

**`detectDeviceKind.test.ts`** — pure-logic test with injected shell outputs:

- `characteristics="tv,default"` → `'tv'`
- `characteristics="default"`, `leanback="true\n"` → `'tv'`
- `characteristics="default"`, `leanback="false\n"`, 2560×1600 @ 320dpi → smallestDp=800 → `'tablet'`
- `characteristics="default"`, `leanback="false\n"`, 1080×2400 @ 420dpi → smallestDp≈411 → `'phone'`
- Empty `characteristics`, empty `leanback`, unparseable `wm size` → returns undefined (will retry on next poll)
- Word-boundary check: `characteristics="tablet,nosdcard"` does NOT match as tv
- Caching: second invocation early-returns without calling any shell

**`wmParsers.test.ts`** — for the extracted shared parsers:

- `parseWmSize`: "Override size" takes precedence over "Physical size"; falls back to 1920x1080 on malformed input (matching existing DeviceProbe behavior).
- `parseWmDensity`: "Override density" takes precedence over "Physical density"; falls back to 320 on malformed input.

### No new integration tests

The descriptor → WebSocket → browser path is already exercised by existing runtime behavior (screen.state, model, SDK, etc.). Adding a field doesn't introduce a new integration surface.

### Manual smoke test checklist

Added to the manual test list (not an automated test):

- Connect a TV (Google TV Streamer @ 192.168.86.43:5555). Card shows TV badge in connect pill within a second of attach. Stream opens in D-pad mode by default.
- Connect a phone. Card shows phone badge. Stream opens in Touch mode by default.
- Connect a tablet (≥600dp smallestWidth). Card shows tablet badge. Stream opens in Touch mode by default.
- Flip the toggle on each — verify it still works both directions.
- Disconnect and reconnect — `deviceKind` re-detects on the new session.

### Regression coverage

89/89 existing tests should continue to pass. No protocol changes, no input-encoding changes, no UHID changes. Fragile layers stay untouched.

## Files touched

**New:**

- `src/server/goog-device/wmParsers.ts` — shared parsers extracted from `DeviceProbe`
- `src/test/detectDeviceKind.test.ts`
- `src/test/wmParsers.test.ts`
- Three SVG assets for DEVICE_TV / DEVICE_TABLET / DEVICE_PHONE

**Modified:**

- `src/server/goog-device/Device.ts` — new `detectDeviceKind` method (public so ControlCenter can call it)
- `src/server/goog-device/services/ControlCenter.ts` — invoke `detectDeviceKind()` alongside `checkScreenState()` in `pollDevices()`
- `src/server/DeviceProbe.ts` — swap inline `parseSize`/`parseDensity` for shared imports
- `src/types/GoogDeviceDescriptor.d.ts` — add `deviceKind?: 'phone' | 'tablet' | 'tv'`
- `src/app/googDevice/client/DeviceTracker.ts` — append kind icon to connect link in `updateLink`
- `src/app/googDevice/toolbox/GoogToolBox.ts` — accept `deviceKind` param, set initial toggle state
- `src/app/googDevice/client/StreamClientScrcpy.ts` — pass descriptor.deviceKind to `createToolBox`
- `src/app/ui/SvgImage.ts` — register three new icons
- `src/style/devicelist.css` — `.kind-icon` rule

## Open items

None. All design decisions settled during brainstorm.
