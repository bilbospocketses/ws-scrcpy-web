# Home Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the ws-scrcpy-web home page into three clean sections on a single page: Connected Devices (card grid), Network Discovery (mDNS scan with Connect buttons), and Dependencies (existing updater). No navigation system — everything visible on one scroll.

**Architecture:** Restyle the existing DeviceTracker rendering into a card grid layout. Add a new server-side API endpoint for `adb mdns services` and `adb connect`. Add a NetworkDiscovery browser component that renders discovered devices as connectable cards. Reposition the existing DependencyPanel below both sections.

**Tech Stack:** TypeScript, vanilla DOM (existing patterns), CSS custom properties (existing theme system), ADB mDNS discovery.

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `src/server/api/DeviceDiscoveryApi.ts` | HTTP endpoints for mDNS scan and ADB connect |
| `src/app/client/NetworkDiscoveryPanel.ts` | Browser UI: scan button, discovered device cards, connect buttons |
| `src/style/home.css` | Unified home page styles: card grid for devices, section layout, discovery panel |

### Modified Files

| File | Change |
|------|--------|
| `src/style/devicelist.css` | Restyle device rows into card grid layout |
| `src/app/googDevice/client/DeviceTracker.ts` | Simplify device row HTML for card layout |
| `src/app/index.ts` | Wire NetworkDiscoveryPanel between devices and dependencies |
| `src/server/services/HttpServer.ts` | Register DeviceDiscoveryApi alongside DependencyApi |
| `src/server/index.ts` | Initialize DeviceDiscoveryApi |
| `src/server/AdbClient.ts` | Add `mdnsServices()` and `connect()` methods |

---

## Task 1: Add ADB mDNS and Connect Methods

**Files:**
- Modify: `src/server/AdbClient.ts`
- Create: `src/server/__tests__/adbClient.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/server/__tests__/adbClient.test.ts
import { describe, expect, it } from 'vitest';
import { AdbClient, parseMdnsOutput } from '../AdbClient';

describe('parseMdnsOutput', () => {
    it('parses mdns services output with IPs and ports', () => {
        const output = [
            'List of discovered mdns services',
            'adb-SERIAL1\t_adb-tls-connect._tcp.\t192.168.86.43:5555',
            'adb-SERIAL2\t_adb-tls-connect._tcp.\t192.168.86.44:5555',
        ].join('\n');
        const result = parseMdnsOutput(output);
        expect(result).toEqual([
            { name: 'adb-SERIAL1', service: '_adb-tls-connect._tcp.', address: '192.168.86.43', port: 5555 },
            { name: 'adb-SERIAL2', service: '_adb-tls-connect._tcp.', address: '192.168.86.44', port: 5555 },
        ]);
    });

    it('returns empty array for no services', () => {
        const output = 'List of discovered mdns services\n';
        expect(parseMdnsOutput(output)).toEqual([]);
    });

    it('handles _adb-tls-pairing service type', () => {
        const output = [
            'List of discovered mdns services',
            'adb-SERIAL1\t_adb-tls-pairing._tcp.\t192.168.86.43:37485',
        ].join('\n');
        const result = parseMdnsOutput(output);
        expect(result[0].service).toBe('_adb-tls-pairing._tcp.');
        expect(result[0].port).toBe(37485);
    });

    it('ignores malformed lines', () => {
        const output = [
            'List of discovered mdns services',
            'some garbage line',
            'adb-SERIAL1\t_adb-tls-connect._tcp.\t192.168.86.43:5555',
            '',
        ].join('\n');
        const result = parseMdnsOutput(output);
        expect(result.length).toBe(1);
    });
});

describe('AdbClient', () => {
    it('has mdnsServices method', () => {
        const client = new AdbClient();
        expect(typeof client.mdnsServices).toBe('function');
    });

    it('has connect method', () => {
        const client = new AdbClient();
        expect(typeof client.connect).toBe('function');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/__tests__/adbClient.test.ts`
Expected: FAIL — parseMdnsOutput not found

- [ ] **Step 3: Implement mdnsServices, connect, and parseMdnsOutput**

Add to `src/server/AdbClient.ts`:

1. Export the `parseMdnsOutput` function (standalone, for testability):

