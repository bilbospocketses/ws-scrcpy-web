// §32 Part 5 — launcher-served "updating, please wait…" page during the
// in-app upgrade window.
//
// (Phase 1 rearchitecture renamed this subsystem `upgrade-server` →
// `operation-server` to reflect its broader role; the legacy
// `--upgrade-server` CLI flag is kept as a read-time alias for ~2 release
// cycles so existing post-stop.bat files keep working.)
//
// Background: §32 Part 4 (the cmd.exe + bat post-stop architecture) closed
// the service-restart race so that the new Node binds the port reliably
// within ~15s of clicking Apply. But during that ~15s window, browsers
// that try to load the URL (refresh, new tab, fresh navigation) hit "port
// connection refused" and the OS renders its "this site can't be reached"
// page. v0.1.25-beta.18 → beta.19 smoke confirmed this gap: the in-page
// ServerReachabilityOverlay handled the "user is watching the loaded
// page" case poorly (browser auto-navigated away on graceful socket
// close before the overlay's 10s detection window fired). Part 5 fills
// the gap with a small server-side mechanism instead of a browser-side
// one — user explicitly rejected Service Workers as fragile.
//
// Architecture:
//   1. Post-stop bat spawns `<launcher> --operation-server` AFTER Node
//      exits but BEFORE `sc start`. The bat fire-and-forget-spawns, then
//      continues to its `timeout` + `sc start` sequence.
//   2. Operation-server reads the web port from config.json, binds it,
//      serves a static "updating" HTML page on all paths (200 for root,
//      503 for /api/*). HTML page has inline JS that polls /api/config
//      every 1s, reloads the page when real app responds with 200 JSON.
//   3. Operation-server self-exits on either:
//      - <dataRoot>/control/operation-server-stop marker present (the new
//        supervised launcher writes this before spawning Node) — legacy
//        `upgrade-server-stop` marker also honored at read time.
//      - 30 seconds elapsed (safety cap; if Node isn't up by then, the
//        user is hitting a deeper problem the upgrade page can't paper
//        over)
//   4. Each TCP connection handled in its own short-lived thread.
//      Connection count during a typical upgrade is single-digit;
//      no need for async.
//
// Subcommand argv: `<launcher> --operation-server` (canonical;
// `--upgrade-server` accepted as legacy alias)
//   - No positional args (port resolved from config.json)
//   - Self-exits cleanly; no shutdown handshake required from caller
//
// Exit codes:
//   0 — clean exit (stop marker observed OR max lifetime elapsed)
//   3 — bind failed (port in use; usually means we lost the race to new Node)
//   4 — config.json read failed
//   5 — could not resolve data_root

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::log;

const MAX_LIFETIME_SECS: u64 = 30;
const STOP_MARKER_POLL_MS: u64 = 200;
const ACCEPT_TIMEOUT_MS: u64 = 200;
const STOP_MARKER_FILENAME: &str = "operation-server-stop";

/// Legacy stop-marker filename. Kept as a read-time fallback for ~2 release
/// cycles so an operation-server spawned by an OLD post-stop.bat (written by
/// pre-Phase-1 installs that still call `--upgrade-server` and write the
/// legacy marker) still exits when the new launcher signals it. Writers
/// (`write_stop_marker`) always use the canonical name. Removed in a
/// follow-up PR ~2 release cycles after Phase 1 ships.
const LEGACY_STOP_MARKER_FILENAME: &str = "upgrade-server-stop";

// §32 Part 5b — the upgrade-server is now spawned BEFORE Node exits (from
// UpdateService.applyUpdate in service mode). Node still holds the port at
// spawn time, so the initial bind fails. Retry in a tight loop until Node's
// process.exit() releases the port — typically within milliseconds of the
// graceful WebSocket close, well inside the browser's WS-reconnect window.
// 10s total timeout is the safety cap; if Node hasn't exited by then, the
// apply is hung on something deeper than the upgrade-server can paper over.
const BIND_RETRY_INTERVAL_MS: u64 = 25;
const BIND_RETRY_TIMEOUT_SECS: u64 = 10;

// §32 Part 5b port-shift handling — when the new Node loses its preferred
// port (because upgrade-server still holds it past the supervisor's
// wait_for_port_free timeout), Node auto-shifts to the next free port.
// Without compensation the user's browser stays stuck on the updating page
// served at the OLD port while the real app is on the NEW port. After the
// stop marker is detected, a background probe thread sweeps ports
// [config_port, +1, +2, ..., +PROBE_MAX_OFFSET] for the real Node's
// /api/config response. When found, the redirect URL is published to the
// shared state so connection handlers can return 200 + redirect JSON to
// the polling page, driving the browser to the new port.
const WIND_DOWN_TOTAL_SECS: u64 = 15;
const PROBE_MAX_OFFSET: u16 = 10;
const PROBE_INTERVAL_MS: u64 = 100;
const PROBE_CONNECT_TIMEOUT_MS: u64 = 500;
const PROBE_REQUEST_TIMEOUT_MS: u64 = 2000;

