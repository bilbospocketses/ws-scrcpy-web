# Device Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users name their devices with labels that persist across sessions, keyed by hardware serial number.

**Architecture:** Server-side `DeviceLabelStore` reads/writes a flat JSON file. Serial numbers flow through `ro.serialno` (connected devices) and mDNS name parsing (scan results). Labels are exposed via REST API and displayed in device cards with inline edit.

**Tech Stack:** TypeScript, fs (sync), Vitest, DOM manipulation (no framework).

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/server/DeviceLabelStore.ts` | Create | Label persistence: read/write `device-labels.json`, in-memory cache |
| `src/server/__tests__/deviceLabelStore.test.ts` | Create | Tests for DeviceLabelStore |
| `src/server/__tests__/adbClient.test.ts` | Modify | Add tests for `parseSerialFromMdnsName` |
| `src/server/AdbClient.ts` | Modify | Add `parseSerialFromMdnsName()` export |
| `src/types/GoogDeviceDescriptor.d.ts` | Modify | Add `ro.serialno` field |
| `src/server/goog-device/Properties.ts` | Modify | Add `ro.serialno` to properties array |
| `src/server/goog-device/Device.ts` | Modify | Initialize `ro.serialno` in descriptor |
| `src/server/api/DeviceDiscoveryApi.ts` | Modify | Add label endpoints, enhance scan/connect with serial + label |
| `src/app/client/NetworkDiscoveryPanel.ts` | Modify | Add optional name input to scan cards, send serial + label on connect |
| `src/app/googDevice/client/DeviceTracker.ts` | Modify | Add Device Name row with pencil icon and inline edit |
| `src/style/devicelist.css` | Modify | Styles for pencil icon, inline edit input, unnamed state |
| `src/style/home.css` | Modify | Styles for discovery card name input and actions layout |

---

### Task 1: DeviceLabelStore

**Files:**
- Create: `src/server/DeviceLabelStore.ts`
- Create: `src/server/__tests__/deviceLabelStore.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
// src/server/__tests__/deviceLabelStore.test.ts
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeviceLabelStore } from '../DeviceLabelStore';

const TEST_FILE = path.resolve(__dirname, '..', '..', '..', 'test-device-labels.json');

