# TV-vs-Phone/Tablet Detect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect Android device kind (phone / tablet / tv) on connect, surface as a badge in the connect pill on each device card, and initialize the stream's D-pad/Touch toggle to the appropriate default (D-pad for TV, Touch for phone/tablet).

**Architecture:** Server-side detection lives on `Device.ts`, invoked from `ControlCenter.pollDevices()`'s existing 5s poll loop. Result is cached on the `GoogDeviceDescriptor` and pushed to browsers over the existing WebSocket channel. Browser renders the badge in `DeviceTracker.updateLink` and passes `deviceKind` through `ConnectModal` → `startStream` → `StreamClientScrcpy` → `GoogToolBox.createToolBox` to seed the input-mode toggle.

**Tech Stack:** TypeScript 6.x, Node.js 24, vitest, webpack 5, ws WebSocket, ADB shell.

**Spec:** `docs/superpowers/specs/2026-04-18-tv-toolbar-detect-design.md`

**Test command (anywhere in this plan):**

```bash
npm run test
```

Tests colocate in `__tests__/` folders next to source (project convention). All tests run through `vitest run`.

---

## File Structure

**New files:**

- `src/server/goog-device/wmParsers.ts` — pure parsers for `wm size` / `wm density` shell output (extracted from `DeviceProbe`)
- `src/server/goog-device/__tests__/wmParsers.test.ts` — unit tests
- `src/server/goog-device/deviceKind.ts` — pure classification function (takes raw shell outputs, returns kind)
- `src/server/goog-device/__tests__/deviceKind.test.ts` — unit tests
- `src/public/images/buttons/device_tv.svg` — TV icon (rectangle + stand)
- `src/public/images/buttons/device_tablet.svg` — tablet icon (wide slab)
- `src/public/images/buttons/device_phone.svg` — phone icon (narrow slab)

**Modified files:**

- `src/types/GoogDeviceDescriptor.d.ts` — add `deviceKind?: 'phone' | 'tablet' | 'tv'`
- `src/server/DeviceProbe.ts` — swap inline parsers for shared imports
- `src/server/goog-device/Device.ts` — add public `detectDeviceKind()` method
- `src/server/goog-device/services/ControlCenter.ts` — call `detectDeviceKind()` alongside `checkScreenState()` in `pollDevices()`
- `src/app/ui/SvgImage.ts` — register three new icons
- `src/app/googDevice/client/DeviceTracker.ts` — append kind icon in `updateLink`; pass `deviceKind` when constructing `ConnectModal`
- `src/app/googDevice/client/ConnectModal.ts` — accept `deviceKind` constructor arg, forward to `startStream`
- `src/app/public/types.ts` — add `deviceKind?: 'phone' | 'tablet' | 'tv'` to `StartStreamOptions`
- `src/app/public/startStream.ts` — pass `deviceKind` through to `StreamClientScrcpy.startStream`
- `src/app/googDevice/client/StreamClientScrcpy.ts` — add `deviceKind` to `StartParams`, thread to `GoogToolBox.createToolBox`
- `src/app/googDevice/toolbox/GoogToolBox.ts` — accept `deviceKind`, set initial toggle state for phone/tablet
- `src/style/devicelist.css` — `.kind-icon` rule
- `CHANGELOG.md` — entry for this feature

---

## Task 1: Extract wm parsers to shared module

**Why first:** `DeviceProbe.ts` has inline `parseSize` / `parseDensity`. Detection logic needs the same parsers. Extract, test, refactor existing consumer — no behavior change, fully TDD.

**Files:**
- Create: `src/server/goog-device/wmParsers.ts`
- Create: `src/server/goog-device/__tests__/wmParsers.test.ts`
- Modify: `src/server/DeviceProbe.ts`

**Design note:** existing `DeviceProbe.parseSize` returns `{ width: 1920, height: 1080 }` on malformed input; `parseDensity` returns `320`. We preserve that behavior for `DeviceProbe` callers but ALSO expose strict variants (`parseWmSizeStrict` / `parseWmDensityStrict`) that return `undefined` on malformed input so detection can skip that round and retry.

- [ ] **Step 1.1: Write failing tests for shared parsers**

