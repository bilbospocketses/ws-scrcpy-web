# Device Store (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the JSON `DeviceLabelStore` with the per-user `DeviceStore` (labels) and start populating the shared `devices` observed table from the scanner / device tracker — surfacing model/last-seen in the device list.

**Architecture:** Device naming is now per-user (`device_labels` keyed `(user_id, serial)`). Observed facts (manufacturer/model/address/last-seen) live in the shared `devices` table, upserted server-side. In open mode (no auth yet) every request resolves to the implicit admin (`IMPLICIT_ADMIN_ID`); a single `resolveUserId(req)` helper is the seam Phase 4 generalizes to the session user.

**Tech Stack:** TypeScript, the Phase-1 `DeviceStore`/`Db`, vitest.

**Spec:** `docs/specs/2026-06-11-sqlite-persistence-and-auth-design.md` (Device store phase). **Depends on Phase 1** (the `Db`, `DeviceStore`, and the device-labels.json import already ran). The label data is already in `device_labels` for user 1; this phase only retargets the *consumers*.

**Conventions:** same as Phase 1 (vitest explicit imports; `Db._resetForTest()` between tests; per-user reads/writes go through `resolveUserId(req)`).

---

## File structure

| File | Change |
|---|---|
| `src/server/auth/currentUser.ts` | **Create.** `resolveUserId(req?)` → `IMPLICIT_ADMIN_ID` for now; Phase 4 extends it to read the session user. The single seam for per-user resolution. |
| `src/server/api/DeviceDiscoveryApi.ts` | **Modify.** Retarget the six `DeviceLabelStore` call sites (lines 31/67/87/92/154/168) to `Db.getInstance(dataRoot).devices` via `resolveUserId(req)`; upsert observed devices when building the list. |
| `src/server/index.ts` | **Modify.** `labelFor` (line 151) reads `DeviceStore.getLabel(IMPLICIT_ADMIN_ID, key)`. Remove the `DeviceLabelStore` import (line 17). |
| `src/server/goog-device/services/ControlCenter.ts` (or `DeviceTracker` mw) | **Modify.** Upsert observed `{ serial, manufacturer, model }` when a goog device's props are known. (Exact site pinned at execution — the goog device props handler.) |
| `src/server/DeviceLabelStore.ts` | **Delete** once all consumers are retargeted. |
| `src/server/__tests__/deviceLabelStore.test.ts` | **Delete** (store removed). |

---

## Task 1: `resolveUserId` seam

**Files:**
- Create: `src/server/auth/currentUser.ts`
- Test: `src/server/auth/__tests__/currentUser.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'http';
import { resolveUserId } from '../currentUser';
import { IMPLICIT_ADMIN_ID } from '../../db/constants';

describe('resolveUserId (open mode)', () => {
    it('returns the implicit admin when no auth context is present', () => {
        expect(resolveUserId(undefined)).toBe(IMPLICIT_ADMIN_ID);
        expect(resolveUserId({} as IncomingMessage)).toBe(IMPLICIT_ADMIN_ID);
    });
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/auth/__tests__/currentUser.test.ts`

- [ ] **Step 3: Implement** (Phase 4 will read `(req as AuthedRequest).user?.id`)

```ts
// src/server/auth/currentUser.ts
import type { IncomingMessage } from 'http';
import { IMPLICIT_ADMIN_ID } from '../db/constants';

/**
 * The acting user's id for a request. In open mode (no auth) this is always the
 * implicit admin. Phase 4 extends this to return the authenticated session
 * user's id (falling back to IMPLICIT_ADMIN_ID only when auth is disabled).
 */
export function resolveUserId(_req?: IncomingMessage): number {
    return IMPLICIT_ADMIN_ID;
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/server/auth/currentUser.ts src/server/auth/__tests__/currentUser.test.ts
git commit -m "feat(device): add resolveUserId seam (open mode → implicit admin)"
```

---

## Task 2: retarget the device-label API to DeviceStore

**Files:**
- Modify: `src/server/api/DeviceDiscoveryApi.ts`
- Test: `src/server/__tests__/deviceDiscoveryApi.labels.test.ts`

**Retarget map** (the handler keeps its request/response shape; only the storage call changes):

