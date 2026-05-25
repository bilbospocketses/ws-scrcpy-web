# §39 Config.json-based Service Port Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 30s blocking `discoverServicePort` port-sweep with mtime-based config.json discovery for both install and uninstall flows.

**Architecture:** The frontend snapshots config.json's mtime before a transition, then polls until mtime changes (signaling the new process wrote its bound port). Install flow polls the local Node's enhanced `/api/service/status`. Uninstall flow polls the operation-server's new `/api/discover` endpoint.

**Tech Stack:** TypeScript (Node server + browser frontend), Rust (operation-server)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/common/ServiceEvents.ts` | Modify | Add `configMtime` + `diskWebPort` to response types |
| `src/server/api/ServiceApi.ts` | Modify | Remove discover block from install; add mtime fields to status/install/uninstall responses; add disk-read helper |
| `src/server/__tests__/ServiceApi.test.ts` | Modify | Remove discover-stub scaffolding; add mtime-based response tests |
| `src/server/service/discoverServicePort.ts` | Delete | Dead code after removal |
| `src/server/__tests__/discoverServicePort.test.ts` | Delete | Dead code after removal |
| `src/app/client/SettingsModal.ts` | Modify | Replace `redirectTo` install handler + `serviceDied` uninstall handler with mtime poll loops |
| `src/app/client/WelcomeModal.ts` | Modify | Replace `redirectTo` install handler with mtime poll loop |
| `src/app/client/__tests__/serviceOperationModal.test.ts` | Check | Verify no breakage (modal itself unchanged) |
| `launcher/src/operation_server.rs` | Modify | Add `GET /api/discover` route returning `{ webPort, configMtime }` |
| `common/src/config.rs` | No change | Already has `AppConfig::load` which reads `webPort` — Rust side reuses this |

---

### Task 1: Add mtime + diskWebPort types to ServiceEvents

**Files:**
- Modify: `src/common/ServiceEvents.ts`

- [ ] **Step 1: Add fields to `ServiceStatusResponse`**

```typescript
export interface ServiceStatusResponse {
    supported: boolean;
    platform: NodeJS.Platform;
    status?: ServiceStatus | undefined;
    unsupportedReason?: string | undefined;
    /** webPort read fresh from config.json on disk (not in-memory cache). Present when supported=true. */
    diskWebPort?: number | undefined;
    /** config.json filesystem mtime in epoch milliseconds. Present when supported=true. */
    configMtime?: number | undefined;
}
```

- [ ] **Step 2: Add `configMtime` to `ServiceActionSuccess`**

```typescript
export interface ServiceActionSuccess {
    ok: true;
    status: ServiceStatus;
    installMode: 'user' | 'system' | 'user-service' | 'system-service';
    redirectTo?: string;
    resumeToken?: string;
    /** config.json mtime snapshot at response time (epoch ms). Frontend uses as baseline for polling. */
    configMtime?: number;
    /** webPort from config.json on disk at response time. */
    diskWebPort?: number;
}
```

- [ ] **Step 3: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/common/ServiceEvents.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(§39): add configMtime + diskWebPort to service response types"
```

---

### Task 2: Add disk-read helper + enhance handleStatus in ServiceApi

**Files:**
- Modify: `src/server/api/ServiceApi.ts`
- Modify: `src/server/__tests__/ServiceApi.test.ts`

- [ ] **Step 1: Write the failing test — status endpoint returns diskWebPort + configMtime**

Add to `src/server/__tests__/ServiceApi.test.ts`:

```typescript
it('GET /status includes diskWebPort and configMtime from disk when supported', async () => {
    // Write a known webPort to the config file so the disk-read returns it.
    const cfg = Config.getInstance();
    cfg.updateAppConfig({ webPort: 9001 });

    const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
    const factoryResult: ServiceClientFactoryResult = {
        client,
        supported: true,
        platform: 'win32',
    };
    const api = new ServiceApi(() => factoryResult, () => 'user');
    const { req, res } = makeReqRes('/api/service/status');
    await api.handle(req, res);
    const body = JSON.parse((res as any).getBody());
    expect(body.supported).toBe(true);
    expect(body.diskWebPort).toBe(9001);
    expect(typeof body.configMtime).toBe('number');
    expect(body.configMtime).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/server/__tests__/ServiceApi.test.ts` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: FAIL — `diskWebPort` is undefined, `configMtime` is undefined.