Create `src/server/goog-device/__tests__/wmParsers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
    parseWmSize,
    parseWmSizeStrict,
    parseWmDensity,
    parseWmDensityStrict,
} from '../wmParsers';

describe('parseWmSizeStrict', () => {
    it('parses Physical size', () => {
        expect(parseWmSizeStrict('Physical size: 1080x2400')).toEqual({ width: 1080, height: 2400 });
    });
    it('prefers Override size over Physical size', () => {
        const out = 'Physical size: 1080x2400\nOverride size: 720x1600';
        expect(parseWmSizeStrict(out)).toEqual({ width: 720, height: 1600 });
    });
    it('returns undefined on malformed input', () => {
        expect(parseWmSizeStrict('garbage')).toBeUndefined();
        expect(parseWmSizeStrict('')).toBeUndefined();
    });
});

describe('parseWmSize', () => {
    it('falls back to 1920x1080 on malformed input', () => {
        expect(parseWmSize('garbage')).toEqual({ width: 1920, height: 1080 });
    });
    it('parses valid input the same as strict', () => {
        expect(parseWmSize('Physical size: 1080x2400')).toEqual({ width: 1080, height: 2400 });
    });
});

describe('parseWmDensityStrict', () => {
    it('parses Physical density', () => {
        expect(parseWmDensityStrict('Physical density: 420')).toBe(420);
    });
    it('prefers Override density over Physical density', () => {
        const out = 'Physical density: 420\nOverride density: 320';
        expect(parseWmDensityStrict(out)).toBe(320);
    });
    it('returns undefined on malformed input', () => {
        expect(parseWmDensityStrict('garbage')).toBeUndefined();
    });
});

describe('parseWmDensity', () => {
    it('falls back to 320 on malformed input', () => {
        expect(parseWmDensity('garbage')).toBe(320);
    });
});
```

- [ ] **Step 1.2: Run tests, expect failure (module does not exist)**

```bash
npm run test -- src/server/goog-device/__tests__/wmParsers.test.ts
```

Expected: FAIL with "Cannot find module '../wmParsers'"

- [ ] **Step 1.3: Implement `wmParsers.ts`**

Create `src/server/goog-device/wmParsers.ts`:

```ts
export function parseWmSizeStrict(output: string): { width: number; height: number } | undefined {
    const override = output.match(/Override size:\s*(\d+)x(\d+)/);
    if (override) {
        return { width: Number.parseInt(override[1], 10), height: Number.parseInt(override[2], 10) };
    }
    const physical = output.match(/Physical size:\s*(\d+)x(\d+)/);
    if (physical) {
        return { width: Number.parseInt(physical[1], 10), height: Number.parseInt(physical[2], 10) };
    }
    return undefined;
}

export function parseWmSize(output: string): { width: number; height: number } {
    return parseWmSizeStrict(output) ?? { width: 1920, height: 1080 };
}

export function parseWmDensityStrict(output: string): number | undefined {
    const match = output.match(/(?:Override|Physical) density:\s*(\d+)/);
    return match ? Number.parseInt(match[1], 10) : undefined;
}

export function parseWmDensity(output: string): number {
    return parseWmDensityStrict(output) ?? 320;
}
```

- [ ] **Step 1.4: Run tests, expect pass**

```bash
npm run test -- src/server/goog-device/__tests__/wmParsers.test.ts
```

Expected: all tests pass.

- [ ] **Step 1.5: Refactor `DeviceProbe.ts` to use shared parsers**

In `src/server/DeviceProbe.ts`:

1. At the top of the file, add:
   ```ts
   import { parseWmSize, parseWmDensity } from './goog-device/wmParsers';
   ```
2. Delete the private `parseSize` method (lines 80–90).
3. Delete the private `parseDensity` method (lines 92–95).
4. In `probe()`, replace:
   ```ts
   const { width, height } = this.parseSize(sizeOutput);
   const density = this.parseDensity(densityOutput);
   ```
   with:
   ```ts
   const { width, height } = parseWmSize(sizeOutput);
   const density = parseWmDensity(densityOutput);
   ```

- [ ] **Step 1.6: Run full test suite, expect all tests pass**

```bash
npm run test
```

Expected: all existing tests plus the new wmParsers tests pass.

- [ ] **Step 1.7: Commit**

```bash
git add src/server/goog-device/wmParsers.ts \
        src/server/goog-device/__tests__/wmParsers.test.ts \
        src/server/DeviceProbe.ts
git commit -m "refactor(wm): extract wm size/density parsers to shared module"
```

---

## Task 2: Add `deviceKind` to descriptor type

**Why now:** One-line type change. All subsequent tasks that reference `descriptor.deviceKind` need this to compile.

**Files:**
- Modify: `src/types/GoogDeviceDescriptor.d.ts`

- [ ] **Step 2.1: Add field to descriptor interface**

In `src/types/GoogDeviceDescriptor.d.ts`, add the new line after `'screen.state'`:

```ts
export default interface GoogDeviceDescriptor extends BaseDeviceDescriptor {
    'ro.build.version.release': string;
    'ro.build.version.sdk': string;
    'ro.product.cpu.abi': string;
    'ro.product.manufacturer': string;
    'ro.product.model': string;
    'ro.serialno': string;
    'wifi.interface': string;
    interfaces: NetInterface[];
    pid: number;
    'last.update.timestamp': number;
    'screen.state': 'awake' | 'asleep' | 'unknown';
    deviceKind?: 'phone' | 'tablet' | 'tv';
}
```

- [ ] **Step 2.2: Run typecheck, expect pass**

```bash
npx tsc --noEmit
```

Expected: 0 errors. The field is optional, so existing descriptor initialization in `Device.ts` remains valid.

- [ ] **Step 2.3: Commit**

```bash
git add src/types/GoogDeviceDescriptor.d.ts
git commit -m "types: add optional deviceKind to GoogDeviceDescriptor"
```

---

## Task 3: Pure classification function `deviceKind.ts`

**Why pure:** The Android-specific detection logic has no dependency on `Device` internals — it maps four shell-output strings to a device kind. Pure function means we can unit-test exhaustively without mocking `Device` or `AdbClient`.

**Files:**
- Create: `src/server/goog-device/deviceKind.ts`
- Create: `src/server/goog-device/__tests__/deviceKind.test.ts`

- [ ] **Step 3.1: Write failing tests for classifier**

Create `src/server/goog-device/__tests__/deviceKind.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyDeviceKind } from '../deviceKind';

describe('classifyDeviceKind', () => {
    it('classifies TV from ro.build.characteristics', () => {
        expect(classifyDeviceKind('tv,default', 'false', 'Physical size: 1920x1080', 'Physical density: 320')).toBe('tv');
    });

    it('classifies TV from pm has-feature leanback even when characteristics say default', () => {
        expect(classifyDeviceKind('default', 'true\n', 'Physical size: 1920x1080', 'Physical density: 320')).toBe('tv');
    });

    it('classifies tablet at smallestWidthDp >= 600', () => {
        // 2560x1600 @ 320dpi → smallestDp = min(2560,1600)/2 = 800
        expect(classifyDeviceKind('default', 'false', 'Physical size: 2560x1600', 'Physical density: 320')).toBe('tablet');
    });

    it('classifies phone at smallestWidthDp < 600', () => {
        // 1080x2400 @ 420dpi → smallestDp = 1080/(420/160) ≈ 411
        expect(classifyDeviceKind('default', 'false', 'Physical size: 1080x2400', 'Physical density: 420')).toBe('phone');
    });

    it('does not false-positive on "tablet" in characteristics', () => {
        // Word boundary: "tablet,nosdcard" must not match the tv regex
        expect(classifyDeviceKind('tablet,nosdcard', 'false', 'Physical size: 1080x2400', 'Physical density: 420')).toBe('phone');
    });

    it('does not false-positive on values containing "tv" as substring', () => {
        // "notv" or "stv" should not match — \btv\b word boundary
        expect(classifyDeviceKind('notv,default', 'false', 'Physical size: 1080x2400', 'Physical density: 420')).toBe('phone');
    });

    it('returns undefined on empty characteristics + empty leanback + unparseable wm output', () => {
        expect(classifyDeviceKind('', '', 'garbage', 'garbage')).toBeUndefined();
    });

    it('treats trailing whitespace in leanback output correctly', () => {
        expect(classifyDeviceKind('default', '  true  \r\n', 'Physical size: 1080x2400', 'Physical density: 420')).toBe('tv');
    });

    it('handles boundary case smallestWidthDp === 600 as tablet', () => {
        // 600dp @ 160dpi = 600px smallest side. Use 600x1200 @ 160dpi
        expect(classifyDeviceKind('default', 'false', 'Physical size: 600x1200', 'Physical density: 160')).toBe('tablet');
    });
});
```

- [ ] **Step 3.2: Run tests, expect failure**

```bash
npm run test -- src/server/goog-device/__tests__/deviceKind.test.ts
```

Expected: FAIL with "Cannot find module '../deviceKind'"

- [ ] **Step 3.3: Implement `deviceKind.ts`**

Create `src/server/goog-device/deviceKind.ts`:

```ts
import { parseWmSizeStrict, parseWmDensityStrict } from './wmParsers';

export type DeviceKind = 'phone' | 'tablet' | 'tv';

/**
 * Classify an Android device as phone, tablet, or tv using four shell outputs.
 * Returns undefined when the inputs are insufficient to decide (e.g., all parsers fail),
 * so callers can retry on the next poll instead of committing a wrong answer.
 */
export function classifyDeviceKind(
    characteristics: string,
    leanback: string,
    wmSize: string,
    wmDensity: string,
): DeviceKind | undefined {
    if (/\btv\b/.test(characteristics) || leanback.trim() === 'true') {
        return 'tv';
    }
    const size = parseWmSizeStrict(wmSize);
    const density = parseWmDensityStrict(wmDensity);
    if (!size || !density) {
        return undefined;
    }
    const smallestDp = Math.min(size.width, size.height) / (density / 160);
    return smallestDp >= 600 ? 'tablet' : 'phone';
}
```

