# Local-Mode Update Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the port conflict, stale-binary, and seed-node bugs in the §40 local-mode update flow by having the operation-server bind a separate port from Node.

**Architecture:** The operation-server binds `config_port + 1` (probing upward) instead of `config_port`. Node spawns the operation-server, poll-reads a port file to discover its port, and serves a redirect to the browser. The operation-server probes for the new Node after extraction + relaunch and relays a redirect URL back to the browser via `/api/discover`. The `resolve_node_with` function is relaxed to fall through to seed when deps_path is set but node isn't there yet.

**Tech Stack:** Rust (launcher), TypeScript (Node server), HTML/JS (updating page)

**Spec:** `docs/superpowers/specs/2026-05-26-local-mode-update-redesign-design.md`

**Repo:** `C:/Users/jscha/source/repos/ws-scrcpy-web`

**Test commands:**
- Rust: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/launcher/Cargo.toml"`
- Node: `npm test --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web"`
- Type-check: `npx --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" tsc --noEmit`

---

### Task 1: Relax `resolve_node_with` strict mode (spawn.rs)

**Files:**
- Modify: `launcher/src/spawn.rs:26-49` (resolve_node_with + resolve_node)
- Modify: `launcher/src/spawn.rs:196-240` (tests)

- [ ] **Step 1: Update the failing test to expect fallback behavior**

Change the existing `resolve_node_strict_fails_when_deps_path_missing` test to verify that when `deps_path` is set but the node binary doesn't exist there, resolution falls through to seed:

```rust
#[test]
fn resolve_node_falls_back_to_seed_when_deps_path_set_but_node_missing() {
    let dir = tempdir().unwrap();
    let exe_dir = dir.path().join("exe");
    let seed = exe_dir.join("seed").join("node").join("node.exe");
    touch(&seed);

    let bogus_deps = dir.path().join("deps-empty");
    std::fs::create_dir_all(&bogus_deps).unwrap();

    let resolved = resolve_node_with(Some(bogus_deps.to_str().unwrap()), &exe_dir).unwrap();
    assert_eq!(resolved, seed);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/launcher/Cargo.toml" resolve_node_falls_back_to_seed_when_deps_path_set_but_node_missing -- --nocapture`

Expected: FAIL — `resolve_node_with` currently calls `bail!` when deps_path is set but node is missing.

- [ ] **Step 3: Add test for the error case (both paths missing)**

```rust
#[test]
fn resolve_node_errors_when_deps_and_seed_both_missing() {
    let dir = tempdir().unwrap();
    let exe_dir = dir.path().join("exe");
    std::fs::create_dir_all(&exe_dir).unwrap();

    let bogus_deps = dir.path().join("deps-empty");
    std::fs::create_dir_all(&bogus_deps).unwrap();

    let err = resolve_node_with(Some(bogus_deps.to_str().unwrap()), &exe_dir).unwrap_err();
    assert!(err.to_string().contains("Node not found"));
}
```

- [ ] **Step 4: Implement the relaxed `resolve_node_with`**

Replace `launcher/src/spawn.rs:26-49`:

```rust
/// Pure resolution: given an optional DEPS_PATH and an exe directory,
/// return the Node binary path or an error.
///
/// Priority: deps_path/node/node.exe > exe_dir/seed/node/node.exe > error.
/// When deps_path is set but node isn't there yet (first-run before
/// DependencyManager populates it), falls through to seed gracefully.
pub fn resolve_node_with(deps_path: Option<&str>, exe_dir: &Path) -> Result<PathBuf> {
    if let Some(deps) = deps_path {
        let candidate = Path::new(deps).join("node").join("node.exe");
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    let seed = exe_dir.join("seed").join("node").join("node.exe");
    if seed.exists() {
        return Ok(seed);
    }

    bail!(
        "Node not found at deps or seed (deps_path={:?}, seed={:?})",
        deps_path,
        seed
    )
}
```

- [ ] **Step 5: Update `spawn_server` to pass `deps_path` through**

Replace `launcher/src/spawn.rs:117` (`let node = resolve_node()?;` in the `#[cfg(windows)]` block) with:

```rust
let exe = std::env::current_exe().context("could not determine current exe path")?;
let exe_dir = exe.parent().context("exe has no parent dir")?.to_path_buf();
let node = resolve_node_with(
    deps_path.to_str().map(Some).unwrap_or(None),
    &exe_dir,
)?;
```

And replace `launcher/src/spawn.rs:158` (`let node = resolve_node()?;` in the `#[cfg(not(windows))]` block) with the same pattern:

```rust
let exe = std::env::current_exe().context("could not determine current exe path")?;
let exe_dir = exe.parent().context("exe has no parent dir")?.to_path_buf();
let node = resolve_node_with(
    deps_path.to_str().map(Some).unwrap_or(None),
    &exe_dir,
)?;
```

Both blocks already have `let exe` and `let work_dir` below — merge with the new `exe_dir` (they derive from the same value). The `resolve_server_entry()` call at line 118/159 can also use `exe_dir` directly via `resolve_server_entry_with(&exe_dir)`.

- [ ] **Step 6: Remove the old strict-mode test**

Delete the `resolve_node_strict_fails_when_deps_path_missing` test entirely — it tested the `bail!` behavior we just removed.

- [ ] **Step 7: Update the module-level doc comment**

Replace `launcher/src/spawn.rs:1-11`:

```rust
// Node child-process spawn for the launcher.
//
// Resolves the Node executable using a priority chain:
//   1. `deps_path` parameter → `<deps_path>/node/node.exe`
//   2. `<exe_dir>/seed/node/node.exe` (bundled fallback for first-run
//      before dependencies/ is populated, or when deps node is missing)
//   3. Error.
//
// Server entry is `<exe_dir>/dist/index.js`.
```

- [ ] **Step 8: Update the supervisor comment**

Replace `launcher/src/supervisor.rs:170-177`:

```rust
    // deps_path is passed to spawn::spawn_server which both:
    //   (a) uses it to resolve the Node binary (deps > seed fallback), and
    //   (b) sets it as DEPS_PATH on the Node child's env for DependencyManager.
    log::info(&format!("supervisor: deps_path resolved to {:?}", paths.deps_path));
```

- [ ] **Step 9: Run all tests**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/launcher/Cargo.toml" -- --nocapture`

Expected: ALL PASS.

- [ ] **Step 10: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/spawn.rs launcher/src/supervisor.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "fix: resolve node from deps_path before seed fallback

spawn_server now passes deps_path through to resolve_node_with
instead of calling resolve_node() which read DEPS_PATH from process
env (always empty). Relaxes strict mode to fall through to seed when
deps_path is set but node binary is missing (first-run bootstrap)."
```

---

### Task 2: Port file contract + port-probing bind (operation_server.rs)

**Files:**
- Modify: `launcher/src/operation_server.rs` (constants, new functions, tests)

- [ ] **Step 1: Add the port file constant and helper functions**

Add near the top of `operation_server.rs` (after the existing constants around lines 80-98):

```rust
const PORT_FILE_NAME: &str = "operation-server-port";

/// Write the bound port to `<dataRoot>/control/operation-server-port`.
/// Node's UpdateService poll-reads this to discover the redirect URL.
pub fn write_port_file(data_root: &Path, port: u16) -> std::io::Result<PathBuf> {
    let dir = data_root.join("control");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(PORT_FILE_NAME);
    std::fs::write(&path, port.to_string())?;
    Ok(path)
}

/// Read the operation-server port from the port file. Returns None if
/// the file doesn't exist or contains invalid data.
pub fn read_port_file(data_root: &Path) -> Option<u16> {
    let path = data_root.join("control").join(PORT_FILE_NAME);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
}

