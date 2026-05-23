// §32 Part 5 — launcher-served "updating, please wait…" page during the
// in-app upgrade window.
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
//   1. Post-stop bat spawns `<launcher> --upgrade-server` AFTER Node
//      exits but BEFORE `sc start`. The bat fire-and-forget-spawns, then
//      continues to its `timeout` + `sc start` sequence.
//   2. Upgrade-server reads the web port from config.json, binds it,
//      serves a static "updating" HTML page on all paths (200 for root,
//      503 for /api/*). HTML page has inline JS that polls /api/config
//      every 1s, reloads the page when real app responds with 200 JSON.
//   3. Upgrade-server self-exits on either:
//      - <dataRoot>/control/upgrade-server-stop marker present (the new
//        supervised launcher writes this before spawning Node)
//      - 30 seconds elapsed (safety cap; if Node isn't up by then, the
//        user is hitting a deeper problem the upgrade page can't paper
//        over)
//   4. Each TCP connection handled in its own short-lived thread.
//      Connection count during a typical upgrade is single-digit;
//      no need for async.
//
// Subcommand argv: `<launcher> --upgrade-server`
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
const STOP_MARKER_FILENAME: &str = "upgrade-server-stop";

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

fn run() -> i32 {
    log::info("upgrade-server: starting");

    let data_root = match common::config::data_root_from_env() {
        Some(p) => p,
        None => {
            log::error("upgrade-server: cannot resolve data_root");
            return 5;
        }
    };

    let cfg = common::config::AppConfig::load(&data_root);
    let port = cfg.web_port.unwrap_or(8000);
    log::info(&format!("upgrade-server: data_root={data_root:?} port={port}"));

    let stop_marker = data_root.join("control").join(STOP_MARKER_FILENAME);
    // Clean any stale marker from a prior upgrade so we don't insta-exit.
    let _ = std::fs::remove_file(&stop_marker);

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
                            "upgrade-server: bind 0.0.0.0:{port} busy ({e}), retrying every {BIND_RETRY_INTERVAL_MS}ms until port is free (timeout {BIND_RETRY_TIMEOUT_SECS}s)"
                        ));
                        first_busy_logged = true;
                    }
                    if bind_start.elapsed() >= Duration::from_secs(BIND_RETRY_TIMEOUT_SECS) {
                        log::error(&format!(
                            "upgrade-server: bind 0.0.0.0:{port} failed after {BIND_RETRY_TIMEOUT_SECS}s of retries: {e} — giving up"
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
            "upgrade-server: set_nonblocking failed (non-fatal): {e}"
        ));
    }

    log::info(&format!(
        "upgrade-server: bound 0.0.0.0:{port}, serving updating page (max lifetime {MAX_LIFETIME_SECS}s)"
    ));

    let stop_flag = Arc::new(AtomicBool::new(false));
    // Shared redirect state — populated by the wind-down probe thread when
    // the real Node is found on a different port than the upgrade-server is
    // holding. Connection handlers check it on every request and switch
    // /api/config from 503 (still upgrading) to 200 + redirect JSON when set.
    let redirect_state: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let started_at = Instant::now();

    // Normal serving phase — runs until stop marker observed or max lifetime
    // hits. After stop marker, control transfers to wind_down() which keeps
    // the listener open while probing for the new Node's port.
    loop {
        if stop_flag.load(Ordering::SeqCst) {
            log::info("upgrade-server: stop_flag observed, exiting");
            return 0;
        }
        if stop_marker.exists() {
            log::info(&format!(
                "upgrade-server: stop marker present at {stop_marker:?}, entering wind-down"
            ));
            let _ = std::fs::remove_file(&stop_marker);
            return wind_down(listener, redirect_state, port);
        }
        if started_at.elapsed() >= Duration::from_secs(MAX_LIFETIME_SECS) {
            log::info(&format!(
                "upgrade-server: max lifetime {MAX_LIFETIME_SECS}s elapsed, exiting"
            ));
            return 0;
        }

        accept_one(&listener, &redirect_state);
    }
}