- [ ] **Step 3.4: Run tests, expect pass**

```bash
npm run test -- src/server/goog-device/__tests__/deviceKind.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add src/server/goog-device/deviceKind.ts \
        src/server/goog-device/__tests__/deviceKind.test.ts
git commit -m "feat(detect): pure classifyDeviceKind function for phone/tablet/tv"
```

---

## Task 4: Add `detectDeviceKind()` to `Device.ts`

**Why:** This is the thin wrapper that runs the four shell calls in parallel, passes outputs to `classifyDeviceKind`, caches the result on `descriptor.deviceKind`, and emits an update.

**Files:**
- Modify: `src/server/goog-device/Device.ts`

- [ ] **Step 4.1: Add method to `Device.ts`**

In `src/server/goog-device/Device.ts`, add to the imports at the top:

```ts
import { classifyDeviceKind } from './deviceKind';
```

Then add the following method adjacent to `checkScreenState` (around line 350):

```ts
public async detectDeviceKind(): Promise<void> {
    if (this.descriptor.deviceKind) return;
    if (!this.connected) return;
    try {
        const [characteristics, leanback, sizeOut, densityOut] = await Promise.all([
            this.runShellCommand('getprop ro.build.characteristics'),
            this.runShellCommand('pm has-feature android.software.leanback'),
            this.runShellCommand('wm size'),
            this.runShellCommand('wm density'),
        ]);
        const kind = classifyDeviceKind(characteristics, leanback, sizeOut, densityOut);
        if (kind) {
            this.descriptor.deviceKind = kind;
            this.emitUpdate();
        }
    } catch {
        // Device temporarily unreachable — next poll retries
    }
}
```

- [ ] **Step 4.2: Run typecheck, expect pass**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4.3: Run tests, expect pass**

```bash
npm run test
```

Expected: all existing tests plus the earlier deviceKind / wmParsers tests pass. No test directly hits `detectDeviceKind` — the logic is covered via `classifyDeviceKind` unit tests.

- [ ] **Step 4.4: Commit**

```bash
git add src/server/goog-device/Device.ts
git commit -m "feat(device): add detectDeviceKind method with cache guard"
```

---

## Task 5: Invoke `detectDeviceKind()` from `ControlCenter.pollDevices()`

**Files:**
- Modify: `src/server/goog-device/services/ControlCenter.ts`

- [ ] **Step 5.1: Extend the screen-state polling block**

In `src/server/goog-device/services/ControlCenter.ts`, locate the block at lines 66–70:

```ts
// Poll screen state for all connected devices (concurrent)
const screenChecks = Array.from(this.deviceMap.values())
    .filter((d) => d.isConnected())
    .map((d) => d.checkScreenState());
await Promise.all(screenChecks);
```

Replace with:

```ts
// Poll screen state + device kind for all connected devices (concurrent)
const connected = Array.from(this.deviceMap.values()).filter((d) => d.isConnected());
const checks: Promise<void>[] = [];
for (const d of connected) {
    checks.push(d.checkScreenState());
    checks.push(d.detectDeviceKind());
}
await Promise.all(checks);
```

- [ ] **Step 5.2: Run typecheck, expect pass**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 5.3: Run tests, expect pass**

```bash
npm run test
```

Expected: all tests pass. (No existing test mocks ControlCenter.pollDevices; this is covered by manual smoke test at the end.)

- [ ] **Step 5.4: Commit**

```bash
git add src/server/goog-device/services/ControlCenter.ts
git commit -m "feat(controlcenter): poll detectDeviceKind alongside screen state"
```

---

## Task 6: Add three device-kind SVG icons

**Why:** The icons must exist and be registered in `SvgImage` before `DeviceTracker` can reference them.

**Files:**
- Create: `src/public/images/buttons/device_tv.svg`
- Create: `src/public/images/buttons/device_tablet.svg`
- Create: `src/public/images/buttons/device_phone.svg`
- Modify: `src/app/ui/SvgImage.ts`

**Design note:** All three icons use `fill="currentColor"` and `stroke="currentColor"` so they inherit the pill's foreground color across themes.

- [ ] **Step 6.1: Create TV icon**

Create `src/public/images/buttons/device_tv.svg`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="5" width="20" height="12" rx="1.5" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
</svg>
```

- [ ] **Step 6.2: Create tablet icon**

Create `src/public/images/buttons/device_tablet.svg`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
    <line x1="11" y1="17.5" x2="13" y2="17.5" />
</svg>
```