const OPERATION_PAGE: &str = include_str!("../assets/operation-server-page.html");

/// Which operation triggered this operation-server instance? Drives the
/// wait-page text variant served to the browser. Detected once at spawn
/// time by checking which marker file exists under `<data_root>/control/`;
/// the bat that spawned us deletes the marker AFTER spawning, so on the
/// happy path the marker is still present at our startup. If both markers
/// are present (defensive edge case — would indicate a bug elsewhere),
/// ApplyUpdate wins per the bat's branch order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationVariant {
    ApplyUpdate,
    Uninstall,
}

pub fn detect_operation_variant(data_root: &Path) -> OperationVariant {
    let control = data_root.join("control");
    if control.join("apply-update-pending").exists() {
        return OperationVariant::ApplyUpdate;
    }
    if control.join("uninstall-pending").exists() {
        return OperationVariant::Uninstall;
    }
    OperationVariant::ApplyUpdate
}

/// Render the operation-server page with per-variant title + body text.
/// Uses two-token substitution on the static HTML asset:
///   __OPERATION_TITLE__ → wait-page title text
///   __OPERATION_BODY__  → brief explanatory paragraph
pub fn render_operation_page(variant: OperationVariant) -> String {
    let (title, body) = match variant {
        OperationVariant::ApplyUpdate => (
            "Updating app, please wait...",
            "ws-scrcpy-web is applying an update. The page will reload automatically when the new version is ready.",
        ),
        OperationVariant::Uninstall => (
            "Uninstalling service, please wait...",
            "ws-scrcpy-web is uninstalling its service. The page will reload automatically once the local-mode app is back up.",
        ),
    };
    OPERATION_PAGE
        .replace("__OPERATION_TITLE__", title)
        .replace("__OPERATION_BODY__", body)
}

/// Public entry: if argv contains `--operation-server` (or the legacy alias
/// `--upgrade-server`), handle it and return `Some(exit_code)`. Otherwise
/// return None (caller proceeds to normal launch).
pub fn handle(args: &[String]) -> Option<i32> {
    if !is_operation_server_flag(args) {
        return None;
    }
    Some(run())
}

/// Returns true if argv contains either the canonical `--operation-server`
/// flag OR the legacy `--upgrade-server` alias (kept for ~2 release cycles
/// so existing installs' post-stop.bat files keep working until they're
/// rewritten by a fresh install). Pure function — testable without binding
/// any port.
fn is_operation_server_flag(args: &[String]) -> bool {
    args.iter()
        .any(|a| a == "--operation-server" || a == "--upgrade-server")
}

/// Returns true if either the canonical or legacy stop marker is present
/// under `<data_root>/control/`. Pure function — no I/O side effects beyond
/// the existence checks. Extracted from `run()`'s polling loop for unit-
/// testability + dual-name support per Phase 1 of the operation-server
/// rearchitecture.
pub fn should_exit_for_stop_marker(data_root: &Path) -> bool {
    let dir = data_root.join("control");
    dir.join(STOP_MARKER_FILENAME).exists() || dir.join(LEGACY_STOP_MARKER_FILENAME).exists()
}

/// Find the latest full nupkg in `packages_dir` and extract its `lib/app/`
/// contents into `current_dir` (overwrite). Returns the version string on
/// success. This replaces Update.exe for local-mode updates — no rename
/// dance, no process-tree scanning, no CWD handle locks.
fn find_and_extract_nupkg(packages_dir: &Path, current_dir: &Path) -> Result<String, String> {
    let entry = std::fs::read_dir(packages_dir)
        .map_err(|e| format!("cannot read packages dir: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let s = name.to_string_lossy();
            s.ends_with("-full.nupkg")
        })
        .max_by_key(|e| e.file_name());

    let nupkg_path = entry
        .ok_or_else(|| "no *-full.nupkg found in packages dir".to_string())?
        .path();

    let version = nupkg_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    log::info(&format!("operation-server: extracting {nupkg_path:?}"));

    let file = std::fs::File::open(&nupkg_path)
        .map_err(|e| format!("cannot open nupkg: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("cannot read nupkg as zip: {e}"))?;

    let prefix = "lib/app/";
    let mut extracted = 0u32;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("zip entry {i}: {e}"))?;
        let raw_name = entry.name().to_string();
        if !raw_name.starts_with(prefix) {
            continue;
        }
        let relative = &raw_name[prefix.len()..];
        if relative.is_empty() {
            continue;
        }
        let dest = current_dir.join(relative);
        if raw_name.ends_with('/') {
            let _ = std::fs::create_dir_all(&dest);
        } else {
            if let Some(parent) = dest.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let mut out = std::fs::File::create(&dest)
                .map_err(|e| format!("cannot create {dest:?}: {e}"))?;
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| format!("cannot write {dest:?}: {e}"))?;
            extracted += 1;
        }
    }

    log::info(&format!("operation-server: extracted {extracted} files"));
    Ok(version)
}