/// Wind-down phase entered after the stop marker is observed. Spawns a
/// background probe thread that sweeps neighboring ports for the new Node
/// (handles the case where Node lost the port race and auto-shifted to
/// e.g. config_port+1), and keeps serving connections so the polling page
/// can pick up the resulting redirect.
fn wind_down(listener: TcpListener, redirect_state: Arc<Mutex<Option<String>>>, config_port: u16) -> i32 {
    let probe_state = redirect_state.clone();
    thread::spawn(move || {
        probe_for_real_node_and_publish(config_port, probe_state);
    });

    let wind_down_start = Instant::now();
    loop {
        if wind_down_start.elapsed() >= Duration::from_secs(WIND_DOWN_TOTAL_SECS) {
            log::info(&format!(
                "upgrade-server: wind-down window ({WIND_DOWN_TOTAL_SECS}s) elapsed, exiting"
            ));
            return 0;
        }
        accept_one(&listener, &redirect_state);
    }
}

/// One iteration of the non-blocking accept loop. Spawns a thread per
/// accepted connection. Shared between the normal-serving loop and the
/// wind-down loop so connection handling stays uniform.
fn accept_one(listener: &TcpListener, redirect_state: &Arc<Mutex<Option<String>>>) {
    match listener.accept() {
        Ok((stream, peer)) => {
            log::info(&format!("upgrade-server: connection from {peer}"));
            let state_clone = redirect_state.clone();
            // Spawn a thread per connection. Short-lived; we don't track
            // JoinHandles. Connection count during an upgrade window is
            // single-digit.
            thread::spawn(move || {
                handle_connection(stream, state_clone);
            });
        }
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            // No pending connection. Sleep briefly, then re-check stop
            // conditions on the next iteration.
            thread::sleep(Duration::from_millis(ACCEPT_TIMEOUT_MS.max(STOP_MARKER_POLL_MS)));
        }
        Err(e) => {
            log::error(&format!("upgrade-server: accept error: {e}"));
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
        "upgrade-server: probe starting (sweeping ports {config_port}..={}, every {PROBE_INTERVAL_MS}ms)",
        config_port.saturating_add(PROBE_MAX_OFFSET)
    ));
    let probe_start = Instant::now();
    loop {
        if probe_start.elapsed() >= Duration::from_secs(WIND_DOWN_TOTAL_SECS) {
            log::info("upgrade-server: probe gave up — no real Node found in any neighboring port within wind-down window");
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
                    "upgrade-server: probe found real Node on port {probe_port} (offset +{offset}) — publishing redirect {url}"
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

fn handle_connection(mut stream: TcpStream, redirect_state: Arc<Mutex<Option<String>>>) {
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
    let response = build_response(path, redirect.as_deref());
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
    // Best-effort shutdown to release the socket promptly.
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

fn build_response(path: &str, redirect: Option<&str>) -> String {
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
    let body = OPERATION_PAGE;
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
    let helper_dir = data_root.join("upgrade-server");
    std::fs::create_dir_all(&helper_dir)?;
    let helper_path = helper_dir.join("ws-scrcpy-web-launcher.exe");
    let current = std::env::current_exe()?;
    std::fs::copy(&current, &helper_path)?;
    Ok(helper_path)
}

/// Resolve the helper path without performing the copy. Used by the
/// post-stop bat writer to interpolate the same path the supervisor
/// refreshes at startup. Single source of truth for the helper layout.
pub fn helper_path_for(data_root: &Path) -> PathBuf {
    data_root.join("upgrade-server").join("ws-scrcpy-web-launcher.exe")
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
            "upgrade-server: helper not present at {helper:?}, skipping spawn"
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
            .arg("--upgrade-server")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
            .spawn()
        {
            Ok(child) => log::info(&format!(
                "upgrade-server: spawned helper (pid {})",
                child.id()
            )),
            Err(e) => log::error(&format!("upgrade-server: spawn failed: {e}")),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = data_root; // silence unused-variable warning
        log::info("upgrade-server: spawn_detached_helper skipped (non-Windows)");
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
    use super::*;

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
}