- [ ] **Step 6.3: Create phone icon**

Create `src/public/images/buttons/device_phone.svg`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="7" y="2" width="10" height="20" rx="1.5" />
    <line x1="11" y1="19" x2="13" y2="19" />
</svg>
```

- [ ] **Step 6.4: Register icons in `SvgImage.ts`**

In `src/app/ui/SvgImage.ts`:

1. Add imports at the top (alphabetical with existing `buttons/` imports):

```ts
import DevicePhoneSVG from '../../public/images/buttons/device_phone.svg';
import DeviceTabletSVG from '../../public/images/buttons/device_tablet.svg';
import DeviceTvSVG from '../../public/images/buttons/device_tv.svg';
```

2. Add enum entries at the bottom of the `Icon` enum (continuing the numbering after `CLIPBOARD_SET = 21`):

```ts
export enum Icon {
    // ... existing entries unchanged ...
    CLIPBOARD_GET = 20,
    CLIPBOARD_SET = 21,
    DEVICE_TV = 22,
    DEVICE_TABLET = 23,
    DEVICE_PHONE = 24,
}
```

3. Add cases to the `getSvgString` switch (just before `default`):

```ts
case Icon.DEVICE_TV:
    return DeviceTvSVG;
case Icon.DEVICE_TABLET:
    return DeviceTabletSVG;
case Icon.DEVICE_PHONE:
    return DevicePhoneSVG;
```

- [ ] **Step 6.5: Run typecheck, expect pass**

```bash
npx tsc --noEmit
```

Expected: 0 errors. (Ambient `*.svg` declaration already exists from Track A Phase 1a.)

- [ ] **Step 6.6: Run webpack build, expect clean**

```bash
npx webpack --config webpack/index.ts
```

Expected: build completes with no errors and no new warnings.

- [ ] **Step 6.7: Commit**

```bash
git add src/public/images/buttons/device_tv.svg \
        src/public/images/buttons/device_tablet.svg \
        src/public/images/buttons/device_phone.svg \
        src/app/ui/SvgImage.ts
git commit -m "feat(icons): add device_tv/device_tablet/device_phone SVGs"
```

---

## Task 7: Render badge in connect pill on device card

**Files:**
- Modify: `src/app/googDevice/client/DeviceTracker.ts`
- Modify: `src/style/devicelist.css`

- [ ] **Step 7.1: Add `kind-icon` CSS rule**

In `src/style/devicelist.css`, append:

```css
a.link-stream .kind-icon {
    margin-left: 6px;
    width: 14px;
    height: 14px;
    vertical-align: middle;
}
```

- [ ] **Step 7.2: Append icon inside `updateLink`**

In `src/app/googDevice/client/DeviceTracker.ts`:

1. Add import at the top:

```ts
import SvgImage from '../../ui/SvgImage';
```

2. Add a private helper method to the class (near the top of the class body, above `updateLink`):

```ts
private static iconForKind(kind: 'phone' | 'tablet' | 'tv' | undefined) {
    switch (kind) {
        case 'tv': return SvgImage.Icon.DEVICE_TV;
        case 'tablet': return SvgImage.Icon.DEVICE_TABLET;
        case 'phone': return SvgImage.Icon.DEVICE_PHONE;
        default: return undefined;
    }
}
```

3. In `updateLink` (lines 60–88), modify the signature to receive the descriptor (so we know its deviceKind) and append the icon after `item.appendChild(link);`. Replace the existing `updateLink` with:

```ts
private updateLink(params: { url: string; name: string; fullName: string; udid: string; deviceKind?: 'phone' | 'tablet' | 'tv' }): void {
    const { url, name, fullName, udid, deviceKind } = params;
    const playerTds = document.getElementsByName(
        encodeURIComponent(`${DeviceTracker.AttributePrefixPlayerFor}${fullName}`),
    );
    if (typeof udid !== 'string') {
        return;
    }
    const action = ACTION.STREAM_SCRCPY;
    playerTds.forEach((item) => {
        item.innerHTML = '';
        const playerFullName = item.getAttribute(DeviceTracker.AttributePlayerFullName);
        const playerCodeName = item.getAttribute(DeviceTracker.AttributePlayerCodeName);
        if (!playerFullName || !playerCodeName) {
            return;
        }
        const link = DeviceTracker.buildLink(
            {
                action,
                udid,
                player: decodeURIComponent(playerCodeName),
                ws: url,
            },
            decodeURIComponent(playerFullName),
            this.params,
        );
        item.appendChild(link);
        const iconType = DeviceTracker.iconForKind(deviceKind);
        if (iconType !== undefined) {
            const icon = SvgImage.create(iconType);
            icon.classList.add('kind-icon');
            link.appendChild(icon);
        }
    });
}
```

4. Update the call site at line 299 (inside `buildDeviceRow`) to pass `deviceKind`:

```ts
this.updateLink({
    url: selectedInterfaceUrl,
    name,
    fullName,
    udid: device.udid,
    deviceKind: device.deviceKind,
});
```

- [ ] **Step 7.3: Run typecheck, expect pass**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 7.4: Manual visual check**

Start the server:

```bash
npm run build && node dist/index.js
```

Open http://localhost:8000, connect a TV, confirm the TV icon appears after "WebCodecs" in the connect pill.

**Expected:** TV badge visible. If no device is connected yet, page shows no cards — connect a device and verify the badge appears shortly after detection completes (≤ 5s, the ControlCenter poll interval).

- [ ] **Step 7.5: Commit**

```bash
git add src/app/googDevice/client/DeviceTracker.ts src/style/devicelist.css
git commit -m "feat(card): render device-kind badge inside connect pill"
```

---

## Task 8: Plumb `deviceKind` through ConnectModal → startStream → StreamClientScrcpy

**Why:** The stream toolbar needs `deviceKind` to pick the right input-mode default. The public `startStream` API gets an optional `deviceKind` so external consumers can pass it too.

**Files:**
- Modify: `src/app/public/types.ts`
- Modify: `src/app/public/startStream.ts`
- Modify: `src/app/googDevice/client/ConnectModal.ts`
- Modify: `src/app/googDevice/client/DeviceTracker.ts`
- Modify: `src/app/googDevice/client/StreamClientScrcpy.ts`

- [ ] **Step 8.1: Add `deviceKind` to `StartStreamOptions`**

In `src/app/public/types.ts`, add to the `StartStreamOptions` interface:

```ts
/**
 * Android device kind. When provided, seeds the stream toolbar's
 * D-pad/Touch toggle to the appropriate default (D-pad for TV,
 * Touch for phone/tablet). When omitted, falls back to D-pad default.
 */
