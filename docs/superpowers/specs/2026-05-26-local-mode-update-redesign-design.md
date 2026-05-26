# Local-Mode Update Redesign — Design Spec

**Date:** 2026-05-26
**Status:** Draft
**Scope:** §40 local-mode in-app update relaunch — redesign to eliminate port conflict

## Problem

The local-mode update flow has three stacked bugs that cause the post-update app to be unreachable on IPv4 (`127.0.0.1:8000` dead, `[::1]:8000` works):

1. **Port conflict.** The operation-server binds `0.0.0.0:{config_port}` to serve an "updating" page during the swap. The new Node process tries to bind the same port. If the operation-server hasn't fully released the socket, Node gets only the IPv6 half of a dual-stack bind. The tray's `ureq` POST to `127.0.0.1:{config_port}` times out with WSAETIMEDOUT.

2. **Stale helper binary.** The operation-server runs from a data-root copy (`<dataRoot>/control/operation-server/ws-scrcpy-web-launcher.exe`) refreshed by the previous version's supervisor on startup. Behavior fixes (like PR #167's early-exit) don't take effect until the version after the one that introduced them. The new supervisor's refresh attempt fails with `os error 32` (file in use by the running operation-server).

3. **Node resolution.** `spawn_server()` calls `resolve_node()` which reads `DEPS_PATH` from the launcher's own process env (intentionally empty per SP2b first-run bootstrap design). Resolution always falls through to `seed/node/node.exe` instead of `dependencies/node/node.exe`.

## Design

### Core Principle

The operation-server binds a **different port** from the app's configured web port. No two processes ever compete for the same port. Port conflict, ghost sockets, and dual-stack corruption are structurally impossible.

### Update Flow (4 phases)

**Phase 1 — Trigger**

1. User clicks "apply update" in the browser.
2. `UpdateService.applyUpdate()` spawns the operation-server as a detached process (existing `spawn_detached_helper` mechanism).
3. Node poll-reads `<dataRoot>/control/operation-server-port` until the operation-server writes its bound port (timeout: 5 seconds, poll interval: 100ms).
4. Node responds to the browser with a small HTML page whose JS navigates to `http://localhost:{operation_server_port}/`.
5. Node writes the `apply-update-pending` marker.
6. Node exits cleanly (exit code 0, no `waitExitThenApplyUpdate`).

**Phase 2 — Swap**

1. Operation-server binds `config_port + 1`, probing upward on `EADDRINUSE` (cap: `config_port + 10`). Bind-retry loop for transient errors (existing 10-second timeout).
2. Writes the bound port to `<dataRoot>/control/operation-server-port`.
3. Serves the "updating, please wait" HTML page to browsers.
4. Kills the tray process (`taskkill /F /IM ws-scrcpy-web-tray.exe /T`, `CREATE_NO_WINDOW`).
5. Sleeps 3 seconds (tray cleanup window).
6. Extracts `*-full.nupkg` from `<installRoot>/packages/` into `<installRoot>/current/` (existing `find_and_extract_nupkg`).
7. Sleeps 1 second (filesystem settle).
8. Launches the new launcher from `<installRoot>/current/ws-scrcpy-web-launcher.exe` (detached, `CREATE_NO_WINDOW`, CWD = `install_root`).

**Phase 3 — Handoff**

1. Operation-server runs a background probe thread sweeping `config_port..config_port+10` every 100ms, looking for a 200 response from `/api/config` without the operation-server's sentinel header (existing probe pattern).
2. The updating page JS polls `GET /api/discover` on the operation-server every 2 seconds.
   - While updating: `{"status": "updating"}`
   - When probe finds new Node: `{"status": "ready", "redirect": "http://localhost:{new_node_port}/"}`
3. On `"ready"`, the browser navigates to the redirect URL.

**Phase 4 — Cleanup**

1. Operation-server deletes `<dataRoot>/control/operation-server-port`.
2. Operation-server exits with code 0.
3. Max-lifetime safety cap: 60 seconds. If the probe never finds the new Node, the updating page shows an error message ("Update may have failed — try restarting manually") and the operation-server exits.

### Supervisor Changes

**§40 path (lines 200-232 of `supervisor.rs`):**
- Structurally unchanged: detect `apply-update-pending` marker on clean Node exit, set `WS_SCRCPY_INSTALL_ROOT`, spawn detached helper.
- Remove `wait_for_port_free` from the §40 code path. The operation-server is on a different port; nothing to wait for.
- The existing stop-marker write + port-wait stays for the **service-mode** path only.

**`refresh_helper_binary`:**
- Unchanged. The stale binary problem is neutralized: old code's `bind("0.0.0.0", config_port)` would fail because Node still holds that port at spawn time (Node hasn't exited yet when the operation-server starts binding). The operation-server exits with error code 3. Graceful degradation, not silent corruption.

### Node Resolution Fix

**`spawn_server` (spawn.rs):**