- [ ] **Step 3: Implement disk-read helper + wire into handleStatus**

Add a private method to `ServiceApi` and wire it into `handleStatus`. At the top of the file, add `import * as fs from 'node:fs';` (already present — verify). Add the helper method inside the class:

```typescript
/**
 * Read config.json from disk and return the current webPort + file mtime.
 * Returns null fields on any read/parse/stat failure (caller treats as "not ready").
 */
private readDiskConfig(): { diskWebPort: number | null; configMtime: number | null } {
    try {
        const cfgPath = Config.getInstance().getConfigFilePath();
        const stat = fs.statSync(cfgPath);
        const raw = fs.readFileSync(cfgPath, 'utf-8');
        const parsed = JSON.parse(raw) as { webPort?: unknown };
        const port = typeof parsed.webPort === 'number' ? parsed.webPort : null;
        return { diskWebPort: port, configMtime: stat.mtimeMs };
    } catch {
        return { diskWebPort: null, configMtime: null };
    }
}
```

In `handleStatus`, after constructing the supported=true body, spread the disk-read fields:

```typescript
const status = await result.client.status(WS_SCRCPY_SERVICE_NAME);
const disk = this.readDiskConfig();
const body: ServiceStatusResponse = {
    supported: true,
    platform: result.platform,
    status,
    ...(disk.diskWebPort != null ? { diskWebPort: disk.diskWebPort } : {}),
    ...(disk.configMtime != null ? { configMtime: disk.configMtime } : {}),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/server/__tests__/ServiceApi.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/api/ServiceApi.ts src/server/__tests__/ServiceApi.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(§39): enhance /api/service/status with disk-read configMtime + diskWebPort"
```

---

### Task 3: Remove discoverServicePort from install flow + add mtime to install response

**Files:**
- Modify: `src/server/api/ServiceApi.ts`
- Modify: `src/server/__tests__/ServiceApi.test.ts`

- [ ] **Step 1: Write the failing test — install returns configMtime + diskWebPort instead of redirectTo**

Replace or update the existing "syncs local in-memory webPort" test and the "discover stub returns null" test behavior. Add:

```typescript
it('POST /install on win32 returns configMtime + diskWebPort (no redirectTo, no discover)', async () => {
    const client = fakeClient({
        status: vi.fn(async () => 'running' as const),
        install: vi.fn(async () => undefined),
    });
    const factoryResult: ServiceClientFactoryResult = {
        client,
        supported: true,
        platform: 'win32',
    };
    const api = new ServiceApi(
        () => factoryResult,
        () => 'user',
        () => true, // existsCheck: launcher exists
    );
    const { req, res } = makeReqRes('/api/service/install', 'POST', '{}');
    await api.handle(req, res);
    const body = JSON.parse((res as any).getBody());
    expect(body.ok).toBe(true);
    expect(body.redirectTo).toBeUndefined();
    expect(typeof body.configMtime).toBe('number');
    expect(body.configMtime).toBeGreaterThan(0);
    expect(typeof body.diskWebPort).toBe('number');
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — current code still calls discover and returns redirectTo.

- [ ] **Step 3: Remove the discover block from handleInstall**

In `handleInstall`, remove lines 307-374 (everything from `const status = await result.client.status(...)` through the end of the `if (result.platform === 'win32')` block and the response construction). Replace with:

```typescript
const status = await result.client.status(WS_SCRCPY_SERVICE_NAME);
const disk = this.readDiskConfig();

// Schedule local-Node exit. This instance is useless once the service
// is running. The frontend navigates to the service port once it
// detects config.json mtime change — this timer is a safety cap, not
// a timing mechanism.
if (result.platform === 'win32') {
    setTimeout(() => {
        log.info('install-flow: local instance exiting (service is running)');
        process.exit(0);
    }, 15_000).unref();
}