/// Delete the port file. Best-effort — called on operation-server exit.
pub fn delete_port_file(data_root: &Path) {
    let path = data_root.join("control").join(PORT_FILE_NAME);
    let _ = std::fs::remove_file(&path);
}
```

- [ ] **Step 2: Add a port-probing bind function**

Add after the port file helpers:

```rust
/// Bind to `0.0.0.0` on `start_port`, probing upward on EADDRINUSE.
/// Caps at `start_port + max_offset`. Retries transient errors for up to
/// `retry_timeout`. Returns the listener and the port it bound to.
pub fn bind_with_probe(
    start_port: u16,
    max_offset: u16,
    retry_timeout: Duration,
) -> Result<(TcpListener, u16), i32> {
    for offset in 0..=max_offset {
        let port = match start_port.checked_add(offset) {
            Some(p) => p,
            None => break,
        };
        let bind_start = Instant::now();
        loop {
            match TcpListener::bind(("0.0.0.0", port)) {
                Ok(listener) => return Ok((listener, port)),
                Err(e) => {
                    let is_in_use = e.kind() == std::io::ErrorKind::AddrInUse;
                    if is_in_use {
                        if offset < max_offset {
                            log::info(&format!(
                                "operation-server: port {port} in use, trying next"
                            ));
                            break; // try next port
                        }
                        // Last port in range, keep retrying until timeout
                    }
                    if bind_start.elapsed() >= retry_timeout {
                        if is_in_use {
                            log::error(&format!(
                                "operation-server: all ports {start_port}..={} in use after {retry_timeout:?}",
                                start_port.saturating_add(max_offset)
                            ));
                            return Err(3);
                        }
                        log::error(&format!(
                            "operation-server: bind 0.0.0.0:{port} failed after {retry_timeout:?}: {e}"
                        ));
                        return Err(3);
                    }
                    thread::sleep(Duration::from_millis(BIND_RETRY_INTERVAL_MS));
                }
            }
        }
    }
    log::error(&format!(
        "operation-server: no bindable port in range {start_port}..={}",
        start_port.saturating_add(max_offset)
    ));
    Err(3)
}
```

- [ ] **Step 3: Write tests for port file and bind_with_probe**

Add to the `mod tests` block at the bottom of `operation_server.rs`:

```rust
#[test]
fn write_and_read_port_file_round_trip() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = super::write_port_file(tmp.path(), 8001).expect("write");
    assert!(path.exists());
    assert_eq!(super::read_port_file(tmp.path()), Some(8001));
}

#[test]
fn read_port_file_returns_none_when_absent() {
    let tmp = tempfile::tempdir().expect("tempdir");
    assert_eq!(super::read_port_file(tmp.path()), None);
}

#[test]
fn delete_port_file_removes_file() {
    let tmp = tempfile::tempdir().expect("tempdir");
    super::write_port_file(tmp.path(), 9999).expect("write");
    super::delete_port_file(tmp.path());
    assert_eq!(super::read_port_file(tmp.path()), None);
}

#[test]
fn bind_with_probe_skips_occupied_port() {
    // Occupy the first port
    let blocker = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind blocker");
    let blocked_port = blocker.local_addr().expect("addr").port();

    // Probe should skip the blocked port and bind the next one
    let result = super::bind_with_probe(
        blocked_port,
        5,
        std::time::Duration::from_secs(1),
    );
    match result {
        Ok((_listener, port)) => assert!(port > blocked_port, "should have skipped to a higher port"),
        Err(_) => panic!("bind_with_probe should have found a free port"),
    }
}
```

- [ ] **Step 4: Run tests to verify**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/launcher/Cargo.toml" -- --nocapture port_file bind_with_probe`

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/operation_server.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat: add port file contract and port-probing bind