```typescript
export interface MdnsDevice {
    name: string;
    service: string;
    address: string;
    port: number;
}

export function parseMdnsOutput(output: string): MdnsDevice[] {
    const results: MdnsDevice[] = [];
    for (const line of output.split('\n')) {
        // Expected format: name\tservice\taddress:port
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const [name, service, addressPort] = parts;
        const colonIdx = addressPort.lastIndexOf(':');
        if (colonIdx === -1) continue;
        const address = addressPort.substring(0, colonIdx);
        const port = parseInt(addressPort.substring(colonIdx + 1), 10);
        if (isNaN(port)) continue;
        results.push({ name: name.trim(), service: service.trim(), address, port });
    }
    return results;
}
```

2. Add methods to the `AdbClient` class:

```typescript
async mdnsServices(): Promise<MdnsDevice[]> {
    try {
        const output = await this.exec(['mdns', 'services']);
        return parseMdnsOutput(output);
    } catch {
        return [];
    }
}

async connect(address: string): Promise<string> {
    return this.exec(['connect', address]);
}

async disconnect(address: string): Promise<string> {
    return this.exec(['disconnect', address]);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/server/__tests__/adbClient.test.ts`
Expected: 6 tests PASS

- [ ] **Step 5: Full test suite and build**

Run: `npm test && npm run build`
Expected: All pass, build clean

- [ ] **Step 6: Commit**

```bash
git add src/server/AdbClient.ts src/server/__tests__/adbClient.test.ts
git commit -m "feat: add ADB mDNS discovery and connect methods"
```

---

## Task 2: Device Discovery API

**Files:**
- Create: `src/server/api/DeviceDiscoveryApi.ts`
- Modify: `src/server/services/HttpServer.ts` — generalize API handler to support multiple APIs
- Modify: `src/server/index.ts` — initialize DeviceDiscoveryApi

- [ ] **Step 1: Create DeviceDiscoveryApi**

```typescript
// src/server/api/DeviceDiscoveryApi.ts
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';
import { AdbClient } from '../AdbClient';
import { Config } from '../Config';

export class DeviceDiscoveryApi {
    private adbClient: AdbClient;

    constructor() {
        this.adbClient = new AdbClient(Config.getInstance().adbPath);
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/devices')) return false;

        res.setHeader('Content-Type', 'application/json');

        try {
            // POST /api/devices/scan — discover devices via mDNS
            if (req.method === 'POST' && url === '/api/devices/scan') {
                const discovered = await this.adbClient.mdnsServices();
                // Filter to only _adb-tls-connect services (not pairing)
                const connectable = discovered.filter((d) => d.service.includes('connect'));
                // Get currently connected devices to exclude them
                const connected = await this.adbClient.devices();
                const connectedAddresses = new Set(connected.map((d) => d.serial));
                const available = connectable.filter((d) => {
                    const addr = `${d.address}:${d.port}`;
                    return !connectedAddresses.has(addr);
                });
                res.writeHead(200);
                res.end(JSON.stringify(available));
                return true;
            }

            // POST /api/devices/connect — connect to a device by address
            if (req.method === 'POST' && url === '/api/devices/connect') {
                const body = await readBody(req);
                const { address } = JSON.parse(body);
                if (!address) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'address is required' }));
                    return true;
                }
                const result = await this.adbClient.connect(address);
                const success = result.includes('connected');
                res.writeHead(success ? 200 : 500);
                res.end(JSON.stringify({ success, message: result.trim() }));
                return true;
            }

            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
            return true;
        } catch (err: any) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
            return true;
        }
    }
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}
```

- [ ] **Step 2: Generalize HttpServer API handling**

Currently `HttpServer` has a single `apiHandler` of type `DependencyApi`. We need to support multiple API handlers. Change:

In `HttpServer.ts`:
1. Change the static field from a single handler to an array:
```typescript
private static apiHandlers: Array<{ handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> }> = [];

public static addApiHandler(handler: { handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> }): void {
    HttpServer.apiHandlers.push(handler);
}
```

2. Update `createRequestHandler` to iterate through handlers:
```typescript
private createRequestHandler(
    fallback?: (req: IncomingMessage, res: ServerResponse) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
        const tryHandlers = async () => {
            for (const handler of HttpServer.apiHandlers) {
                const handled = await handler.handle(req, res);
                if (handled) return;
            }
            if (fallback) fallback(req, res);
        };
        tryHandlers().catch((err) => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
        });
    };
}
```

3. Remove the old `setApiHandler` method and `apiHandler` field. Update `index.ts` to use `addApiHandler` instead.

- [ ] **Step 3: Update index.ts**

