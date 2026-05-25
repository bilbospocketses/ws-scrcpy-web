# §39 — Config.json-based service port discovery

## Problem

`handleInstall` in `ServiceApi.ts` blocks up to 30s on `discoverServicePort()`, polling 100 ports for `/api/whoami` with a different PID. The uninstall flow has the inverse bug: the frontend polls its own origin (same port) after the service-Node dies, but the fresh launcher may bind a different port — modal spins forever.

Both flows rely on port-sweeping or same-origin assumptions. Neither is reliable.

## Solution: mtime-based config.json discovery

**Core principle:** config.json's filesystem mtime is the signal that a new process has bound its port. Every Node startup calls `setActualWebPort(port)` → `saveToDisk()` → mtime updates. Nothing else writes config.json during transitions. The frontend snapshots mtime before the transition, polls until mtime changes, then reads the freshly-written `webPort`.

## Enhanced `/api/service/status` response

Two new fields added when `supported === true`:

```typescript
interface ServiceStatusResponse {
    supported: boolean;
    platform: string;
    status?: string;
    // new:
    diskWebPort?: number;    // webPort read fresh from config.json on disk
    configMtime?: number;    // fs.statSync(configFilePath).mtimeMs
}
```

Populated by `fs.readFileSync` + `fs.statSync` on `Config.getInstance().getConfigFilePath()` on every call.

## Install flow

### Backend (`ServiceApi.handleInstall`)

1. Install service + wait for sc query 'running' (existing, unchanged)
2. **Remove** the entire `discoverServicePort()` block — no port sweeping
3. Snapshot config.json mtime + diskWebPort at response time
4. Return `{ ok: true, status, installMode, configMtime, diskWebPort }` — no `redirectTo`
5. Schedule `process.exit(0)` with a generous safety ceiling — the local Node is useless once the service is running. This is NOT a timing mechanism for the frontend; the frontend navigates as soon as the mtime condition is met, regardless of this timer. The timer just ensures the local Node doesn't linger indefinitely if the frontend navigates away without triggering an exit.

### Frontend (`SettingsModal` + `WelcomeModal` install handlers)

1. Receive install response — save `configMtime` as snapshot
2. ServiceOperationModal stays open
3. Poll `GET /api/service/status` every 2s
4. Exit condition: `response.configMtime !== snapshot`
5. Read `response.diskWebPort` → navigate to `http://localhost:<diskWebPort>/`
6. Safety cap: after N failed iterations, show error and stop

## Uninstall flow

### Backend (`ServiceApi.handleUninstall` — LocalSystem path)

Existing behavior mostly kept:
1. Revert installMode in config.json
2. Write uninstall-pending marker
3. Spawn operation-server
4. Return `{ ok: true, status: 'shutting-down', installMode, configMtime }` — new: include current config.json mtime as the snapshot
5. Schedule `process.exit(0)` after 5s (unchanged)

### Frontend (`SettingsModal` uninstall handler)

1. Receive `{ status: 'shutting-down', configMtime }` — save as snapshot
2. ServiceOperationModal stays open
3. Wait for service-Node to die (existing pattern: fetch throws → `serviceDied = true`)
4. Once dead, browser is on the operation-server's page
5. Poll `GET /api/discover` on the operation-server every 2s
6. Exit condition: `response.configMtime !== snapshot`
7. Read `response.webPort` → navigate to `http://localhost:<webPort>/`
8. Safety cap: after N failed iterations, show error and stop

### Operation-server Rust addition (`launcher/src/operation_server.rs`)

New route: `GET /api/discover`

- Read config.json from disk (path: `<WS_SCRCPY_DATA_ROOT>/config.json`)
- Parse JSON, extract `webPort`
- `fs::metadata` for mtime
- Return `{ "webPort": <number>, "configMtime": <epoch_ms> }`
- On read/parse failure: return `{ "webPort": null, "configMtime": null }` (frontend keeps polling)

~20-30 lines of Rust in the existing HTTP handler's match block.

## Error handling

- **Null fields:** frontend treats as "not ready yet" — keeps polling
- **Config.json read failure:** return null fields, don't crash
- **Same port scenario:** mtime detection handles cleanly — don't care about port value, only freshness
- **Operation-server dies before frontend navigates:** poll fetch throws → treat as "transition likely complete" → fall back to `window.location.reload()`
- **Safety cap exceeded:** show user-facing error message in the modal ("service started but couldn't confirm the port")

## Files changed

| File | Change |
|------|--------|
| `src/server/api/ServiceApi.ts` | Remove `discoverServicePort` block from `handleInstall`; add `configMtime`/`diskWebPort` to install response; add `configMtime` to uninstall `shutting-down` response |
| `src/server/api/ServiceApi.ts` (handleStatus) | Add disk-read `diskWebPort` + `configMtime` to status response |
| `src/server/service/discoverServicePort.ts` | Delete (dead code after removal from ServiceApi) |
| `src/server/__tests__/discoverServicePort.test.ts` | Delete |
| `src/server/__tests__/ServiceApi.test.ts` | Update: remove discover-related test scaffolding, add mtime-based tests |
| `src/common/ServiceEvents.ts` | Add `configMtime`/`diskWebPort` fields to response types |
| `src/app/client/SettingsModal.ts` | Replace `redirectTo` handling with mtime-based poll loop (install); replace `serviceDied` + reload with `/api/discover` poll (uninstall) |
| `src/app/client/WelcomeModal.ts` | Replace `redirectTo` handling with mtime-based poll loop (install) |
| `launcher/src/operation_server.rs` | Add `GET /api/discover` route |

## What does NOT change

- `ServiceOperationModal` — still shows spinner, no structural changes
- `Config.ts` — `setActualWebPort` / `saveToDisk` unchanged (they're the source of the mtime signal)
- `ConfigApi.ts` — unchanged (serves in-memory config; the disk-read lives in the status endpoint)
- The operation-server's existing HTML page / wind-down / stop-marker logic
- The launcher's port-binding + `setActualWebPort` startup sequence