fn run() -> i32 {
    log::info("operation-server: starting");

    let data_root = match common::config::data_root_from_env() {
        Some(p) => p,
        None => {
            log::error("operation-server: cannot resolve data_root");
            return 5;
        }
    };

    let variant = detect_operation_variant(&data_root);
    log::info(&format!("operation-server: variant={variant:?}"));

    let cfg = common::config::AppConfig::load(&data_root);
    let port = cfg.web_port.unwrap_or(8000);
    log::info(&format!("operation-server: data_root={data_root:?} port={port}"));

    let control_dir = data_root.join("control");
    // Clean any stale markers (both canonical + legacy filenames) from a
    // prior operation so we don't insta-exit.
    let _ = std::fs::remove_file(control_dir.join(STOP_MARKER_FILENAME));
    let _ = std::fs::remove_file(control_dir.join(LEGACY_STOP_MARKER_FILENAME));

    let listener = {
        let bind_start = Instant::now();
        let mut first_busy_logged = false;
        loop {
            match TcpListener::bind(("0.0.0.0", port)) {
                Ok(l) => break l,
                Err(e) => {
                    // First failure logs once at info level (expected when
                    // spawned pre-exit while Node still holds the port).
                    // Subsequent failures are silent to avoid log spam.
                    if !first_busy_logged {
                        log::info(&format!(
                            "operation-server: bind 0.0.0.0:{port} busy ({e}), retrying every {BIND_RETRY_INTERVAL_MS}ms until port is free (timeout {BIND_RETRY_TIMEOUT_SECS}s)"
                        ));
                        first_busy_logged = true;
                    }
                    if bind_start.elapsed() >= Duration::from_secs(BIND_RETRY_TIMEOUT_SECS) {
                        log::error(&format!(
                            "operation-server: bind 0.0.0.0:{port} failed after {BIND_RETRY_TIMEOUT_SECS}s of retries: {e} — giving up"
                        ));
                        return 3;
                    }
                    thread::sleep(Duration::from_millis(BIND_RETRY_INTERVAL_MS));
                }
            }
        }
    };

    // Set a short accept timeout so we can periodically check the stop
    // marker + lifetime cap without blocking forever.
    if let Err(e) = listener.set_nonblocking(true) {
        log::error(&format!(
            "operation-server: set_nonblocking failed (non-fatal): {e}"
        ));
    }

    log::info(&format!(
        "operation-server: bound 0.0.0.0:{port}, serving updating page (max lifetime {MAX_LIFETIME_SECS}s)"
    ));

    // §40 — local-mode update: extract nupkg + relaunch, all from this
    // process (no Update.exe, no bat). Triggered by WS_SCRCPY_INSTALL_ROOT
    // env var set by the supervisor for local-mode apply-update only.
    if variant == OperationVariant::ApplyUpdate {
        if let Ok(install_root) = std::env::var("WS_SCRCPY_INSTALL_ROOT") {
            let install_root = PathBuf::from(install_root);
            // Serve the page on a background thread while we do the apply.
            let bg_listener = listener.try_clone().expect("clone listener");
            let bg_redirect: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            let bg_redirect2 = bg_redirect.clone();
            let page_thread = thread::spawn(move || {
                loop {
                    accept_one(&bg_listener, &bg_redirect2, OperationVariant::ApplyUpdate);
                }
            });

            log::info("operation-server: local-mode apply — killing tray");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                let _ = std::process::Command::new(r"C:\Windows\System32\taskkill.exe")
                    .args(["/F", "/IM", "ws-scrcpy-web-tray.exe", "/T"])
                    .creation_flags(CREATE_NO_WINDOW)
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
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                match std::process::Command::new(&launcher)
                    .current_dir(&install_root)
                    .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
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
            // Fall through to normal stop-marker loop — new launcher will
            // write it, triggering wind-down + browser redirect.
            drop(page_thread);
        }
    }

    let stop_flag = Arc::new(AtomicBool::new(false));
    let redirect_state: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let started_at = Instant::now();

    loop {
        if stop_flag.load(Ordering::SeqCst) {
            log::info("operation-server: stop_flag observed, exiting");
            return 0;
        }
        if should_exit_for_stop_marker(&data_root) {
            log::info(&format!(
                "operation-server: stop marker present under {:?}/control/, entering wind-down",
                data_root
            ));
            // Clean up BOTH possible marker filenames so a residual legacy
            // marker doesn't immediately re-trigger wind-down on the next
            // operation-server instance.
            let cleanup_dir = data_root.join("control");
            let _ = std::fs::remove_file(cleanup_dir.join(STOP_MARKER_FILENAME));
            let _ = std::fs::remove_file(cleanup_dir.join(LEGACY_STOP_MARKER_FILENAME));
            return wind_down(listener, redirect_state, port, variant);
        }
        if started_at.elapsed() >= Duration::from_secs(MAX_LIFETIME_SECS) {
            log::info(&format!(
                "operation-server: max lifetime {MAX_LIFETIME_SECS}s elapsed, exiting"
            ));
            return 0;
        }

        accept_one(&listener, &redirect_state, variant);
    }
}