Change `HttpServer.setApiHandler(depApi)` to `HttpServer.addApiHandler(depApi)` and add:

```typescript
import { DeviceDiscoveryApi } from './api/DeviceDiscoveryApi';

// After the depApi line:
const discoveryApi = new DeviceDiscoveryApi();
HttpServer.addApiHandler(discoveryApi);
```

- [ ] **Step 4: Build and test**

Run: `npm test && npm run build`
Expected: All pass, build clean

- [ ] **Step 5: Commit**

```bash
git add src/server/api/DeviceDiscoveryApi.ts src/server/services/HttpServer.ts src/server/index.ts
git commit -m "feat: add device discovery API with mDNS scan and connect endpoints"
```

---

## Task 3: Restyle Connected Devices as Card Grid

**Files:**
- Create: `src/style/home.css`
- Modify: `src/style/devicelist.css` — restyle for card grid
- Modify: `src/app/index.ts` — import home.css

This task is CSS-only — no JavaScript changes to DeviceTracker rendering. The existing HTML structure (`.device` divs inside `.device-list`) maps directly to a CSS grid of cards.

- [ ] **Step 1: Create home.css for page-level section layout**

```css
/* src/style/home.css */

/* Page sections */
.home-section {
    padding: 20px;
    margin-bottom: 8px;
}

.home-section h2 {
    margin: 0 0 16px 0;
    font-size: 18px;
    color: var(--text-color, #eee);
    font-weight: 600;
}

.section-divider {
    border: none;
    border-top: 1px solid var(--device-border-color, #444);
    margin: 0;
}
```

- [ ] **Step 2: Restyle devicelist.css for card grid**

Replace the table-like layout with a card grid. Key changes:

1. `.device-list` becomes a CSS grid:
```css
.device-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 12px;
    padding: 0;
}
```

2. `.device` becomes a card:
```css
.device {
    border: 1px solid var(--device-border-color);
    border-radius: 8px;
    padding: 16px;
    background: var(--device-list-default-color);
    transition: border-color 0.15s;
}

.device:hover {
    border-color: var(--device-list-hover-color);
}

.device.active {
    border-left: 3px solid #4ade80;
}

.device.not-active {
    border-left: 3px solid #f87171;
    opacity: 0.7;
}
```