const body: ServiceActionSuccess = {
    ok: true,
    status,
    installMode: newInstallMode,
    ...(disk.configMtime != null ? { configMtime: disk.configMtime } : {}),
    ...(disk.diskWebPort != null ? { diskWebPort: disk.diskWebPort } : {}),
};
res.writeHead(200);
res.end(JSON.stringify(body));
return true;
```

- [ ] **Step 4: Remove the `discover` constructor parameter**

Remove the 5th constructor parameter (`private readonly discover`) and its import. The constructor becomes:

```typescript
constructor(
    private readonly factory: () => ServiceClientFactoryResult = () => getServiceClient(),
    private readonly scope: () => 'user' | 'system' = () => detectInstallScope(),
    private readonly existsCheck: (p: string) => boolean = (p: string) => fs.existsSync(p),
) {}
```

Remove the `import { discoverServicePort } from '../service/discoverServicePort';` line.

- [ ] **Step 5: Fix existing tests that pass a discover stub**

All tests that pass `async () => null` or `async () => 'http://localhost:8001'` as the 5th arg to `new ServiceApi(...)` — remove that argument. Update/remove tests that assert `redirectTo` behavior:

- Remove: "POST /install syncs local in-memory webPort to the service-Node port discovered on handoff (§32 Part 5c)" — this behavior no longer exists server-side.
- Remove: "POST /install skips webPort sync when discovered URL has no parseable port" — same reason.
- Update: any test that passes 5 args to `ServiceApi()` — trim to 3 args.

- [ ] **Step 6: Run full test suite**

Run: `npm test -- --run src/server/__tests__/ServiceApi.test.ts`

Expected: All tests PASS.

- [ ] **Step 7: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/api/ServiceApi.ts src/server/__tests__/ServiceApi.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(§39): remove discoverServicePort from install flow, return configMtime instead"
```

---

### Task 4: Add configMtime to uninstall shutting-down response

**Files:**
- Modify: `src/server/api/ServiceApi.ts`
- Modify: `src/server/__tests__/ServiceApi.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('POST /uninstall (service context) returns configMtime in shutting-down response', async () => {
    // Set up config as service mode + write marker dir so the handler
    // can write the uninstall-pending marker.
    const cfg = Config.getInstance();
    cfg.updateAppConfig({ installMode: 'system-service', webPort: 8003 });

    const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
    const factoryResult: ServiceClientFactoryResult = {
        client,
        supported: true,
        platform: 'win32',
    };

    // Mock os.userInfo to return SYSTEM (triggers the LocalSystem path)
    vi.spyOn(require('node:os'), 'userInfo').mockReturnValue({ username: 'SYSTEM' } as any);

    const api = new ServiceApi(
        () => factoryResult,
        () => 'system',
        () => true,
    );
    const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
    await api.handle(req, res);
    const body = JSON.parse((res as any).getBody());
    expect(body.ok).toBe(true);
    expect(body.status).toBe('shutting-down');
    expect(typeof body.configMtime).toBe('number');
    expect(body.configMtime).toBeGreaterThan(0);

    vi.restoreAllMocks();
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `configMtime` is undefined.

- [ ] **Step 3: Add configMtime to the shutting-down response**

In `handleUninstall`, in the LocalSystem branch that returns `{ ok: true, status: 'shutting-down', installMode }`, add the disk read:

```typescript
const disk = this.readDiskConfig();
const body: ServiceActionSuccess = {
    ok: true,
    status: 'shutting-down',
    installMode: newMode,
    ...(disk.configMtime != null ? { configMtime: disk.configMtime } : {}),
};
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS

- [ ] **Step 5: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/api/ServiceApi.ts src/server/__tests__/ServiceApi.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(§39): include configMtime in uninstall shutting-down response"
```

---

### Task 5: Delete discoverServicePort module

**Files:**
- Delete: `src/server/service/discoverServicePort.ts`
- Delete: `src/server/__tests__/discoverServicePort.test.ts`

- [ ] **Step 1: Verify no remaining imports**

Run: `grep -r "discoverServicePort" src/` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: zero matches (removed in Task 3).

- [ ] **Step 2: Delete the files**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" rm src/server/service/discoverServicePort.ts src/server/__tests__/discoverServicePort.test.ts
```

- [ ] **Step 3: Run full vitest suite to confirm no breakage**

Run: `npm test -- --run` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: all tests pass, test count drops by however many were in discoverServicePort.test.ts.

- [ ] **Step 4: Run tsc to confirm no type errors**

Run: `npx tsc --noEmit` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: clean.