Change from:
```rust
let node = resolve_node()?;
```
to:
```rust
let exe = std::env::current_exe()?;
let exe_dir = exe.parent().context("exe has no parent dir")?;
let node = resolve_node_with(
    Some(deps_path.to_str().context("deps_path not valid UTF-8")?),
    exe_dir,
)?;
```

**`resolve_node_with` (spawn.rs):**

Relax strict mode — try deps_path first, fall through to seed if the candidate doesn't exist:
```rust
pub fn resolve_node_with(deps_path: Option<&str>, exe_dir: &Path) -> Result<PathBuf> {
    if let Some(deps) = deps_path {
        let candidate = Path::new(deps).join("node").join("node.exe");
        if candidate.exists() {
            return Ok(candidate);
        }
        // deps_path is set but node isn't there yet (first-run before
        // DependencyManager populates it) — fall through to seed
    }
    let seed = exe_dir.join("seed").join("node").join("node.exe");
    if seed.exists() {
        return Ok(seed);
    }
    bail!("Node not found at deps or seed")
}
```

The supervisor comment at lines 170-177 ("do NOT set DEPS_PATH on the launcher's process env") becomes obsolete. The launcher no longer reads `DEPS_PATH` from env for its own resolution — it uses the `deps_path` parameter directly.

### Port File Contract

- **Path:** `<dataRoot>/control/operation-server-port`
- **Content:** ASCII decimal port number, no newline (e.g., `8001`)
- **Writer:** Operation-server, immediately after successful bind
- **Reader:** Node's `UpdateService.applyUpdate()`, poll-read with 100ms interval, 5s timeout
- **Cleanup:** Operation-server deletes on exit. Stale files from a prior crash are overwritten on next bind.

### `/api/discover` Endpoint

Served by the operation-server on its own port. Two response shapes:

```json
{"status": "updating"}
```
```json
{"status": "ready", "redirect": "http://localhost:8000/"}
```

Content-Type: `application/json`. No CORS headers needed (same-origin for `localhost`, different ports are cross-origin but the updating page's JS is served from the operation-server's own origin).

The redirect URL uses the port discovered by the probe, which may differ from `config_port` if the new Node shifted (existing `reconcileWebPort` behavior).

### Updating Page Changes

The HTML page (`launcher/assets/operation-server-page.html`) gains:
- A `<script>` block that polls `GET /api/discover` every 2 seconds
- On `"ready"` response, navigates to `redirect` URL
- On 60-second timeout (no `"ready"` received), replaces the spinner with an error message

The existing `__OPERATION_TITLE__` / `__OPERATION_BODY__` token substitution is unchanged.

### What's Removed

- Operation-server no longer binds `config_port` in the §40 path
- `wait_for_port_free` call removed from the §40 supervisor path
- The wind-down + stop-marker coordination is no longer used by §40 (stays for service-mode)
- The background page-serving thread's infinite `loop { accept_one(...) }` (replaced by a loop gated on an `Arc<AtomicBool>` stop flag, set by the main thread before exit)

### Error Handling

| Scenario | Behavior |
|----------|----------|
| All ports `config_port+1..+10` busy | Operation-server exits code 3. Node's poll-read times out. Browser stays on Node (which hasn't exited yet). User sees "update failed" in the frontend. |
| Nupkg extraction fails | Operation-server exits code 4. Updating page times out, shows error. |
| New launcher fails to start | Probe never finds new Node. 60s timeout, error message on updating page. |
| Node poll-read for port file times out | Node responds to the browser with an error ("update couldn't start"). Node does not exit. Marker not written. |

### Testing

- **Unit tests for `resolve_node_with`:** Existing tests updated for the relaxed fallback behavior.
- **Unit test for port-probing bind:** New test confirming the probe skips occupied ports.
- **Integration test for port file round-trip:** Write port, read it back, verify.
- **Vitest for UpdateService redirect flow:** Mock the port file, verify the redirect response.
- **Manual smoke:** Apply an update on the VM, confirm browser redirects to operation-server port, then back to the app. Verify `127.0.0.1:{config_port}` is reachable post-update. Verify tray exit works.

### Files Changed

| File | Change |
|------|--------|
| `launcher/src/operation_server.rs` | Bind `config_port+1` with probe; write port file; `/api/discover` endpoint; delete port file on exit; remove wind-down from §40 path |
| `launcher/src/supervisor.rs` | Remove `wait_for_port_free` from §40 path |
| `launcher/src/spawn.rs` | `spawn_server` uses `resolve_node_with(deps_path)`; `resolve_node_with` relaxes strict mode |
| `src/server/UpdateService.ts` | Spawn operation-server, poll-read port file, respond with redirect page |
| `launcher/assets/operation-server-page.html` | Add `/api/discover` polling JS + timeout error |
| `common/src/config.rs` or similar | Port file path constant |

### Backwards Compatibility

None required. This is a beta redesign. The first update using the new code must be from a beta that already has it (fresh install or manual restart to pick up the new binary, then subsequent in-app updates work).