describe('DeviceLabelStore', () => {
    beforeEach(() => {
        // Clean up and reset singleton
        try { fs.unlinkSync(TEST_FILE); } catch {}
        DeviceLabelStore.resetInstance();
    });

    afterEach(() => {
        try { fs.unlinkSync(TEST_FILE); } catch {}
    });

    it('returns undefined for unknown serial', () => {
        const store = DeviceLabelStore.getInstance(TEST_FILE);
        expect(store.get('UNKNOWN')).toBeUndefined();
    });

    it('sets and gets a label', () => {
        const store = DeviceLabelStore.getInstance(TEST_FILE);
        store.set('SERIAL1', 'Living Room TV');
        expect(store.get('SERIAL1')).toBe('Living Room TV');
    });

    it('persists to disk', () => {
        const store = DeviceLabelStore.getInstance(TEST_FILE);
        store.set('SERIAL1', 'Living Room TV');
        const raw = JSON.parse(fs.readFileSync(TEST_FILE, 'utf-8'));
        expect(raw['SERIAL1']).toBe('Living Room TV');
    });

    it('loads existing file on init', () => {
        fs.writeFileSync(TEST_FILE, JSON.stringify({ 'S1': 'TV' }));
        const store = DeviceLabelStore.getInstance(TEST_FILE);
        expect(store.get('S1')).toBe('TV');
    });

    it('deletes a label', () => {
        const store = DeviceLabelStore.getInstance(TEST_FILE);
        store.set('SERIAL1', 'TV');
        store.delete('SERIAL1');
        expect(store.get('SERIAL1')).toBeUndefined();
    });

    it('getAll returns all labels', () => {
        const store = DeviceLabelStore.getInstance(TEST_FILE);
        store.set('S1', 'TV1');
        store.set('S2', 'TV2');
        expect(store.getAll()).toEqual({ 'S1': 'TV1', 'S2': 'TV2' });
    });

    it('handles missing file gracefully', () => {
        const store = DeviceLabelStore.getInstance(TEST_FILE);
        expect(store.getAll()).toEqual({});
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/__tests__/deviceLabelStore.test.ts`
Expected: FAIL — `DeviceLabelStore` does not exist.

- [ ] **Step 3: Implement DeviceLabelStore**

```typescript
// src/server/DeviceLabelStore.ts
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_PATH = path.resolve(__dirname, '..', 'device-labels.json');

export class DeviceLabelStore {
    private static instance?: DeviceLabelStore;
    private labels: Record<string, string> = {};

    private constructor(private readonly filePath: string) {
        this.load();
    }

    static getInstance(filePath = DEFAULT_PATH): DeviceLabelStore {
        if (!this.instance) {
            this.instance = new DeviceLabelStore(filePath);
        }
        return this.instance;
    }

    static resetInstance(): void {
        this.instance = undefined;
    }

    get(serial: string): string | undefined {
        return this.labels[serial];
    }

    set(serial: string, label: string): void {
        this.labels[serial] = label;
        this.save();
    }

    delete(serial: string): void {
        delete this.labels[serial];
        this.save();
    }

    getAll(): Record<string, string> {
        return { ...this.labels };
    }

    private load(): void {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            this.labels = JSON.parse(raw);
        } catch {
            this.labels = {};
        }
    }

    private save(): void {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.labels, null, 2) + '\n');
        } catch {
            // If we can't write, don't crash the server
        }
    }
}
```

Note: `DEFAULT_PATH` uses `__dirname` which resolves to `dist/` after webpack build. One `..` reaches the project root — same pattern as `Logger.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/deviceLabelStore.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/DeviceLabelStore.ts src/server/__tests__/deviceLabelStore.test.ts
git commit -m "feat: add DeviceLabelStore for persistent device names"
```

---

### Task 2: Parse Serial from mDNS Name

**Files:**
- Modify: `src/server/AdbClient.ts`
- Modify: `src/server/__tests__/adbClient.test.ts`

- [ ] **Step 1: Write the tests**

Add to `src/server/__tests__/adbClient.test.ts`:

```typescript
import { parseSerialFromMdnsName } from '../AdbClient';