write_port_file/read_port_file/delete_port_file for the operation-
server ↔ Node coordination. bind_with_probe tries config_port+1
upward, skipping occupied ports."
```

---

### Task 3: Rewrite §40 path in operation_server.rs

**Files:**
- Modify: `launcher/src/operation_server.rs:240-412` (run function)

This is the core change — rewrite the §40 local-mode path to bind a separate port, write the port file, run the probe after relaunch, and serve `/api/discover`.

- [ ] **Step 1: Update the `run()` function's §40 bind logic**

Replace the bind block at lines 264-302 and the §40 block at lines 304-378 with:

```rust
    // §40 — local-mode update path. Binds config_port + 1 (probing upward)
    // to avoid port conflict with Node (which still holds config_port).
    if variant == OperationVariant::ApplyUpdate {
        if let Ok(install_root) = std::env::var("WS_SCRCPY_INSTALL_ROOT") {
            let install_root = PathBuf::from(install_root);
            let op_port_start = port.saturating_add(1);

            let (listener, bound_port) = match bind_with_probe(
                op_port_start,
                PROBE_MAX_OFFSET,
                Duration::from_secs(BIND_RETRY_TIMEOUT_SECS),
            ) {
                Ok(pair) => pair,
                Err(code) => return code,
            };

            if let Err(e) = listener.set_nonblocking(true) {
                log::error(&format!(
                    "operation-server: set_nonblocking failed (non-fatal): {e}"
                ));
            }

            log::info(&format!(
                "operation-server: §40 bound 0.0.0.0:{bound_port} (app port={port})"
            ));

            // Write port file so Node can discover our port for the redirect.
            if let Err(e) = write_port_file(&data_root, bound_port) {
                log::error(&format!(
                    "operation-server: failed to write port file: {e}"
                ));
            }

            // Stoppable background page-serving thread.
            let bg_stop = Arc::new(AtomicBool::new(false));
            let bg_stop2 = bg_stop.clone();
            let bg_listener = listener.try_clone().expect("clone listener");
            let bg_redirect: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            let bg_redirect2 = bg_redirect.clone();
            let _page_thread = thread::spawn(move || {
                while !bg_stop2.load(Ordering::SeqCst) {
                    accept_one(&bg_listener, &bg_redirect2, OperationVariant::ApplyUpdate);
                }
            });

            // --- Phase 2: Swap ---
            log::info("operation-server: §40 killing tray");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW_FLAG: u32 = 0x08000000;
                let _ = std::process::Command::new(r"C:\Windows\System32\taskkill.exe")
                    .args(["/F", "/IM", "ws-scrcpy-web-tray.exe", "/T"])
                    .creation_flags(CREATE_NO_WINDOW_FLAG)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            }
            thread::sleep(Duration::from_secs(3));

            let packages_dir = install_root.join("packages");
            let current_dir = install_root.join("current");
            match find_and_extract_nupkg(&packages_dir, &current_dir) {
                Ok(ver) => log::info(&format!("operation-server: extracted {ver} into current/")),
                Err(e) => {
                    log::error(&format!("operation-server: nupkg extraction failed: {e}"));
                    bg_stop.store(true, Ordering::SeqCst);
                    delete_port_file(&data_root);
                    return 4;
                }
            }

            thread::sleep(Duration::from_secs(1));
            log::info("operation-server: launching new launcher");
            #[cfg(windows)]
            {
                let launcher = current_dir.join("ws-scrcpy-web-launcher.exe");
                use std::os::windows::process::CommandExt;
                const DETACHED_PROCESS: u32 = 0x00000008;
                const CREATE_NO_WINDOW_FLAG: u32 = 0x08000000;
                match std::process::Command::new(&launcher)
                    .current_dir(&install_root)
                    .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW_FLAG)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                {
                    Ok(child) => log::info(&format!(
                        "operation-server: launched new launcher (pid {})", child.id()
                    )),
                    Err(e) => log::error(&format!(
                        "operation-server: failed to launch new launcher: {e}"
                    )),
                }
            }

            // --- Phase 3: Handoff ---
            // Probe for the new Node on config_port..+10 and publish redirect.
            let probe_redirect = bg_redirect.clone();
            thread::spawn(move || {
                probe_for_real_node_and_publish(port, probe_redirect);
            });

            // Serve pages until probe finds Node or 60s lifetime expires.
            let started_at = Instant::now();
            while started_at.elapsed() < Duration::from_secs(MAX_LIFETIME_SECS) {
                accept_one(&listener, &bg_redirect, OperationVariant::ApplyUpdate);
            }

            log::info("operation-server: §40 max lifetime elapsed, cleaning up");
            bg_stop.store(true, Ordering::SeqCst);
            delete_port_file(&data_root);
            return 0;
        }
    }

    // --- Service-mode / uninstall path (unchanged) ---
    // Bind config_port with retry (service-mode operation-server needs
    // the same port Node was on).
    let listener = {
        let bind_start = Instant::now();
        let mut first_busy_logged = false;
        loop {
            match TcpListener::bind(("0.0.0.0", port)) {
```

The rest of the `run()` function (from the original bind loop through the main loop + wind_down) stays unchanged — it's only used for service-mode.

- [ ] **Step 2: Update `build_response` to handle `/api/discover` in the §40 context**

The existing `build_response` function at line 616 already handles `/api/discover` (line 629). We need to update it so that when the redirect state has a value, `/api/discover` returns the new JSON shape:

Find the `/api/discover` handler block in `build_response` (lines 629-637) and replace it with:

```rust
        if path == "/api/discover" {
            // §40 redesign: /api/discover returns the redirect status.
            // The updating page polls this to know when the new Node is up.
            if let Some(url) = redirect {
                let body = format!(r#"{{"status":"ready","redirect":"{url}"}}"#);
                return format!(
                    "HTTP/1.1 200 OK\r\n\
                     Content-Type: application/json\r\n\
                     Content-Length: {}\r\n\
                     Cache-Control: no-store\r\n\
                     X-WsScrcpyWeb-Upgrade-Server: 1\r\n\
                     Connection: close\r\n\
                     \r\n\
                     {}",
                    body.len(),
                    body
                );
            }
            let body = r#"{"status":"updating"}"#;
            return format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: application/json\r\n\
                 Content-Length: {}\r\n\
                 Cache-Control: no-store\r\n\
                 X-WsScrcpyWeb-Upgrade-Server: 1\r\n\
                 Connection: close\r\n\
                 \r\n\
                 {}",
                body.len(),
                body
            );
        }
```

- [ ] **Step 3: Run all Rust tests**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/launcher/Cargo.toml" -- --nocapture`

Expected: ALL PASS.

- [ ] **Step 4: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/operation_server.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(§40): rewrite local-mode path to bind separate port

Operation-server now binds config_port+1 (probing upward) instead of
config_port. Writes port file for Node discovery. Runs probe after
relaunch to find new Node and publishes redirect via /api/discover.
Eliminates the port conflict that caused IPv4-only binding."
```

---

### Task 4: Simplify supervisor §40 path

**Files:**
- Modify: `launcher/src/supervisor.rs:132-157`

- [ ] **Step 1: Gate stop-marker + port-wait to service-mode only**

Replace `launcher/src/supervisor.rs:132-157` with:

```rust
        // §32 Part 5 — coordinate with any in-flight operation-server.
        // In service-mode, the operation-server binds the SAME port as
        // Node (config_port), so we need the stop-marker + port-wait
        // dance. In §40 local-mode, the operation-server binds a
        // DIFFERENT port (config_port+1), so no coordination needed.
        if cfg.is_service_mode() {
            let port = cfg.web_port.unwrap_or(8000);
            if let Err(e) = crate::operation_server::write_stop_marker(&paths.data_root) {
                log::error(&format!(
                    "supervisor: could not write operation-server stop marker (non-fatal): {e}"
                ));
            }
            crate::operation_server::wait_for_port_free(
                port,
                std::time::Duration::from_secs(5),
            );
            log::info(&format!(
                "supervisor: port {port} verified free, proceeding to spawn Node"
            ));
        }
```

- [ ] **Step 2: Run Rust tests**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/launcher/Cargo.toml" -- --nocapture`

Expected: ALL PASS.

- [ ] **Step 3: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/supervisor.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "fix(§40): skip wait_for_port_free in local-mode update

Operation-server now uses a separate port in §40, so the supervisor
no longer needs stop-marker + port-wait coordination for local mode.
Service-mode path unchanged."
```

---

### Task 5: Rewrite updating page JS for `/api/discover` polling

**Files:**
- Modify: `launcher/assets/operation-server-page.html:76-142`

- [ ] **Step 1: Replace the `<script>` block**

Replace `launcher/assets/operation-server-page.html:76-142` (the entire `<script>` block through `</html>`) with:

```html
<script>
(function () {
  var POLL_MS = 2000;
  var TIMEOUT_MS = 60000;
  var detail = document.getElementById('detail');
  var note = document.querySelector('.note');
  var start = Date.now();

  function poll() {
    if (Date.now() - start > TIMEOUT_MS) {
      if (detail) detail.textContent = 'update may have failed';
      if (note) note.textContent = 'try restarting the app manually';
      return;
    }

    fetch('/api/discover', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) {
          setTimeout(poll, POLL_MS);
          return;
        }
        return r.json().then(function (body) {
          if (body && body.status === 'ready' && body.redirect) {
            if (detail) detail.textContent = 'redirecting';
            setTimeout(function () { location.href = body.redirect; }, 500);
            return;
          }
          setTimeout(poll, POLL_MS);
        });
      })
      .catch(function () {
        setTimeout(poll, POLL_MS);
      });
  }

  setTimeout(poll, POLL_MS);
})();
</script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/assets/operation-server-page.html
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(§40): rewrite updating page to poll /api/discover

Replaces the old /api/config polling (which relied on being on the
same port as Node) with /api/discover polling on the operation-
server's own port. 60s timeout shows error message."
```

---

### Task 6: UpdateService + UpdatesApi redirect flow (Node side)

**Files:**
- Modify: `src/server/UpdateService.ts:331-390`
- Modify: `src/server/api/UpdatesApi.ts:117-163`
- Modify: `src/server/Config.ts` (add `operationServerPortFilePath` getter)

- [ ] **Step 1: Add `operationServerPortFilePath` getter to Config.ts**

Add after the `applyUpdatePendingMarkerPath` getter (line 531 of `src/server/Config.ts`):

```typescript
    public get operationServerPortFilePath(): string {
        const base = this._dataRoot !== null
            ? this._dataRoot
            : path.dirname(this._dependenciesPath);
        return path.join(base, 'control', 'operation-server-port');
    }
```

- [ ] **Step 2: Add `pollOperationServerPort` method to UpdateService.ts**

Add after `writeApplyUpdatePendingMarker` (around line 417):

```typescript
    private async pollOperationServerPort(timeoutMs = 5000, intervalMs = 100): Promise<number | null> {
        const portFilePath = Config.getInstance().operationServerPortFilePath;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const content = await fs.promises.readFile(portFilePath, 'utf8');
                const port = parseInt(content.trim(), 10);
                if (!isNaN(port) && port > 0 && port <= 65535) {
                    return port;
                }
            } catch {
                // file doesn't exist yet
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        return null;
    }
```

- [ ] **Step 3: Update `applyUpdate` to spawn operation-server and poll for port**

Replace `src/server/UpdateService.ts:331-390` with:

```typescript
    public async applyUpdate(): Promise<{ redirectPort: number | null }> {
        if (!this.mgr || !this.state.pendingUpdate || this.state.status !== 'ready') {
            throw new Error(`apply not allowed in current state: ${this.state.status}`);
        }
        log.info(`applying update v${this.state.availableVersion}`);
        await this.preApplyHygiene();

        await this.writeApplyUpdatePendingMarker();

        const installMode = Config.getInstance().getAppConfig().installMode;
        const isServiceMode = installMode === 'user-service' || installMode === 'system-service';

        if (isServiceMode) {
            this.mgr.waitExitThenApplyUpdate(this.state.pendingUpdate, true, false);
            return { redirectPort: null };
        }

        // Local mode: the supervisor spawns the operation-server on clean
        // exit. We don't spawn it here — the marker signals the supervisor.
        // Poll-read the port file to discover the operation-server's port
        // so we can redirect the browser.
        //
        // Note: the operation-server isn't spawned until AFTER Node exits,
        // so we can't poll here — we return null and let the API handler
        // use a delayed strategy (exit, let supervisor spawn op-server,
        // browser reconnects via the existing ServerReachabilityOverlay
        // or a frontend redirect).
        return { redirectPort: null };
    }
```

Wait — re-reading the spec, the flow is: Node spawns the operation-server BEFORE exiting (via `spawn_detached_helper`). But looking at the current code, the supervisor spawns it AFTER Node exits.

The spec says in Phase 1:
> 2. `UpdateService.applyUpdate()` spawns the operation-server as a detached process

But the current architecture has the supervisor doing this. Let me re-read the spec...

The spec says Node spawns it, then poll-reads the port file, then redirects. This means we need to move the spawn from the supervisor into UpdateService.

- [ ] **Step 3 (revised): Move operation-server spawn into UpdateService**

Replace `src/server/UpdateService.ts:331-390`:

```typescript
    public async applyUpdate(): Promise<{ redirectPort: number | null }> {
        if (!this.mgr || !this.state.pendingUpdate || this.state.status !== 'ready') {
            throw new Error(`apply not allowed in current state: ${this.state.status}`);
        }
        log.info(`applying update v${this.state.availableVersion}`);
        await this.preApplyHygiene();

        const installMode = Config.getInstance().getAppConfig().installMode;
        const isServiceMode = installMode === 'user-service' || installMode === 'system-service';

        await this.writeApplyUpdatePendingMarker();

        if (isServiceMode) {
            this.mgr.waitExitThenApplyUpdate(this.state.pendingUpdate, true, false);
            return { redirectPort: null };
        }

        // Local mode: spawn the operation-server from Node (before exit)
        // so we can poll-read its port file and redirect the browser.
        // The operation-server binds config_port+1, writes its port to
        // <dataRoot>/control/operation-server-port, then waits for us to
        // exit so it can extract the nupkg.
        const cfg = Config.getInstance();
        const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
        const helperPath = path.join(
            dataRoot,
            'control', 'operation-server', 'ws-scrcpy-web-launcher.exe',
        );
        // installRoot is two levels up from __dirname (dist/ inside current/)
        const installRoot = path.resolve(__dirname, '..', '..');

        try {
            const child = spawn(helperPath, ['--operation-server'], {
                cwd: dataRoot,
                detached: true,
                stdio: 'ignore',
                env: {
                    ...process.env,
                    WS_SCRCPY_INSTALL_ROOT: installRoot,
                },
            });
            child.unref();
            log.info(`applyUpdate: spawned operation-server (pid ${child.pid})`);
        } catch (err) {
            log.error(`applyUpdate: failed to spawn operation-server: ${(err as Error).message}`);
            return { redirectPort: null };
        }

        const port = await this.pollOperationServerPort();
        if (port !== null) {
            log.info(`applyUpdate: operation-server ready on port ${port}`);
        } else {
            log.warn('applyUpdate: operation-server port file not found within timeout');
        }

        return { redirectPort: port };
    }
```

Update the `child_process` import at line 2 of `UpdateService.ts`:

```typescript
import { execFile, spawn } from 'child_process';
```

- [ ] **Step 4: Update `handleApply` in UpdatesApi.ts to serve the redirect**

Replace `src/server/api/UpdatesApi.ts:117-163`:

```typescript
    private async handleApply(res: ServerResponse): Promise<boolean> {
        const s = this.svc.getStatus();
        if (!s.isInstalled) {
            const body: UpdatesErrorResponse = {
                ok: false,
                error: 'dev mode — packaging features disabled',
            };
            res.writeHead(503);
            res.end(JSON.stringify(body));
            return true;
        }
        if (s.status !== 'ready') {
            const body: UpdatesErrorResponse = {
                ok: false,
                error: `apply not allowed in current state: ${s.status}`,
            };
            res.writeHead(409);
            res.end(JSON.stringify(body));
            return true;
        }

        let redirectPort: number | null = null;
        try {
            const result = await this.svc.applyUpdate();
            redirectPort = result.redirectPort;
        } catch (err) {
            const body: UpdatesErrorResponse = { ok: false, error: (err as Error).message };
            res.writeHead(500);
            res.end(JSON.stringify(body));
            return true;
        }

        if (redirectPort !== null) {
            // Serve an HTML page that redirects the browser to the
            // operation-server's updating page on its own port.
            const redirectUrl = `http://localhost:${redirectPort}/`;
            const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>updating</title></head>
<body><p>redirecting to update page...</p>
<script>window.location.href=${JSON.stringify(redirectUrl)};</script>
</body></html>`;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } else {
            const body: UpdatesApplyResponse = { ok: true };
            res.writeHead(200);
            res.end(JSON.stringify(body));
        }

        this.schedule(() => {
            log.info('exiting (process.exit 0) after applyUpdate');
            this.exit(0);
        }, APPLY_EXIT_DELAY_MS);
        return true;
    }
```

- [ ] **Step 5: Remove operation-server spawn from supervisor §40 path**

In `launcher/src/supervisor.rs`, replace lines 200-232 (the §40 block inside `match reason { None => { ... }}`):

```rust
                // §40 — local-mode update: Node already spawned the
                // operation-server before exiting (it needed the port
                // file for the browser redirect). The apply-update-
                // pending marker was consumed by Node writing it; we
                // just exit cleanly.
                //
                // In service mode, Servy's post-stop.bat handles the
                // operation-server spawn + sc start relaunch.
                return Ok(code);
```

Wait — the supervisor currently deletes the marker AND spawns the helper. If we move the spawn to Node, the supervisor still needs to delete the marker (or not — the operation-server cleans it at line 261). Actually, the supervisor deletes `apply-update-pending` at line 222. But the operation-server also checks for it in `detect_operation_variant` at line 117 — it needs it to still exist. However, the supervisor deletes it BEFORE spawning the helper (line 222 before line 230).

In the current code, the supervisor deletes the marker at 222 but `detect_operation_variant` doesn't need it because the operation-server gets `WS_SCRCPY_INSTALL_ROOT` via env var (line 308), not via the marker. The marker is just used by the supervisor to decide whether to spawn.

With the new design, Node spawns the operation-server directly and passes `WS_SCRCPY_INSTALL_ROOT` via env. The supervisor doesn't need to detect the marker at all for the spawn. But the marker still serves as the signal for "this was an update exit, not a user stop" — Node writes it, supervisor reads it... but we don't need the supervisor to act on it anymore since Node already spawned the operation-server.

Simplify: just remove the §40 block from the supervisor entirely. The marker cleanup can happen in the operation-server.

```rust
                log::info("supervisor: clean exit; not restarting");
                return Ok(code);
```

Replace lines 199-234 with just:

```rust
            None => {
                log::info("supervisor: clean exit; not restarting");
                return Ok(code);
            }
```

- [ ] **Step 6: Run type-check and vitest**

Run: `npx --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" tsc --noEmit`
Run: `npm test --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web"`

Expected: tsc clean, vitest passes.

- [ ] **Step 7: Run Rust tests**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/launcher/Cargo.toml" -- --nocapture`

Expected: ALL PASS.

- [ ] **Step 8: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/UpdateService.ts src/server/api/UpdatesApi.ts src/server/Config.ts launcher/src/supervisor.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(§40): Node spawns operation-server and redirects browser

UpdateService spawns the operation-server, poll-reads the port file,
and returns the port. UpdatesApi serves an HTML redirect to the
operation-server's port. Supervisor no longer handles the §40 spawn."
```

---

### Task 7: CHANGELOG + docs update

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add CHANGELOG entry**

Add under `[Unreleased]` → `### Fixed`:

```markdown
- **Local-mode update redesign (§40).** Operation-server now binds `config_port + 1` (probing upward) instead of competing with Node for `config_port`. Eliminates the IPv4-dead / dual-stack corruption bug where `127.0.0.1:8000` became unreachable after updates while `[::1]:8000` worked. Three stacked bugs fixed: port conflict (separate port), stale helper binary (neutralized — old code fails gracefully), Node resolution (`spawn_server` now resolves from `dependencies/node/` before falling back to `seed/node/`). Browser redirect flow: Node spawns operation-server → poll-reads port file → serves redirect to browser → operation-server probes for new Node → redirects browser back.
```

- [ ] **Step 2: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add CHANGELOG.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs: CHANGELOG entry for §40 local-mode update redesign"
```

---

### Task 8: Version bump + manual smoke

- [ ] **Step 1: Bump to v0.1.28-beta.17**

Run: `npm run --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" version:bump 0.1.28-beta.17`

Stage and commit all version files (package.json + root Cargo.toml + Cargo.lock):

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add package.json Cargo.toml Cargo.lock
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "chore: bump to v0.1.28-beta.17"
```

- [ ] **Step 2: Create PR and merge**

Create a PR encompassing all commits from Tasks 1-7 + the version bump.

- [ ] **Step 3: Manual smoke on VM**

After the release publishes:
1. Install beta.17 fresh (or update from beta.16 — requires killing + restarting launcher once to pick up the new helper binary)
2. Let the app detect a subsequent update (or re-trigger from beta.17)
3. Click "apply update" in browser
4. **Verify:** browser redirects to `localhost:8001` (or similar) showing updating page
5. **Verify:** updating page eventually redirects back to `localhost:8000`
6. **Verify:** `http://127.0.0.1:8000` is reachable (IPv4 works)
7. **Verify:** `http://[::1]:8000` is reachable (IPv6 works)
8. **Verify:** tray exit works (POST to `127.0.0.1:8000/api/server/shutdown` returns 200)
9. **Verify:** `Get-NetTCPConnection -LocalPort 8000 -State Listen` shows only ONE process