3. Remove alternating stripe colors (doesn't work with grid)

4. `.device-header` becomes a cleaner layout:
```css
.device-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
}

.device-name {
    font-size: 15px;
    font-weight: 600;
    flex: 1;
}

.device-serial {
    font-size: 12px;
    color: var(--text-color-secondary, #888);
    font-family: monospace;
}

.device-state {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
}
```

5. `.services` and `.desc-block` cleanup:
```css
.services {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.desc-block {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border: 1px solid var(--device-border-color);
    border-radius: 6px;
    font-size: 13px;
}
```

6. Remove the old `#devices` padding and overflow (the section wrapper handles this now).

**IMPORTANT:** Keep all existing class names and selectors — we're restyling, not restructuring. The JavaScript generates these class names and IDs. Only change the CSS rules, not the selectors (unless adding new ones).

- [ ] **Step 3: Add home.css import to index.ts**

Add at the top of `src/app/index.ts`:
```typescript
import '../style/home.css';
```

- [ ] **Step 4: Build and visual test**

Run: `npm run build`
Start server and check `http://localhost:8000` — devices should appear as cards in a responsive grid.

- [ ] **Step 5: Commit**

```bash
git add src/style/home.css src/style/devicelist.css src/app/index.ts
git commit -m "feat(ui): restyle device list as responsive card grid"
```

---

## Task 4: Network Discovery Panel

**Files:**
- Create: `src/app/client/NetworkDiscoveryPanel.ts`
- Modify: `src/style/home.css` — add discovery panel styles
- Modify: `src/app/index.ts` — wire panel into page

- [ ] **Step 1: Create NetworkDiscoveryPanel.ts**

```typescript
// src/app/client/NetworkDiscoveryPanel.ts

interface MdnsDevice {
    name: string;
    service: string;
    address: string;
    port: number;
}

interface ConnectResult {
    success: boolean;
    message: string;
}

export class NetworkDiscoveryPanel {
    private container: HTMLElement;
    private resultsContainer: HTMLElement;

    constructor() {
        this.container = document.createElement('div');
        this.container.id = 'discovery-panel';
        this.container.className = 'home-section';
        this.container.innerHTML = `
            <div class="discovery-header">
                <h2>Network Devices</h2>
                <button class="dep-btn discovery-scan-btn">Scan Network</button>
            </div>
            <div class="discovery-results"></div>
        `;
        this.resultsContainer = this.container.querySelector('.discovery-results')!;
        this.container.querySelector('.discovery-scan-btn')!.addEventListener('click', () => this.scan());
    }

    getElement(): HTMLElement {
        return this.container;
    }

    private async scan(): Promise<void> {
        const btn = this.container.querySelector('.discovery-scan-btn') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Scanning...';
        this.resultsContainer.innerHTML = '<p class="discovery-scanning">Scanning local network for ADB devices...</p>';

        try {
            const res = await fetch('/api/devices/scan', { method: 'POST' });
            const devices: MdnsDevice[] = await res.json();
            this.renderResults(devices);
        } catch {
            this.resultsContainer.innerHTML = '<p class="discovery-error">Scan failed. Is ADB available?</p>';
        } finally {
            btn.disabled = false;
            btn.textContent = 'Scan Network';
        }
    }

    private renderResults(devices: MdnsDevice[]): void {
        if (devices.length === 0) {
            this.resultsContainer.innerHTML = '<p class="discovery-empty">No new devices found on the network. Make sure wireless debugging is enabled on your devices.</p>';
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
                <button class="dep-btn dep-update discovery-connect-btn" data-address="${addr}">Connect</button>
            `;
            card.querySelector('.discovery-connect-btn')!.addEventListener('click', () => this.connectDevice(addr, card));
            grid.appendChild(card);
        }
        this.resultsContainer.appendChild(grid);
    }

    private async connectDevice(address: string, card: HTMLElement): Promise<void> {
        const btn = card.querySelector('.discovery-connect-btn') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Connecting...';

        try {
            const res = await fetch('/api/devices/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address }),
            });
            const result: ConnectResult = await res.json();
            if (result.success) {
                btn.textContent = 'Connected';
                btn.classList.remove('dep-update');
                btn.classList.add('dep-ok-btn');
                // Device will appear in connected list via WebSocket update
                // Remove the card after a brief delay
                setTimeout(() => card.remove(), 1500);
            } else {
                btn.textContent = 'Failed';
                btn.disabled = false;
                setTimeout(() => { btn.textContent = 'Connect'; }, 2000);
            }
        } catch {
            btn.textContent = 'Error';
            btn.disabled = false;
            setTimeout(() => { btn.textContent = 'Connect'; }, 2000);
        }
    }
}
```

- [ ] **Step 2: Add discovery styles to home.css**

Append to `src/style/home.css`:

```css
/* Network Discovery */
.discovery-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
}

.discovery-header h2 {
    margin: 0;
}

.discovery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 10px;
}

.discovery-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border: 1px solid var(--device-border-color, #444);
    border-radius: 8px;
    background: var(--device-list-default-color, #1e1e1e);
}

.discovery-card-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-color, #eee);
}