| Current (`DeviceLabelStore`) | New (`DeviceStore` via `resolveUserId(req)`) |
|---|---|
| `DeviceLabelStore.getInstance().get(serial)` (index.ts) | `db.devices.getLabel(userId, serial)` |
| `DeviceLabelStore.getInstance().set(serial, label)` (:67/:87/:92) | `db.devices.setLabel(userId, serial, label)` |
| `DeviceLabelStore.getInstance().getAll()` (:154) | `db.devices.getAllLabels(userId)` |
| `DeviceLabelStore.getInstance()` …`.delete(serial)` (:168) | `db.devices.deleteLabel(userId, serial)` |

where `const db = Db.getInstance(Config.getInstance().dataRoot ?? <dev-fallback>)` and `const userId = resolveUserId(req)`.

- [ ] **Step 1: Failing test** — drive the API surface that sets + lists labels and assert it lands in `device_labels` for user 1.

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from '../db/Db';
import { Config } from '../Config';
import { DeviceDiscoveryApi } from '../api/DeviceDiscoveryApi';
import { IMPLICIT_ADMIN_ID } from '../db/constants';
import { makeReqRes } from './helpers/httpMock'; // see note

const dirs: string[] = [];
function root(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsdd-')); dirs.push(d); return d; }
afterEach(() => { Db._resetForTest(); Config._resetForTest(); while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); process.env['DATA_ROOT'] = ''; });

describe('DeviceDiscoveryApi labels via DeviceStore', () => {
    it('POSTing a label writes device_labels for the implicit admin', async () => {
        const dir = root();
        process.env['DATA_ROOT'] = dir;
        Config.getInstance(); // initializes Db for this dataRoot
        const api = new DeviceDiscoveryApi();
        const { req, res, body } = makeReqRes('POST', '/api/devices/label', { serial: 'S1', label: 'Living Room' });
        await api.handle(req, res);
        expect(Db.getInstance(dir).devices.getLabel(IMPLICIT_ADMIN_ID, 'S1')).toBe('Living Room');
        void body;
    });
});
```

> `makeReqRes` helper: if the repo lacks an HTTP mock helper, create `src/server/__tests__/helpers/httpMock.ts` returning a minimal `IncomingMessage`/`ServerResponse` pair (method, url, JSON body stream, captured status/payload). Mirror whatever pattern `capabilitiesApi.test.ts` / `ServiceApi.test.ts` already use — reuse theirs rather than inventing a second one (DRY). Pin the exact request path/shape to the existing label endpoint in `DeviceDiscoveryApi`.

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/__tests__/deviceDiscoveryApi.labels.test.ts`

- [ ] **Step 3: Implement** the retarget: at the top of `DeviceDiscoveryApi`, import `Db`, `Config`, `resolveUserId`; in each handler that previously used `DeviceLabelStore`, compute `const db = Db.getInstance(Config.getInstance().dataRoot ?? <fallback>)` and `const userId = resolveUserId(req)`, then call the `db.devices.*Label*` method per the retarget map. Remove the `DeviceLabelStore` import.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/server/api/DeviceDiscoveryApi.ts src/server/__tests__/deviceDiscoveryApi.labels.test.ts
git commit -m "feat(device): retarget device-label API to per-user DeviceStore"
```

---

## Task 3: retarget the scanner `labelFor` + remove DeviceLabelStore

**Files:**
- Modify: `src/server/index.ts` (line 17 import, line 151 `labelFor`)
- Delete: `src/server/DeviceLabelStore.ts`, `src/server/__tests__/deviceLabelStore.test.ts`

- [ ] **Step 1: Change `labelFor`** in `index.ts` from `DeviceLabelStore.getInstance().get(key)` to:

```ts
labelFor: (key: string) => Db.getInstance(config.dataRoot ?? config.dependenciesPath).devices.getLabel(IMPLICIT_ADMIN_ID, key),
```

> `labelFor` is a background (non-request) callback feeding scan results sent to all clients, so it uses `IMPLICIT_ADMIN_ID` directly. **Phase 4 note (flagged):** with multiple users, scan-result labels must be applied per-recipient. Phase 4 moves label overlay out of the shared scan into the per-connection delivery (the device list is labeled with the session user's labels when sent). Recorded as a Phase 4 task; in open mode user 1 is correct.

- [ ] **Step 2: Remove the `DeviceLabelStore` import** (index.ts line 17); add imports for `Db` and `IMPLICIT_ADMIN_ID`.

- [ ] **Step 3: Delete the store + its test**

```bash
git rm src/server/DeviceLabelStore.ts src/server/__tests__/deviceLabelStore.test.ts
```

- [ ] **Step 4: Verify no stragglers**

Run: `npx grep -rn "DeviceLabelStore" src` (or the repo's search) → **zero** matches.
Run: `npm run -s tsc` → clean (no dangling import).

- [ ] **Step 5: Run the scanner tests** (they mock `labelFor` directly, so they are unaffected):

Run: `npx vitest run src/server/__tests__/networkScanner.test.ts`
Expected: PASS unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/server/index.ts
git commit -m "feat(device): retarget scanner labelFor to DeviceStore; remove DeviceLabelStore"
```