- [ ] **Step 5: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add -A
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "chore(§39): delete dead discoverServicePort module"
```

---

### Task 6: Frontend install flow — mtime-based poll (SettingsModal)

**Files:**
- Modify: `src/app/client/SettingsModal.ts`

- [ ] **Step 1: Replace the install handler's redirectTo + navigate logic**

In `SettingsModal.ts`, find the install handler (around line 855). Currently after receiving the response it checks `if (data.redirectTo)` and navigates. Replace the entire post-response success path with the mtime poll:

```typescript
const data = (await r.json().catch(() => null)) as ServiceInstallResponse | null;
if (!r.ok || !data || data.ok !== true) {
    const errMsg = data && data.ok === false
        ? SettingsModal.reasonToUserMessage(data.reason, data.error)
        : `install failed (${r.status})`;
    this.renderServiceError(errMsg, () => void this.refreshService());
    return;
}

// §39: mtime-based discovery. Poll /api/service/status until
// config.json mtime changes (service-Node wrote its bound port).
const baselineMtime = data.configMtime ?? 0;
const pollInterval = 2000;
const maxIterations = 30; // safety cap
let iterations = 0;
const poll = setInterval(async () => {
    iterations++;
    if (iterations > maxIterations) {
        clearInterval(poll);
        this.renderServiceError(
            'service is running but port discovery timed out. reload the page at your usual address.',
            () => void this.refreshService(),
        );
        return;
    }
    try {
        const statusResp = await fetch('/api/service/status', { signal: AbortSignal.timeout(5000) });
        if (!statusResp.ok) return;
        const statusData = await statusResp.json() as { configMtime?: number; diskWebPort?: number };
        if (
            statusData.configMtime != null &&
            statusData.configMtime !== baselineMtime &&
            statusData.diskWebPort != null
        ) {
            clearInterval(poll);
            window.location.href = `http://localhost:${statusData.diskWebPort}/`;
        }
    } catch {
        // Local Node may have exited (safety timer). Stop polling.
        clearInterval(poll);
        this.renderServiceError(
            'lost connection to local server during handoff. reload the page at the service port.',
            () => void this.refreshService(),
        );
    }
}, pollInterval);
return; // keep modal open, exit the handler
```

Remove the old `if (data.redirectTo)` block and the `await this.refreshService()` fallback that followed it.

- [ ] **Step 2: Run tsc to verify types**

Run: `npx tsc --noEmit` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: clean (the types from Task 1 make `configMtime`/`diskWebPort` available on the response).

- [ ] **Step 3: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/SettingsModal.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(§39): replace redirectTo with mtime poll in SettingsModal install handler"
```

---

### Task 7: Frontend install flow — mtime-based poll (WelcomeModal)

**Files:**
- Modify: `src/app/client/WelcomeModal.ts`

- [ ] **Step 1: Replace the WelcomeModal's install success path**

In `WelcomeModal.ts` (around line 340), the current code checks `if (data.redirectTo)` and navigates. Replace the entire post-response success path (after the `dontShowCheckbox` PATCH) with the same mtime poll pattern:

```typescript
if (this.dontShowCheckbox.checked) {
    await this.patchConfig({ firstRunComplete: true });
}

// §39: mtime-based discovery.
const baselineMtime = data.configMtime ?? 0;
const pollInterval = 2000;
const maxIterations = 30;
let iterations = 0;
this.setStatus('service installed. waiting for it to start…');
const poll = setInterval(async () => {
    iterations++;
    if (iterations > maxIterations) {
        clearInterval(poll);
        this.setStatus('service is running but port discovery timed out. reload at your usual address.', true);
        this.setBusy(false);
        return;
    }
    try {
        const statusResp = await fetch('/api/service/status', { signal: AbortSignal.timeout(5000) });
        if (!statusResp.ok) return;
        const statusData = await statusResp.json() as { configMtime?: number; diskWebPort?: number };
        if (
            statusData.configMtime != null &&
            statusData.configMtime !== baselineMtime &&
            statusData.diskWebPort != null
        ) {
            clearInterval(poll);
            this.setStatus('service mode active. switching you over…');
            setTimeout(() => {
                window.location.href = `http://localhost:${statusData.diskWebPort}/`;
            }, 500);
        }
    } catch {
        clearInterval(poll);
        this.setStatus('lost connection during handoff. reload at the service port.', true);
        this.setBusy(false);
    }
}, pollInterval);
return; // keep modal open
```

Remove the old `if (data.redirectTo)` block and the `this.opts.onDecision('service'); this.close();` that followed it.

- [ ] **Step 2: Run tsc**

Expected: clean.

- [ ] **Step 3: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/WelcomeModal.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(§39): replace redirectTo with mtime poll in WelcomeModal install handler"
```