describe('parseSerialFromMdnsName', () => {
    it('parses plain ADB name', () => {
        expect(parseSerialFromMdnsName('adb-49241HFAG07SUG', '_adb._tcp')).toBe('49241HFAG07SUG');
    });

    it('parses TLS connect name (strips suffix)', () => {
        expect(parseSerialFromMdnsName('adb-47121FDAQ000WC-7vmR8a', '_adb-tls-connect._tcp')).toBe('47121FDAQ000WC');
    });

    it('handles name without adb- prefix', () => {
        expect(parseSerialFromMdnsName('49241HFAG07SUG', '_adb._tcp')).toBe('49241HFAG07SUG');
    });

    it('handles empty string', () => {
        expect(parseSerialFromMdnsName('', '_adb._tcp')).toBe('');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/__tests__/adbClient.test.ts`
Expected: FAIL — `parseSerialFromMdnsName` is not exported.

- [ ] **Step 3: Implement parseSerialFromMdnsName**

Add to `src/server/AdbClient.ts` after the existing `parseMdnsOutput` function:

```typescript
export function parseSerialFromMdnsName(name: string, service: string): string {
    // Strip 'adb-' prefix
    let serial = name.startsWith('adb-') ? name.slice(4) : name;
    // For TLS connect services, strip the instance suffix (last -segment, 6-8 alphanumeric chars)
    if (service.includes('tls-connect') && serial.includes('-')) {
        serial = serial.substring(0, serial.lastIndexOf('-'));
    }
    return serial;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/adbClient.test.ts`
Expected: All tests PASS (existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/server/AdbClient.ts src/server/__tests__/adbClient.test.ts
git commit -m "feat: add parseSerialFromMdnsName for device label lookup"
```

---

### Task 3: Add ro.serialno to Device Descriptor

**Files:**
- Modify: `src/types/GoogDeviceDescriptor.d.ts`
- Modify: `src/server/goog-device/Properties.ts`
- Modify: `src/server/goog-device/Device.ts`

- [ ] **Step 1: Add field to type definition**

In `src/types/GoogDeviceDescriptor.d.ts`, add `'ro.serialno'` field:

```typescript
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
}
```

- [ ] **Step 2: Add to Properties array**

In `src/server/goog-device/Properties.ts`:

```typescript
export const Properties: ReadonlyArray<keyof GoogDeviceDescriptor> = [
    'ro.product.cpu.abi',
    'ro.product.manufacturer',
    'ro.product.model',
    'ro.build.version.release',
    'ro.build.version.sdk',
    'ro.serialno',
    'wifi.interface',
];
```

- [ ] **Step 3: Initialize in Device constructor**

In `src/server/goog-device/Device.ts`, add `'ro.serialno': ''` to the descriptor initialization (inside the constructor, around line 43-55):

```typescript
this.descriptor = {
    udid,
    state,
    interfaces: [],
    pid: -1,
    'wifi.interface': '',
    'ro.build.version.release': '',
    'ro.build.version.sdk': '',
    'ro.product.manufacturer': '',
    'ro.product.model': '',
    'ro.product.cpu.abi': '',
    'ro.serialno': '',
    'last.update.timestamp': 0,
};
```

- [ ] **Step 4: Build to verify types**

Run: `npm run build`
Expected: Both bundles compile successfully.

- [ ] **Step 5: Commit**

```bash
git add src/types/GoogDeviceDescriptor.d.ts src/server/goog-device/Properties.ts src/server/goog-device/Device.ts
git commit -m "feat: add ro.serialno to device descriptor for label keying"
```

---

### Task 4: Server API — Label Endpoints + Enhanced Scan/Connect

**Files:**
- Modify: `src/server/api/DeviceDiscoveryApi.ts`

- [ ] **Step 1: Import DeviceLabelStore and parseSerialFromMdnsName**

At the top of `src/server/api/DeviceDiscoveryApi.ts`:

```typescript
import type { IncomingMessage, ServerResponse } from 'http';
import { AdbClient, parseSerialFromMdnsName } from '../AdbClient';
import { Config } from '../Config';
import { DeviceLabelStore } from '../DeviceLabelStore';
```

- [ ] **Step 2: Add GET /api/devices/labels endpoint**

Inside the `handle` method, before the `res.writeHead(404)` fallback, add:

```typescript
if (req.method === 'GET' && url === '/api/devices/labels') {
    const labels = DeviceLabelStore.getInstance().getAll();
    res.writeHead(200);
    res.end(JSON.stringify(labels));
    return true;
}
```

- [ ] **Step 3: Add PUT /api/devices/labels endpoint**

After the GET handler:

```typescript
if (req.method === 'PUT' && url === '/api/devices/labels') {
    const body = await readBody(req);
    const { serial, label } = JSON.parse(body);
    if (!serial) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'serial is required' }));
        return true;
    }
    const store = DeviceLabelStore.getInstance();
    if (label) {
        store.set(serial, label);
    } else {
        store.delete(serial);
    }
    res.writeHead(200);
    res.end(JSON.stringify({ success: true }));
    return true;
}
```

- [ ] **Step 4: Enhance scan response with serial + label**

Replace the existing scan handler (`POST /api/devices/scan`) with:

```typescript
if (req.method === 'POST' && url === '/api/devices/scan') {
    const discovered = await this.adbClient.mdnsServices();
    const connectable = discovered.filter((d) => d.service.includes('_adb') && !d.service.includes('pairing'));
    const connected = await this.adbClient.devices();
    const connectedAddresses = new Set(connected.map((d) => d.serial));
    const labelStore = DeviceLabelStore.getInstance();
    const available = connectable
        .filter((d) => {
            const addr = `${d.address}:${d.port}`;
            return !connectedAddresses.has(addr);
        })
        .map((d) => {
            const serial = parseSerialFromMdnsName(d.name, d.service);
            return {
                ...d,
                serial,
                label: labelStore.get(serial) || '',
            };
        });
    res.writeHead(200);
    res.end(JSON.stringify(available));
    return true;
}
```

- [ ] **Step 5: Enhance connect to save label**

Replace the existing connect handler (`POST /api/devices/connect`) with:

```typescript
if (req.method === 'POST' && url === '/api/devices/connect') {
    const body = await readBody(req);
    const { address, serial, label } = JSON.parse(body);
    if (!address) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'address is required' }));
        return true;
    }
    if (serial && label) {
        DeviceLabelStore.getInstance().set(serial, label);
    }
    const result = await this.adbClient.connect(address);
    const success = result.includes('connected');
    res.writeHead(success ? 200 : 500);
    res.end(JSON.stringify({ success, message: result.trim() }));
    return true;
}
```

- [ ] **Step 6: Build and run all tests**

Run: `npm run build && npx vitest run`
Expected: Build succeeds, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/api/DeviceDiscoveryApi.ts
git commit -m "feat: add label API endpoints, enhance scan/connect with serial"
```

---

### Task 5: Network Discovery Panel — Optional Name Input

**Files:**
- Modify: `src/app/client/NetworkDiscoveryPanel.ts`
- Modify: `src/style/home.css`

- [ ] **Step 1: Update MdnsDevice interface**

At the top of the file, update the interface to include the new fields:

```typescript
interface MdnsDevice {
    name: string;
    service: string;
    address: string;
    port: number;
    serial: string;
    label: string;
}
```

- [ ] **Step 2: Update renderResults to add name input**

Replace the `renderResults` method:

```typescript
private renderResults(devices: MdnsDevice[]): void {
    if (devices.length === 0) {
        this.resultsContainer.innerHTML =
            '<div class="empty-state-card">No new devices found on the network. Make sure wireless debugging is enabled on your devices.</div>';
        return;
    }

    this.resultsContainer.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'discovery-grid';

    for (const device of devices) {
        const card = document.createElement('div');
        card.className = 'discovery-card';
        const addr = `${device.address}:${device.port}`;
        card.innerHTML = `
            <div class="discovery-card-info">
                <div class="discovery-card-name">${device.name}</div>
                <div class="discovery-card-address">${addr}</div>
            </div>
            <div class="discovery-card-actions">
                <input type="text" class="discovery-name-input" placeholder="Name this device..." value="${device.label || ''}" />
                <button class="dep-btn dep-update discovery-connect-btn" data-address="${addr}" data-serial="${device.serial}">Connect</button>
            </div>
        `;
        card.querySelector('.discovery-connect-btn')!.addEventListener('click', () =>
            this.connectDevice(addr, device.serial, card),
        );
        grid.appendChild(card);
    }
    this.resultsContainer.appendChild(grid);
}
```

- [ ] **Step 3: Update connectDevice to send serial + label**

Replace the `connectDevice` method:

```typescript
private async connectDevice(address: string, serial: string, card: HTMLElement): Promise<void> {
    const btn = card.querySelector('.discovery-connect-btn') as HTMLButtonElement;
    const nameInput = card.querySelector('.discovery-name-input') as HTMLInputElement;
    const label = nameInput.value.trim();

    btn.disabled = true;
    btn.textContent = 'Connecting...';

    try {
        const res = await fetch('/api/devices/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address, serial, label: label || undefined }),
        });
        const result: ConnectResult = await res.json();
        if (result.success) {
            btn.textContent = 'Connected';
            btn.classList.remove('dep-update');
            btn.classList.add('dep-ok-btn');
            setTimeout(() => card.remove(), 1500);
        } else {
            btn.textContent = 'Failed';
            btn.disabled = false;
            setTimeout(() => {
                btn.textContent = 'Connect';
            }, 2000);
        }
    } catch {
        btn.textContent = 'Error';
        btn.disabled = false;
        setTimeout(() => {
            btn.textContent = 'Connect';
        }, 2000);
    }
}
```

- [ ] **Step 4: Add CSS for discovery card actions**

Add to `src/style/home.css` after the existing `.discovery-card-address` rule:

```css
.discovery-card {
    flex-wrap: wrap;
}

.discovery-card-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    margin-top: 8px;
}

.discovery-name-input {
    flex: 1;
    background: var(--stream-bg-color, #333);
    border: 1px solid var(--device-border-color, #444);
    border-radius: 6px;
    color: var(--text-color, #eee);
    font-size: 13px;
    padding: 6px 10px;
}

.discovery-name-input:focus {
    outline: none;
    border-color: var(--accent-color, #5b9aff);
}

.discovery-name-input::placeholder {
    color: var(--text-color-secondary, #888);
}
```

Note: Adding `flex-wrap: wrap` to the existing `.discovery-card` rule so the actions row wraps below the info section. Use the existing `.discovery-card` selector — don't duplicate it. Just add the `flex-wrap` property.

- [ ] **Step 5: Build to verify**

Run: `npm run build`
Expected: Both bundles compile successfully.

- [ ] **Step 6: Commit**

```bash
git add src/app/client/NetworkDiscoveryPanel.ts src/style/home.css
git commit -m "feat: add optional name input to network scan cards"
```

---

### Task 6: Device Card — Label Row with Inline Edit

**Files:**
- Modify: `src/app/googDevice/client/DeviceTracker.ts`
- Modify: `src/style/devicelist.css`

- [ ] **Step 1: Add Device Name row to card template**

In `src/app/googDevice/client/DeviceTracker.ts`, in the `buildDeviceRow` method, replace the table HTML (lines 121-127):

```typescript
const row = html`<div class="device ${isActive ? 'active' : 'not-active'}">
    <table class="device-info">
        <tr class="device-name-row"><td class="device-label">Device Name:</td><td colspan="2"></td></tr>
        <tr><td class="device-label">Model:</td><td colspan="2">${deviceName}</td></tr>
        <tr><td class="device-label">Device ID:</td><td colspan="2" class="device-serial">${device.udid}</td></tr>
        <tr class="android-row"><td class="device-label">Android:</td><td>${device['ro.build.version.release']}</td></tr>
        <tr><td class="device-label">SDK:</td><td>${device['ro.build.version.sdk']}</td></tr>
    </table>
    <div id="${overlayId}" class="services">
        <div class="services-label">opens in overlay</div>
    </div>
    <div id="${newtabId}" class="services">
        <div class="services-label">opens in new tab</div>
    </div>
</div>`.content;
```

Note: The Device Name row's value cell (`td colspan="2"`) is left empty in the template. We populate it via DOM below because it contains interactive elements (pencil icon, click handlers) that can't be built with the `html` template tag.

- [ ] **Step 2: Build the label cell via DOM**

After the template parsing and before the `overlaySection`/`newtabSection` check, add the label rendering logic. Insert after `const newtabSection = row.getElementById(newtabId);` (around line 136):

```typescript
// Build Device Name cell via DOM (interactive elements can't use html`` template)
const nameRow = row.querySelector('.device-name-row');
if (nameRow) {
    const nameCell = nameRow.querySelector('td:last-child') as HTMLTableCellElement;
    if (nameCell) {
        const serial = device['ro.serialno'] || '';
        DeviceTracker.buildLabelCell(nameCell, serial);
    }
}
```

- [ ] **Step 3: Add static buildLabelCell method**

Add this method to the `DeviceTracker` class:

```typescript
private static buildLabelCell(cell: HTMLTableCellElement, serial: string): void {
    const renderDisplay = async () => {
        // Fetch current label
        let label = '';
        if (serial) {
            try {
                const res = await fetch('/api/devices/labels');
                const labels: Record<string, string> = await res.json();
                label = labels[serial] || '';
            } catch {
                // Couldn't fetch labels — show unnamed
            }
        }

        cell.innerHTML = '';
        cell.className = 'device-name-cell';

        const span = document.createElement('span');
        span.className = label ? 'device-name-text' : 'device-name-text unnamed';
        span.textContent = label || 'Unnamed Device';
        cell.appendChild(span);

        const pencilBtn = document.createElement('button');
        pencilBtn.className = 'device-name-edit-btn';
        pencilBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
        pencilBtn.title = 'Edit device name';
        pencilBtn.addEventListener('click', () => renderEdit(label));
        cell.appendChild(pencilBtn);
    };

    const renderEdit = (currentLabel: string) => {
        cell.innerHTML = '';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'device-name-input';
        input.value = currentLabel;
        input.placeholder = 'Name this device...';
        cell.appendChild(input);

        const saveBtn = document.createElement('button');
        saveBtn.className = 'device-name-edit-btn';
        saveBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
        saveBtn.title = 'Save';
        const save = async () => {
            const newLabel = input.value.trim();
            if (serial) {
                try {
                    await fetch('/api/devices/labels', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ serial, label: newLabel }),
                    });
                } catch {
                    // Save failed — will show old label
                }
            }
            renderDisplay();
        };
        saveBtn.addEventListener('click', save);
        cell.appendChild(saveBtn);

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') renderDisplay();
        });

        input.focus();
        input.select();
    };

    renderDisplay();
}
```

- [ ] **Step 4: Add CSS styles**

Add to `src/style/devicelist.css`:

```css
#devices .device-name-cell {
    position: relative;
    padding-right: 28px !important;
}

#devices .device-name-text {
    font-size: 15px;
    font-weight: 600;
}

#devices .device-name-text.unnamed {
    font-style: italic;
    opacity: 0.5;
    font-weight: 400;
}