---

## Task 4: populate the shared `devices` observed table

**Files:**
- Modify: `src/server/api/DeviceDiscoveryApi.ts` (upsert serial/address/last-seen when building the list)
- Modify: the goog device props site (`src/server/goog-device/services/ControlCenter.ts` or the `DeviceTracker` mw) for manufacturer/model
- Test: `src/server/__tests__/deviceObservedUpsert.test.ts`

- [ ] **Step 1: Failing test** — observed metadata is upserted and retrievable.

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from '../db/Db';
import { upsertObservedDevices } from '../api/deviceObserved';

const dirs: string[] = [];
function root(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsobs-')); dirs.push(d); return d; }
afterEach(() => { Db._resetForTest(); while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('observed device upsert', () => {
    it('records serial/model/address/last-seen and preserves prior non-null fields', () => {
        const dir = root();
        const db = Db.getInstance(dir);
        upsertObservedDevices(db, [{ serial: 'S1', model: 'Pixel 7', lastSeenAt: 10 }]);
        upsertObservedDevices(db, [{ serial: 'S1', address: '10.0.0.5:5555', lastSeenAt: 20 }]);
        expect(db.devices.getDevice('S1')).toMatchObject({ model: 'Pixel 7', address: '10.0.0.5:5555', lastSeenAt: 20 });
    });
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/__tests__/deviceObservedUpsert.test.ts`

- [ ] **Step 3: Implement** a tiny shared helper so both the scan path and the goog-device path use one upsert (DRY):

```ts
// src/server/api/deviceObserved.ts
import type { Db } from '../db/Db';

export interface ObservedDevice {
    serial: string; manufacturer?: string | null; model?: string | null; address?: string | null; lastSeenAt?: number | null;
}

export function upsertObservedDevices(db: Db, devices: ObservedDevice[]): void {
    for (const d of devices) db.devices.upsertDevice(d);
}
```

- [ ] **Step 4: Wire the call sites.**
  - In `DeviceDiscoveryApi` where the scan/aggregated list is produced, call `upsertObservedDevices(db, items.map(i => ({ serial: i.serial, address: i.address, lastSeenAt: Date.now() })))`.
  - At the goog device props site, call `upsertObservedDevices(db, [{ serial, manufacturer: props['ro.product.manufacturer'], model: props['ro.product.model'], lastSeenAt: Date.now() }])`.
  - Surface `model`/`lastSeenAt` in the device-list response payload (read from `db.devices.getDevice(serial)`), so the client can show them. Exact payload field names pin to the existing device-list DTO at execution.

- [ ] **Step 5: Run the gate**

Run: `npm run -s tsc && npx vitest run`
Expected: clean + green.

- [ ] **Step 6: Commit**

```bash
git add src/server/api/deviceObserved.ts src/server/api/DeviceDiscoveryApi.ts src/server/goog-device/services/ControlCenter.ts src/server/__tests__/deviceObservedUpsert.test.ts
git commit -m "feat(device): populate shared devices observed table from scan + goog props"
```

---

## Self-review checklist

- [ ] **Spec coverage:** per-user `device_labels` consumers retargeted ✓; shared `devices` upserts wired ✓; `DeviceLabelStore` removed ✓; model/last-seen surfaced ✓. **Phase 4 dependency recorded:** per-user label *delivery* for the shared scan (the `labelFor` background path).
- [ ] **Placeholder scan:** no vague steps; retarget map + helper code concrete. The two "pin at execution" notes (HTTP mock helper, device-list DTO field names) are integration specifics against in-flux code, not placeholders — each names the exact file + the exact transformation.
- [ ] **Type consistency:** `resolveUserId`, `Db.getInstance(...).devices.{getLabel,setLabel,deleteLabel,getAllLabels,upsertDevice,getDevice}`, `IMPLICIT_ADMIN_ID`, `upsertObservedDevices(db, ObservedDevice[])` match Phase 1's `DeviceStore` API exactly.
- [ ] **No straggler:** `grep DeviceLabelStore src` returns nothing.