---

### Task 8: Frontend uninstall flow — poll operation-server /api/discover

**Files:**
- Modify: `src/app/client/SettingsModal.ts`

- [ ] **Step 1: Replace the uninstall handler's serviceDied poll logic**

In `SettingsModal.ts`, find the uninstall handler's `if (data.status === 'shutting-down')` block (around line 922). Currently it sets `keepModalOpen = true`, polls `/api/service/status` with the `serviceDied` flip pattern, and calls `window.location.reload()` once the fetch succeeds after dying. Replace with:

```typescript
if (data.status === 'shutting-down') {
    keepModalOpen = true;
    const baselineMtime = data.configMtime ?? 0;
    const pollInterval = 2000;
    const maxIterations = 30;
    let iterations = 0;
    let serverDied = false;

    const poll = setInterval(async () => {
        iterations++;
        if (iterations > maxIterations) {
            clearInterval(poll);
            modal.close();
            this.renderServiceError(
                'service uninstalled but fresh instance not detected. try reloading.',
                () => void this.refreshService(),
            );
            return;
        }
        try {
            const resp = await fetch('/api/discover', { signal: AbortSignal.timeout(5000) });
            if (!resp.ok) return;
            const discoverData = await resp.json() as { webPort?: number | null; configMtime?: number | null };
            if (
                discoverData.configMtime != null &&
                discoverData.configMtime !== baselineMtime &&
                discoverData.webPort != null
            ) {
                clearInterval(poll);
                window.location.href = `http://localhost:${discoverData.webPort}/`;
            }
        } catch {
            if (!serverDied) {
                // First fetch failure = service-Node died, operation-server
                // not yet bound. Expected. Keep polling — operation-server
                // will take over the port shortly.
                serverDied = true;
            }
            // If serverDied was already true and we're still getting errors,
            // the operation-server also died (wind-down fired). Fall back to
            // a plain reload — the fresh launcher should be up by now.
            else if (iterations > 5) {
                clearInterval(poll);
                window.location.reload();
            }
        }
    }, pollInterval);
    return;
}
```

- [ ] **Step 2: Run tsc**

Expected: clean.

- [ ] **Step 3: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/SettingsModal.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(§39): replace serviceDied poll with /api/discover mtime poll in uninstall handler"
```

---

### Task 9: Operation-server — add /api/discover endpoint (Rust)

**Files:**
- Modify: `launcher/src/operation_server.rs`

- [ ] **Step 1: Write a unit test for the new route**

Add to the existing `#[cfg(test)]` module in `operation_server.rs` (or the closest test file for this module):

```rust
#[test]
fn build_discover_response_with_valid_config() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("config.json");
    std::fs::write(&config_path, r#"{"webPort":8003,"installMode":"user"}"#).unwrap();

    let response = build_discover_response(&config_path);
    assert!(response.contains("200 OK"));
    assert!(response.contains(r#""webPort":8003"#));
    assert!(response.contains(r#""configMtime":"#));
}

#[test]
fn build_discover_response_with_missing_config() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("config.json"); // doesn't exist

    let response = build_discover_response(&config_path);
    assert!(response.contains("200 OK"));
    assert!(response.contains(r#""webPort":null"#));
    assert!(response.contains(r#""configMtime":null"#));
}
```

- [ ] **Step 2: Run cargo test to verify it fails**

Run: `cargo test -p launcher --lib operation_server` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: FAIL — `build_discover_response` doesn't exist.

- [ ] **Step 3: Implement build_discover_response**

Add this function to `operation_server.rs`:

```rust
/// Build the HTTP response for GET /api/discover.
/// Reads config.json from disk, extracts webPort + file mtime.
/// Returns JSON with null fields on any failure (frontend keeps polling).
fn build_discover_response(config_path: &Path) -> String {
    let (web_port, mtime_ms) = match std::fs::metadata(config_path) {
        Ok(meta) => {
            let mtime = meta.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            let port = std::fs::read_to_string(config_path)
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                .and_then(|v| v.get("webPort")?.as_u64())
                .map(|p| p as u16);
            (port, mtime)
        }
        Err(_) => (None, None),
    };

    let port_str = match web_port {
        Some(p) => format!("{p}"),
        None => "null".to_string(),
    };
    let mtime_str = match mtime_ms {
        Some(m) => format!("{m}"),
        None => "null".to_string(),
    };
    let body = format!(r#"{{"webPort":{port_str},"configMtime":{mtime_str}}}"#);

    format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Connection: close\r\n\
         \r\n\
         {}",
        body.len(),
        body
    )
}
```