/// Wind-down phase entered after the stop marker is observed. Spawns a
/// background probe thread that sweeps neighboring ports for the new Node
/// (handles the case where Node lost the port race and auto-shifted to
/// e.g. config_port+1), and keeps serving connections so the polling page
/// can pick up the resulting redirect.
fn wind_down(listener: TcpListener, redirect_state: Arc<Mutex<Option<String>>>, config_port: u16, variant: OperationVariant) -> i32 {
    let probe_state = redirect_state.clone();
    thread::spawn(move || {
        probe_for_real_node_and_publish(config_port, probe_state);
    });

    let wind_down_start = Instant::now();
    loop {
        if wind_down_start.elapsed() >= Duration::from_secs(WIND_DOWN_TOTAL_SECS) {
            log::info(&format!(
                "operation-server: wind-down window ({WIND_DOWN_TOTAL_SECS}s) elapsed, exiting"
            ));
            return 0;
        }
        accept_one(&listener, &redirect_state, variant);
    }
}

/// One iteration of the non-blocking accept loop. Spawns a thread per
/// accepted connection. Shared between the normal-serving loop and the
/// wind-down loop so connection handling stays uniform.
fn accept_one(listener: &TcpListener, redirect_state: &Arc<Mutex<Option<String>>>, variant: OperationVariant) {
    match listener.accept() {
        Ok((stream, peer)) => {
            log::info(&format!("operation-server: connection from {peer}"));
            let state_clone = redirect_state.clone();
            // Variant is Copy, so capture-by-value into the thread closure
            // alongside the cloned state Arc.
            let v = variant;
            // Spawn a thread per connection. Short-lived; we don't track
            // JoinHandles. Connection count during an upgrade window is
            // single-digit.
            thread::spawn(move || {
                handle_connection(stream, state_clone, v);
            });
        }
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            // No pending connection. Sleep briefly, then re-check stop
            // conditions on the next iteration.
            thread::sleep(Duration::from_millis(ACCEPT_TIMEOUT_MS.max(STOP_MARKER_POLL_MS)));
        }
        Err(e) => {
            log::error(&format!("operation-server: accept error: {e}"));
            thread::sleep(Duration::from_millis(500));
        }
    }
}

/// Probe localhost:config_port..config_port+PROBE_MAX_OFFSET for a real
/// Node responding to /api/config (200 OK without the upgrade-server
/// sentinel header). On match, write `http://localhost:<port>/` to the
/// shared redirect state. Polls every PROBE_INTERVAL_MS until a match is
/// found or the wind-down window closes. Caller is the background thread
/// spawned by wind_down().
fn probe_for_real_node_and_publish(config_port: u16, redirect_state: Arc<Mutex<Option<String>>>) {
    log::info(&format!(
        "operation-server: probe starting (sweeping ports {config_port}..={}, every {PROBE_INTERVAL_MS}ms)",
        config_port.saturating_add(PROBE_MAX_OFFSET)
    ));
    let probe_start = Instant::now();
    loop {
        if probe_start.elapsed() >= Duration::from_secs(WIND_DOWN_TOTAL_SECS) {
            log::info("operation-server: probe gave up — no real Node found in any neighboring port within wind-down window");
            return;
        }
        for offset in 0..=PROBE_MAX_OFFSET {
            // Saturating add — bail on the rare configs where config_port
            // is in the top of the u16 range and offset would overflow.
            let probe_port = match config_port.checked_add(offset) {
                Some(p) => p,
                None => break,
            };
            if is_real_node_at_port(probe_port) {
                let url = format!("http://localhost:{probe_port}/");
                log::info(&format!(
                    "operation-server: probe found real Node on port {probe_port} (offset +{offset}) — publishing redirect {url}"
                ));
                if let Ok(mut guard) = redirect_state.lock() {
                    *guard = Some(url);
                }
                return;
            }
        }
        thread::sleep(Duration::from_millis(PROBE_INTERVAL_MS));
    }
}