deviceKind?: 'phone' | 'tablet' | 'tv';
```

- [ ] **Step 8.2: Extend `StreamClientScrcpy.start()` and constructor to accept `deviceKind`**

In `src/app/googDevice/client/StreamClientScrcpy.ts`:

1. Add `deviceKind` to `StartParams` type (line 35):

```ts
type StartParams = {
    udid: string;
    playerName?: string;
    player?: BasePlayer;
    fitToScreen?: boolean;
    videoSettings?: VideoSettings;
    deviceKind?: 'phone' | 'tablet' | 'tv';
};
```

2. Extend the static `start()` signature (line 186) with a seventh parameter:

```ts
public static start(
    query: URLSearchParams | ParamsStreamScrcpy,
    player?: BasePlayer,
    fitToScreen?: boolean,
    videoSettings?: VideoSettings,
    container?: HTMLElement,
    onDisconnect?: () => void,
    deviceKind?: 'phone' | 'tablet' | 'tv',
): { instance: StreamClientScrcpy; stop: () => void } {
    const params = query instanceof URLSearchParams ? StreamClientScrcpy.parseParameters(query) : query;
    const instance = new StreamClientScrcpy(params, player, fitToScreen, videoSettings, container, onDisconnect, deviceKind);
    return { instance, stop: () => instance.stopStream() };
}
```

3. Extend the constructor (line 199) with a seventh parameter, stored as a private readonly field, and thread it into the `this.startStream` call (line 209):

```ts
protected constructor(
    params: ParamsStreamScrcpy,
    player?: BasePlayer,
    fitToScreen?: boolean,
    videoSettings?: VideoSettings,
    private readonly container?: HTMLElement,
    private readonly onDisconnectCallback?: () => void,
    private readonly deviceKind?: 'phone' | 'tablet' | 'tv',
) {
    super(params);
    const { udid, player: playerName } = this.params;
    this.startStream({ udid, player, playerName, fitToScreen: fitToScreen ?? params.fitToScreen, videoSettings, deviceKind });
}
```

4. Destructure `deviceKind` in `startStream` method signature (line 369):

```ts
public async startStream({ udid, player, playerName, videoSettings, fitToScreen, deviceKind }: StartParams): Promise<void> {
```

5. Update the `GoogToolBox.createToolBox` call (line 417) to pass it through:

```ts
const googToolBox = GoogToolBox.createToolBox(udid, player, this, deviceKind);
```

**Note:** Step 5 above will break compilation until Task 9 adds the fourth parameter to `GoogToolBox.createToolBox`. That's expected and planned — Tasks 8 and 9 ship in a single commit at Step 9.4.

- [ ] **Step 8.3: Pass `deviceKind` from public `startStream` into `StreamClientScrcpy.start`**

In `src/app/public/startStream.ts`, locate the call to `StreamClientScrcpy.start(...)` at line 85 and add `options.deviceKind` as the seventh argument:

```ts
const { instance, stop } = StreamClientScrcpy.start(
    params,
    undefined,
    true,
    videoSettings,
    container,
    () => {
        isConnected = false;
        options.onDisconnect?.();
    },
    options.deviceKind,
);
```

- [ ] **Step 8.4: Pass `deviceKind` from `ConnectModal`**

In `src/app/googDevice/client/ConnectModal.ts`:

1. Add `deviceKind` parameter to the constructor:

```ts
constructor(
    params: ParamsStreamScrcpy,
    _player: BasePlayer,
    _fitToScreen: boolean,
    videoSettings: VideoSettings,
    deviceLabel: string,
    deviceKind?: 'phone' | 'tablet' | 'tv',
) {
```

2. Pass `deviceKind` to `startStream`:

```ts
this.handle = startStream(this.bodyEl, params.udid, {
    // ... existing options unchanged ...
    keyboard: true,
    deviceKind,
    onDisconnect: () => this.close(),
    onError: (err) => { /* ... unchanged ... */ },
});
```

- [ ] **Step 8.5: Pass `deviceKind` from `DeviceTracker` when constructing `ConnectModal`**

In `src/app/googDevice/client/DeviceTracker.ts`, find the `new ConnectModal(...)` call (line 337). Pass `device.deviceKind` as the 6th argument. The containing code already has `device: GoogDeviceDescriptor` in scope:

```ts
new ConnectModal(params, player, fitToScreen, videoSettings, label, device.deviceKind);
```

- [ ] **Step 8.6: Run typecheck (expected fail until Task 9 lands)**

```bash
npx tsc --noEmit
```

**Expected:** 1 error in `StreamClientScrcpy.ts` at the `GoogToolBox.createToolBox(...)` call — fourth argument not yet accepted. This resolves in Task 9.

- [ ] **Step 8.7: Do NOT commit yet**

Leave changes staged; Task 9 will complete the plumbing and they commit together.

---

## Task 9: Seed input-mode toggle in `GoogToolBox.createToolBox`

**Files:**
- Modify: `src/app/googDevice/toolbox/GoogToolBox.ts`

- [ ] **Step 9.1: Accept `deviceKind` parameter and seed checkbox state**

In `src/app/googDevice/toolbox/GoogToolBox.ts`, update the method signature and the input-mode block (lines 50–132):

1. Signature:

```ts
public static createToolBox(
    udid: string,
    player: BasePlayer,
    client: StreamClientScrcpy,
    deviceKind?: 'phone' | 'tablet' | 'tv',
): GoogToolBox {
```

2. Input-mode block — replace lines 118–132 with:

```ts
// D-pad mode (default/unchecked) vs Touch mode (checked)
const DPAD_TITLE = 'D-pad mode (click for Touch mode)';
const TOUCH_TITLE = 'Touch mode (click for D-pad mode)';
const inputMode = new ToolBoxCheckbox(
    DPAD_TITLE,
    { off: SvgImage.Icon.DPAD, on: SvgImage.Icon.TOUCH_HAND },
    `input_mode_${udid}_${playerName}`,
);
const inputModeLabel = inputMode.getAllElements()[1];

// Seed default from deviceKind: phone/tablet → Touch; tv/undefined → D-pad.
const startInTouch = deviceKind === 'phone' || deviceKind === 'tablet';
if (startInTouch) {
    inputMode.getElement().checked = true;
    client.setDpadMode(false);
    inputModeLabel.title = TOUCH_TITLE;
}

inputMode.addEventListener('click', (_, el) => {
    const touchMode = el.getElement().checked;
    client.setDpadMode(!touchMode);
    inputModeLabel.title = touchMode ? TOUCH_TITLE : DPAD_TITLE;
});
elements.push(inputMode);
```

- [ ] **Step 9.2: Run typecheck, expect pass**

```bash
npx tsc --noEmit
```

**Expected:** 0 errors. Task 8's pending fourth-argument call now compiles.

- [ ] **Step 9.3: Run full test suite, expect pass**

```bash
npm run test
```

**Expected:** all tests pass — behavior change is runtime-only and not covered by existing automated tests.

- [ ] **Step 9.4: Commit Tasks 8 + 9 together**

```bash
git add src/app/public/types.ts \
        src/app/public/startStream.ts \
        src/app/googDevice/client/ConnectModal.ts \
        src/app/googDevice/client/DeviceTracker.ts \
        src/app/googDevice/client/StreamClientScrcpy.ts \
        src/app/googDevice/toolbox/GoogToolBox.ts
git commit -m "feat(toolbar): seed D-pad/Touch default from deviceKind"
```

---

## Task 10: CHANGELOG entry + full build verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 10.1: Add changelog entry**

At the top of `CHANGELOG.md` under `## [Unreleased]` (create the section if missing, following Keep a Changelog format):

```markdown
### Added

- Auto-detect Android device kind (phone / tablet / tv) on connect using `ro.build.characteristics`, `pm has-feature android.software.leanback`, and `smallestWidthDp >= 600`. Surfaces as a small icon badge inside the connect pill on each device card.
- Stream toolbar's D-pad/Touch input-mode toggle now initializes to D-pad for TVs and Touch for phones/tablets. Toggle still works both directions after stream start.
- `deviceKind?: 'phone' | 'tablet' | 'tv'` optional field on `GoogDeviceDescriptor` and on `StartStreamOptions` (public `startStream` API).
```

- [ ] **Step 10.2: Run full verification suite**

```bash
npx tsc --noEmit && npm run test && npx webpack --config webpack/index.ts
```

**Expected:**
- `tsc`: 0 errors
- `vitest`: all tests pass (89 existing + ~13 new = ~102 total; count depends on matcher granularity)
- `webpack`: clean build, no warnings

- [ ] **Step 10.3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): device-kind detection + toolbar default"
```

---

## Task 11: Manual smoke test

**Not automated.** This is the acceptance checklist; a human runs it.

- [ ] **Step 11.1: Rebuild and start server**

```bash
npm run build
node dist/index.js
```

Open http://localhost:8000 in a browser.

- [ ] **Step 11.2: TV device**

Connect a TV (e.g., Google TV Streamer at 192.168.86.43:5555):

- [ ] Within ~5s of attach, the connect pill on the card shows a TV icon after the "WebCodecs" text.
- [ ] Click connect → stream opens → toolbar's input-mode toggle shows D-pad icon (unchecked state).
- [ ] Click the toggle → switches to Touch mode. Click again → back to D-pad. Both directions work.

- [ ] **Step 11.3: Phone device**

Connect an Android phone:

- [ ] Within ~5s, the pill shows a phone icon.
- [ ] Click connect → stream opens → input-mode toggle shows Touch-hand icon (checked state), stream is in touch mode.
- [ ] Click the toggle → switches to D-pad mode. Toggle both directions works.

- [ ] **Step 11.4: Tablet device**

Connect an Android tablet (smallestWidthDp ≥ 600):

- [ ] Within ~5s, the pill shows a tablet icon.
- [ ] Click connect → stream opens in Touch mode.

- [ ] **Step 11.5: Reconnect persistence**

With a TV connected and detected:

- [ ] Disconnect the device.
- [ ] Reconnect the device.
- [ ] Within ~5s, the TV badge reappears (detection re-runs on the new session because the `Device` instance is recreated on reconnect).

- [ ] **Step 11.6: Regression — existing flows**

- [ ] Sleep/wake button still works on each card.
- [ ] Configure Stream modal still opens, populates, and connects.
- [ ] Shell modal still opens and runs commands.
- [ ] List Files modal still opens.
- [ ] Scroll wheel, right-click (BACK), middle-click (HOME), keyboard capture all still work in both input modes.

If any step fails, the implementation is incomplete — do not declare the feature shipped.

---

## Self-Review Notes

**Spec coverage:**
- Section "Architecture and data flow" → Tasks 4, 5, 7, 8, 9
- Section "Server-side detection" → Tasks 1, 3, 4
- Section "Descriptor change" → Task 2
- Section "Client-side: badge on device card" → Tasks 6, 7
- Section "Client-side: stream toolbar default" → Tasks 8, 9
- Section "Testing" → Tasks 1, 3 (unit tests), Task 11 (manual smoke)
- Section "Files touched" → Matches the file manifest at the top of this plan

**Type consistency:** `DeviceKind` type is defined in `deviceKind.ts` but not exported/used outside that module — every consuming site (descriptor, `StartParams`, `StartStreamOptions`, `ConnectModal`, `GoogToolBox`) uses the inline literal `'phone' | 'tablet' | 'tv'`. This is a deliberate choice — keeps the public API self-documenting without a type import. If the set of kinds ever widens, a follow-up task would consolidate.

**No placeholders:** All code blocks contain complete, paste-ready code. No "TBD" or "add appropriate error handling" hand-waving.

**Ambiguity resolved:** Tasks 8 and 9 share a commit because Task 8 Step 8.6 breaks compilation that Task 9 fixes. Plan calls this out explicitly and commits them together in Step 9.4.