Note: `Access-Control-Allow-Origin: *` is needed because the frontend may be on a different port than the operation-server (the browser tab was on port 8003 when the service died, and the operation-server bound that same port — same origin — but we include CORS anyway for robustness).

- [ ] **Step 4: Wire the route into build_response**

In `build_response`, change the `/api/` branch to handle `/api/discover` before the existing redirect logic:

```rust
if path.starts_with("/api/") {
    if path == "/api/discover" {
        let data_root_env = std::env::var("WS_SCRCPY_DATA_ROOT").ok();
        let config_path = data_root_env
            .map(|dr| PathBuf::from(dr).join("config.json"))
            .unwrap_or_else(|| {
                common::config::data_root_from_env()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join("config.json")
            });
        return build_discover_response(&config_path);
    }

    // ... existing redirect/503 logic unchanged ...
}
```

- [ ] **Step 5: Run cargo test to verify it passes**

Run: `cargo test -p launcher --lib operation_server`

Expected: PASS

- [ ] **Step 6: Run full cargo test**

Run: `cargo test` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/operation_server.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(§39): add /api/discover endpoint to operation-server for mtime-based port discovery"
```

---

### Task 10: Full build verification + tsc + vitest + cargo

**Files:** None (verification only)

- [ ] **Step 1: Run tsc --noEmit**

Run: `npx tsc --noEmit` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: clean, zero errors.

- [ ] **Step 2: Run full vitest suite**

Run: `npm test -- --run` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: all tests pass. Count should be ~720 minus the deleted discoverServicePort tests plus new tests added.

- [ ] **Step 3: Run full cargo test**

Run: `cargo test` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: all tests pass. Count should be 125 + new operation_server tests.

- [ ] **Step 4: Run webpack build**

Run: `npm run build` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: build succeeds, dist/ produced.

- [ ] **Step 5: Record final test counts and commit if any fixups needed**

Note the final vitest + cargo counts for the CHANGELOG entry.

---

### Task 11: CHANGELOG + version bump + beta cut

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`, `Cargo.toml` (via `npm run version:bump`)

- [ ] **Step 1: Add CHANGELOG entry**

Under `## [Unreleased]` (or create a new beta section):

```markdown
### Changed
- **§39:** replaced 30s blocking `discoverServicePort` port sweep with mtime-based config.json discovery for both install and uninstall flows. Frontend polls until config.json mtime changes (new process wrote its bound port), then navigates. Eliminates the dead-port-spin bug on uninstall (beta.65 repro). Operation-server gains `/api/discover` endpoint for the uninstall transition window.

### Removed
- `src/server/service/discoverServicePort.ts` — dead code after §39.
```

- [ ] **Step 2: Version bump**

Run: `npm run version:bump 0.1.25-beta.66` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

(Adjust beta number to whatever is next — check `git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" tag --list 'v0.1.25-beta.*' | sort -V | tail -1`)

- [ ] **Step 3: Stage all changes**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add package.json Cargo.toml CHANGELOG.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "chore: bump to v0.1.25-beta.66"
```

- [ ] **Step 4: Tag + push**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" tag -s -a v0.1.25-beta.66 -m "v0.1.25-beta.66"
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" push origin main --follow-tags
```

---

### Task 12: Deploy smoke test

**Smoke matrix (4 items, deployed-mode only):**

1. Fresh install MSI → install service → modal shows spinner → navigates to service port without 30s delay
2. Uninstall service from service mode → modal shows spinner → navigates to fresh launcher port (even if different)
3. Install service when service lands on SAME port as local → still navigates correctly (mtime changed, port same)
4. Safety cap: kill the service mid-startup (before it writes config.json) → modal shows timeout error after cap iterations

Items 1-2 are the golden path. Item 3 validates the "same port" edge case. Item 4 validates the error path.