.discovery-card-address {
    font-size: 12px;
    font-family: monospace;
    color: var(--text-color-secondary, #888);
    margin-top: 2px;
}

.discovery-scanning,
.discovery-empty {
    color: var(--text-color-secondary, #888);
    font-size: 14px;
    padding: 12px 0;
}

.discovery-error {
    color: #f87171;
    font-size: 14px;
    padding: 12px 0;
}

.dep-ok-btn {
    background: #1a3a1a !important;
    border-color: #2a5a2a !important;
    color: #4ade80 !important;
}
```

- [ ] **Step 3: Wire into index.ts**

In `src/app/index.ts`, after the existing `DependencyPanel.create()` block, add:

```typescript
import { NetworkDiscoveryPanel } from './client/NetworkDiscoveryPanel';

// In the default path (after HostTracker.start()):
const discoveryPanel = new NetworkDiscoveryPanel();

// Insert discovery panel between devices and dependencies
DependencyPanel.create().then((depPanel) => {
    const devices = document.getElementById('devices');
    if (devices) {
        // Discovery panel goes after devices
        devices.after(discoveryPanel.getElement());
        // Dependency panel goes after discovery
        discoveryPanel.getElement().after(depPanel.getElement());
    } else {
        document.body.append(discoveryPanel.getElement());
        document.body.append(depPanel.getElement());
    }
});
```

This replaces the existing DependencyPanel insertion that inserts before `#devices`. Now the order is:
1. `#devices` (connected devices — rendered by DeviceTracker)
2. `#discovery-panel` (network discovery)
3. `#dependency-panel` (dependency updater)

- [ ] **Step 4: Build and visual test**

Run: `npm run build`
Start server, open browser. Verify:
- Connected devices show as cards
- "Scan Network" button appears in Network Devices section
- Dependencies section appears at bottom

- [ ] **Step 5: Commit**

```bash
git add src/app/client/NetworkDiscoveryPanel.ts src/style/home.css src/app/index.ts
git commit -m "feat(ui): add network discovery panel with mDNS scan and connect"
```

---

## Task 5: Reposition Dependency Panel and Final Polish

**Files:**
- Modify: `src/style/dependencies.css` — remove border-bottom (section dividers handle it now)
- Modify: `src/app/client/DependencyPanel.ts` — add `home-section` class
- Modify: `src/app/client/NetworkDiscoveryPanel.ts` — ensure consistent section styling

- [ ] **Step 1: Update DependencyPanel to use section class**

In `src/app/client/DependencyPanel.ts`, in the constructor where `this.container.id = 'dependency-panel'` is set, add the section class:

```typescript
this.container.className = 'home-section';
```

- [ ] **Step 2: Remove border-bottom from dependencies.css**

In `src/style/dependencies.css`, remove or update the `#dependency-panel` rule that has `border-bottom`. The section layout in `home.css` handles separation now.

- [ ] **Step 3: Build and full visual test**

Run: `npm run build`
Start server, verify the complete page:
- Three distinct sections with consistent spacing
- Connected devices in card grid
- Network discovery with scan button
- Dependencies table at bottom

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/app/client/DependencyPanel.ts src/style/dependencies.css
git commit -m "feat(ui): polish home page section layout and spacing"
```

---

## Task 6: Documentation

**Files:**
- Modify: `docs/TECHNICAL_GUIDE.md` — update section 13 with discovery API, add section 14 for home page architecture
- Modify: `README.md` — update features list

- [ ] **Step 1: Update TECHNICAL_GUIDE.md**

Add to section 13.2 API Endpoints table:

```markdown
| POST | `/api/devices/scan` | Discover ADB devices on local network via mDNS |
| POST | `/api/devices/connect` | Connect to a discovered device by address |
```

Add a new section 14 after section 13:

```markdown
## 14. Home Page Architecture

The home page (`http://localhost:8000`) is a single-page view with three sections:

### 14.1 Connected Devices

Rendered by `DeviceTracker` via WebSocket updates from `ControlCenter`. Each device is a card in a responsive CSS grid showing device name, serial, state (green/red indicator), and action buttons (stream, shell, file manager).

Devices appear automatically when ADB detects them. The server polls `adb devices` every 2 seconds.

### 14.2 Network Discovery

The "Scan Network" button calls `POST /api/devices/scan` which runs `adb mdns services` to discover ADB-enabled devices advertising via mDNS. Results are filtered to exclude already-connected devices and displayed as cards with "Connect" buttons.

Connecting calls `POST /api/devices/connect` with the device address. On success, the device appears in the Connected Devices section via the normal WebSocket update flow.

**Requirement:** Devices must have wireless debugging enabled and be on the same network.

### 14.3 Dependencies

The dependency updater panel (section 13) shows installed vs. latest versions for Node.js, ADB, and scrcpy-server with update controls.
```

- [ ] **Step 2: Update README.md features**

Add to the Features section:
```markdown
- **Network device discovery** -- scan local network for ADB devices via mDNS and connect with one click
```

- [ ] **Step 3: Commit**

```bash
git add docs/TECHNICAL_GUIDE.md README.md
git commit -m "docs: add network discovery and home page architecture documentation"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** Three sections on one page (connected devices, network discovery, dependencies). Card grid for devices. mDNS scan with connect buttons. Dependencies panel repositioned. No navigation system.
- [x] **Placeholder scan:** All code blocks complete. No TBD/TODO.
- [x] **Type consistency:** `MdnsDevice` type defined in AdbClient.ts (server) and duplicated as interface in NetworkDiscoveryPanel.ts (browser — can't share types across webpack bundles). `ConnectResult` used consistently. API endpoints match between server and client.
- [x] **CSS approach:** Restyling existing selectors (not renaming classes) so JavaScript doesn't break. New classes added for grid layout. Existing theme variables reused.