#devices .device-name-edit-btn {
    position: absolute;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--text-color-light, #888);
    padding: 2px;
    line-height: 1;
    opacity: 0.6;
}

#devices .device-name-edit-btn:hover {
    opacity: 1;
    color: var(--text-color, #ddd);
}

#devices .device-name-input {
    width: calc(100% - 24px);
    background: var(--stream-bg-color, #333);
    border: 1px solid var(--text-color-light, #888);
    border-radius: 4px;
    color: var(--text-color, #ddd);
    font-size: 14px;
    padding: 2px 6px;
}

#devices .device-name-input:focus {
    outline: none;
    border-color: var(--accent-color, #5b9aff);
}
```

- [ ] **Step 5: Remove first-child bold rule conflict**

The existing CSS rule `#devices .device-info tr:first-child td:last-child` applies `font-size: 15px; font-weight: 600` to the first row's last cell. This was for Model (previously first row). Now Device Name is first row, and we handle its styling via `.device-name-text`. The existing rule will still target the Device Name cell, which is fine — it matches what we want. No change needed.

- [ ] **Step 6: Build and test in browser**

Run: `npm run build`
Expected: Both bundles compile successfully.

Restart server and verify in browser:
1. Connected devices show "Device Name: Unnamed Device [pencil]" row
2. Click pencil — input appears with checkmark
3. Type a name, press Enter — label saves and displays
4. Refresh page — label persists
5. Click pencil again — can rename

- [ ] **Step 7: Commit**

```bash
git add src/app/googDevice/client/DeviceTracker.ts src/style/devicelist.css
git commit -m "feat: add device name row with inline edit to device cards"
```

---

### Task 7: Integration Test and Cleanup

**Files:**
- All modified files (final verification)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing 33 + new DeviceLabelStore 7 + new parseSerial 4 = 44).

- [ ] **Step 2: Full build**

Run: `npm run build`
Expected: Both bundles compile with no errors.

- [ ] **Step 3: End-to-end browser test**

Restart server and test the full flow:
1. Scan Network — devices show with optional name input, pre-filled if known
2. Type a name, click Connect — device connects, label saved
3. Connected device card shows label in Device Name row
4. Click pencil — edit inline, save with Enter or checkmark
5. Press Escape — cancels edit
6. Refresh page — labels persist
7. Restart server — labels still there (read from `device-labels.json`)

- [ ] **Step 4: Add device-labels.json to .gitignore**

Add `device-labels.json` to `.gitignore` — this is user data, not source code.

- [ ] **Step 5: Final commit and push**

```bash
git add .gitignore
git commit -m "chore: add device-labels.json to gitignore"
git push
```