/// Single probe attempt against localhost:port. Returns true iff a TCP
/// connection succeeds AND a GET /api/config gets back a `HTTP/* 200`
/// response that does NOT carry the X-WsScrcpyWeb-Upgrade-Server sentinel
/// header. The sentinel check filters out probes that connect back to the
/// upgrade-server itself (when probe_port == config_port).
fn is_real_node_at_port(port: u16) -> bool {
    let addr: std::net::SocketAddr = match format!("127.0.0.1:{port}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(PROBE_CONNECT_TIMEOUT_MS)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(PROBE_REQUEST_TIMEOUT_MS)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(PROBE_REQUEST_TIMEOUT_MS)));
    if stream
        .write_all(b"GET /api/config HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    // Status line check — accept any HTTP/* version that starts with "200".
    let first_line = response.lines().next().unwrap_or("");
    let is_200 = first_line.starts_with("HTTP/") && first_line.contains(" 200");
    let has_sentinel = response
        .to_ascii_lowercase()
        .contains("x-wsscrcpyweb-upgrade-server: 1");
    is_200 && !has_sentinel
}

fn handle_connection(mut stream: TcpStream, redirect_state: Arc<Mutex<Option<String>>>, variant: OperationVariant) {
    // Read just the request line + headers (we don't need a body for GETs).
    // Set a short read timeout so a stalled client doesn't tie up a thread.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

    let mut reader = BufReader::new(stream.try_clone().unwrap_or_else(|_| stream.try_clone().expect("clone failed twice")));
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }

    // Consume headers until blank line.
    let mut header_line = String::new();
    loop {
        header_line.clear();
        match reader.read_line(&mut header_line) {
            Ok(0) => break,
            Ok(_) if header_line == "\r\n" || header_line == "\n" => break,
            Ok(_) => continue,
            Err(_) => break,
        }
    }

    // Parse method + path (very loose).
    let mut parts = request_line.split_whitespace();
    let _method = parts.next().unwrap_or("GET");
    let path = parts.next().unwrap_or("/");

    let redirect = redirect_state
        .lock()
        .ok()
        .and_then(|guard| guard.clone());
    let response = build_response(path, redirect.as_deref(), variant);
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
    // Best-effort shutdown to release the socket promptly.
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

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
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

fn build_response(path: &str, redirect: Option<&str>, variant: OperationVariant) -> String {
    // Discrimination strategy: the static HTML page (served on root)
    // polls /api/config every 1s. Two response shapes for /api/*:
    //   - `redirect=None` (still upgrading, no real Node found yet) → 503
    //     with sentinel header. Page keeps polling.
    //   - `redirect=Some(url)` (wind-down phase, probe found real Node) →
    //     200 with sentinel header + `{"redirect":"<url>"}` JSON body. Page
    //     reads the redirect field and navigates.
    // The sentinel header stays set in both upgrade-server responses so the
    // page doesn't confuse them with a real-Node response (real Node never
    // sends the sentinel; its `r.headers.get(...) !== '1'` branch is the
    // existing "real app is back, reload" path).
    if path.starts_with("/api/") {
        if path == "/api/discover" {
            let config_path = std::env::var("WS_SCRCPY_DATA_ROOT")
                .map(|dr| PathBuf::from(dr).join("config.json"))
                .unwrap_or_else(|_| {
                    common::config::data_root_from_env()
                        .unwrap_or_else(|| PathBuf::from("."))
                        .join("config.json")
                });
            return build_discover_response(&config_path);
        }

        if let Some(url) = redirect {
            // Naive JSON string encoding — port-only URLs (http://localhost:NNNN/)
            // contain no characters that need escaping. If the redirect ever
            // grows beyond port-only, swap to a real JSON encoder.
            let body = format!(r#"{{"error":null,"redirect":"{}"}}"#, url);
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
        let body = r#"{"error":"upgrade-server-active","retry":true}"#;
        return format!(
            "HTTP/1.1 503 Service Unavailable\r\n\
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

    // Default: serve the upgrading page on root and any other path.
    let body = render_operation_page(variant);
    format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         X-WsScrcpyWeb-Upgrade-Server: 1\r\n\
         Connection: close\r\n\
         \r\n\
         {}",
        body.len(),
        body
    )
}

/// Write the upgrade-server stop marker. Called by the new supervised
/// launcher BEFORE it spawns Node, so the running upgrade-server (if any)
/// releases the port. Idempotent; absent marker == "no upgrade-server
/// active or already exited."
pub fn write_stop_marker(data_root: &Path) -> std::io::Result<PathBuf> {
    let dir = data_root.join("control");
    std::fs::create_dir_all(&dir)?;
    let marker = dir.join(STOP_MARKER_FILENAME);
    std::fs::write(&marker, b"stop")?;
    Ok(marker)
}

/// §32 Part 5e — refresh the dataRoot copy of the launcher binary that
/// the post-stop bat spawns as the upgrade-server.
///
/// Why a copy outside `current/`: the upgrade-server is the launcher
/// binary invoked with `--upgrade-server`. When spawned from
/// `<installRoot>/current/ws-scrcpy-web-launcher.exe`, the process
/// holds that file as its loaded image. Velopack's apply phase needs
/// to swap `<installRoot>/current/`, and it terminates processes
/// holding files inside it — killing the upgrade-server within ~1s of
/// bind (caught by v0.1.25-beta.24 → beta.25 smoke 2026-05-21). Moving
/// the helper to `<dataRoot>/upgrade-server/` (Velopack-untouchable,
/// same pattern as the post-stop bat) lets the upgrade-server survive
/// the full upgrade window.
///
/// Refreshed on every supervisor startup so the helper tracks the
/// currently-installed launcher version. Best-effort — caller logs +
/// continues on failure. Returns the helper path on success.
pub fn refresh_helper_binary(data_root: &Path) -> std::io::Result<PathBuf> {
    let current = std::env::current_exe()?;

    // Canonical (new) location.
    let new_dir = data_root.join("control").join("operation-server");
    std::fs::create_dir_all(&new_dir)?;
    let new_path = new_dir.join("ws-scrcpy-web-launcher.exe");
    std::fs::copy(&current, &new_path)?;

    // Legacy location — dual-write so existing post-stop.bat files
    // (referencing <dataRoot>/upgrade-server/launcher.exe) keep working
    // through the transitional period. Best-effort; legacy write
    // failure does not propagate.
    let legacy_dir = data_root.join("control").join("upgrade-server");
    let _ = std::fs::create_dir_all(&legacy_dir);
    let legacy_path = legacy_dir.join("ws-scrcpy-web-launcher.exe");
    let _ = std::fs::copy(&current, &legacy_path);

    Ok(new_path)
}

/// Resolve the canonical helper path under `<dataRoot>/control/operation-server/`.
/// Used by the post-stop bat writer to interpolate the same path the
/// supervisor refreshes at startup. Single source of truth for the helper
/// layout.
pub fn helper_path_for(data_root: &Path) -> PathBuf {
    data_root.join("control").join("operation-server").join("ws-scrcpy-web-launcher.exe")
}

/// Legacy helper path under `<dataRoot>/control/upgrade-server/`. Kept for ~2
/// release cycles so existing installs' post-stop.bat files (which
/// reference this path) keep finding a launcher binary. New code should
/// use `helper_path_for`. Removed in a follow-up PR ~2 release cycles
/// after Phase 1 ships.
///
/// No in-process callers in Phase 1 — the function exists purely as a
/// documented API surface for the dual-write story (the path the legacy
/// post-stop.bat reads). `#[allow(dead_code)]` keeps clippy `-D warnings`
/// happy across the transitional window.
#[allow(dead_code)]
pub fn legacy_helper_path_for(data_root: &Path) -> PathBuf {
    data_root.join("control").join("upgrade-server").join("ws-scrcpy-web-launcher.exe")
}

/// §32 Part 5f — spawn the dataRoot upgrade-server helper as a detached
/// background process. Called by the launcher's supervisor on clean Node
/// exit when an apply-update-pending marker is present (local mode). In
/// service mode the post-stop bat handles the same spawn — both paths
/// converge on the same helper binary + same wind-down handoff. Gating
/// to local-mode-only at the call site keeps the two architectures from
/// racing for the bind.
///
/// Best-effort: logs failure and returns. If the spawn fails (helper
/// missing, permissions denied, etc.), the apply-update degrades to a
/// brief "can't reach" gap during the upgrade window — the pre-Part-5f
/// local-mode behavior. Stdio is explicitly null'd so the child doesn't
/// inherit the launcher's handles (which become invalid after launcher
/// exits).
///
/// Windows-only — on non-Windows the call is a no-op log line.
pub fn spawn_detached_helper(data_root: &Path) {
    let helper = helper_path_for(data_root);
    if !helper.exists() {
        log::error(&format!(
            "operation-server: helper not present at {helper:?}, skipping spawn"
        ));
        return;
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Stdio;
        // DETACHED_PROCESS: child does not inherit calling process's console.
        // CREATE_NO_WINDOW: child runs without console window (windows-subsystem
        //   binary already has none, but belt-and-braces for parity with the
        //   post-stop bat's `start "" /b` behavior).
        const DETACHED_PROCESS: u32 = 0x00000008;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        match std::process::Command::new(&helper)
            .arg("--operation-server")
            .current_dir(data_root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
            .spawn()
        {
            Ok(child) => log::info(&format!(
                "operation-server: spawned helper (pid {})",
                child.id()
            )),
            Err(e) => log::error(&format!("operation-server: spawn failed: {e}")),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = data_root; // silence unused-variable warning
        log::info("operation-server: spawn_detached_helper skipped (non-Windows)");
    }
}

/// Path of the apply-update-pending marker the launcher's supervisor
/// reads on clean Node exit to decide whether to spawn the upgrade-
/// server (local mode) before exiting. Same path the post-stop bat
/// gates its spawn on (service mode). Written by Node's
/// `UpdateService.applyUpdate` in both modes via
/// `Config.applyUpdatePendingMarkerPath`.
pub fn apply_update_pending_marker(data_root: &Path) -> PathBuf {
    data_root.join("control").join("apply-update-pending")
}

/// Wait for the given TCP port to become bindable (i.e., the previous
/// holder has released it). Polls `set_nonblocking` connects, NOT bind
/// attempts (bind succeeds even if a previous bind is in TIME_WAIT). A
/// failed connect to localhost:port means nothing is listening. Returns
/// after the first failed connect OR when `timeout` elapses.
pub fn wait_for_port_free(port: u16, timeout: Duration) {
    use std::net::TcpStream;
    let started = Instant::now();
    while started.elapsed() < timeout {
        match TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().expect("hardcoded sockaddr"),
            Duration::from_millis(200),
        ) {
            Ok(_) => {
                // Something is listening. Sleep + retry.
                thread::sleep(Duration::from_millis(200));
            }
            Err(_) => {
                // Connection refused → port is free.
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    // Tests reference parent-module items via explicit `super::` prefix
    // (preserved from the plan's verbatim test source — makes the
    // module-boundary clear at each call site). No `use super::*;` is
    // needed; adding one would trip clippy's `-D unused-imports`.

    #[test]
    fn is_operation_server_flag_recognizes_canonical_flag() {
        let args = vec!["launcher.exe".to_string(), "--operation-server".to_string()];
        assert!(super::is_operation_server_flag(&args));
    }

    #[test]
    fn is_operation_server_flag_recognizes_legacy_upgrade_server_alias() {
        let args = vec!["launcher.exe".to_string(), "--upgrade-server".to_string()];
        assert!(super::is_operation_server_flag(&args));
    }

    #[test]
    fn is_operation_server_flag_rejects_unrelated_args() {
        let args = vec!["launcher.exe".to_string(), "--unrelated".to_string()];
        assert!(!super::is_operation_server_flag(&args));
    }

    #[test]
    fn helper_path_for_returns_operation_server_path() {
        let p = super::helper_path_for(std::path::Path::new(r"C:\ProgramData\WsScrcpyWeb"));
        // Construct expected with Path::join so the test passes on both
        // Windows (`\` separator) and Linux CI (`/` separator) — production
        // callers are Windows-only but cargo test runs on both.
        let expected = std::path::Path::new(r"C:\ProgramData\WsScrcpyWeb")
            .join("control")
            .join("operation-server")
            .join("ws-scrcpy-web-launcher.exe");
        assert_eq!(p, expected);
    }

    #[test]
    fn legacy_helper_path_for_returns_upgrade_server_path() {
        let p = super::legacy_helper_path_for(std::path::Path::new(r"C:\ProgramData\WsScrcpyWeb"));
        let expected = std::path::Path::new(r"C:\ProgramData\WsScrcpyWeb")
            .join("control")
            .join("upgrade-server")
            .join("ws-scrcpy-web-launcher.exe");
        assert_eq!(p, expected);
    }

    #[test]
    fn refresh_helper_binary_writes_to_both_paths() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_root = tmp.path();

        // refresh_helper_binary copies std::env::current_exe(); in unit-test
        // context that's the test runner. The Ok branch is the assertion-
        // bearing branch — we only verify dual-write on success.
        if super::refresh_helper_binary(data_root).is_ok() {
            let new_path = data_root.join("control").join("operation-server").join("ws-scrcpy-web-launcher.exe");
            let legacy_path = data_root.join("control").join("upgrade-server").join("ws-scrcpy-web-launcher.exe");
            assert!(new_path.exists(), "operation-server/launcher.exe should be written");
            assert!(legacy_path.exists(), "upgrade-server/launcher.exe should also be written (dual-write compat)");
        }
    }

    #[test]
    fn should_exit_for_stop_marker_returns_false_when_absent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(!super::should_exit_for_stop_marker(tmp.path()));
    }

    #[test]
    fn should_exit_for_stop_marker_returns_true_when_canonical_present() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("control");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("operation-server-stop"), b"stop").expect("write");
        assert!(super::should_exit_for_stop_marker(tmp.path()));
    }

    #[test]
    fn should_exit_for_stop_marker_returns_true_when_legacy_upgrade_server_stop_present() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("control");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("upgrade-server-stop"), b"stop").expect("write");
        assert!(super::should_exit_for_stop_marker(tmp.path()));
    }

    #[test]
    fn write_stop_marker_uses_canonical_filename() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let marker = super::write_stop_marker(tmp.path()).expect("write");
        assert!(
            marker.ends_with("operation-server-stop"),
            "marker file should be operation-server-stop, got: {marker:?}"
        );
    }

    #[test]
    fn detect_operation_variant_returns_apply_update_when_marker_present() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("control");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("apply-update-pending"), b"").expect("write");
        assert_eq!(super::detect_operation_variant(tmp.path()), super::OperationVariant::ApplyUpdate);
    }

    #[test]
    fn detect_operation_variant_returns_uninstall_when_marker_present() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("control");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("uninstall-pending"), b"").expect("write");
        assert_eq!(super::detect_operation_variant(tmp.path()), super::OperationVariant::Uninstall);
    }

    #[test]
    fn detect_operation_variant_defaults_to_apply_update_when_no_marker() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Defensive default: matches the bat's branch order (apply-update wins
        // if both markers somehow present). Also preserves the pre-Phase-2
        // single-operation behavior for any code path that spawns the
        // operation-server without writing a marker.
        assert_eq!(super::detect_operation_variant(tmp.path()), super::OperationVariant::ApplyUpdate);
    }

    #[test]
    fn render_operation_page_substitutes_apply_update_text() {
        let html = super::render_operation_page(super::OperationVariant::ApplyUpdate);
        assert!(html.contains("Updating app, please wait"), "apply-update title present: {html}");
        assert!(!html.contains("__OPERATION_TITLE__"), "template token replaced");
    }

    #[test]
    fn render_operation_page_substitutes_uninstall_text() {
        let html = super::render_operation_page(super::OperationVariant::Uninstall);
        assert!(html.contains("Uninstalling service, please wait"), "uninstall title present: {html}");
        assert!(!html.contains("__OPERATION_TITLE__"), "template token replaced");
    }

    #[test]
    fn build_discover_response_with_valid_config() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.json");
        std::fs::write(&config_path, r#"{"webPort":8003,"installMode":"user"}"#).unwrap();

        let response = super::build_discover_response(&config_path);
        assert!(response.contains("200 OK"));
        assert!(response.contains(r#""webPort":8003"#));
        assert!(response.contains(r#""configMtime":"#));
    }

    #[test]
    fn build_discover_response_with_missing_config() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.json");

        let response = super::build_discover_response(&config_path);
        assert!(response.contains("200 OK"));
        assert!(response.contains(r#""webPort":null"#));
        assert!(response.contains(r#""configMtime":null"#));
    }

    #[test]
    fn build_discover_response_with_malformed_json() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.json");
        std::fs::write(&config_path, "not json at all").unwrap();

        let response = super::build_discover_response(&config_path);
        assert!(response.contains("200 OK"));
        assert!(response.contains(r#""webPort":null"#));
        // configMtime should still be present since the file exists
        assert!(response.contains(r#""configMtime":"#));
        assert!(!response.contains(r#""configMtime":null"#));
    }
}
