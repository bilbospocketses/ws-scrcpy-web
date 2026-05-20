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

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crate::log;

const MAX_LIFETIME_SECS: u64 = 30;
const STOP_MARKER_POLL_MS: u64 = 200;
const ACCEPT_TIMEOUT_MS: u64 = 200;
const STOP_MARKER_FILENAME: &str = "upgrade-server-stop";

const UPGRADING_PAGE: &str = include_str!("../assets/upgrade-server-page.html");

/// Public entry: if argv contains `--upgrade-server`, handle it and return
/// `Some(exit_code)`. Otherwise return None (caller proceeds to normal launch).
pub fn handle(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--upgrade-server") {
        return None;
    }
    Some(run())
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

    let listener = match TcpListener::bind(("0.0.0.0", port)) {
        Ok(l) => l,
        Err(e) => {
            log::error(&format!(
                "upgrade-server: bind 0.0.0.0:{port} failed: {e} — port likely held by Node, exiting"
            ));
            return 3;
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
    let started_at = Instant::now();

    loop {
        // Check stop conditions.
        if stop_flag.load(Ordering::SeqCst) {
            log::info("upgrade-server: stop_flag observed, exiting");
            return 0;
        }
        if stop_marker.exists() {
            log::info(&format!(
                "upgrade-server: stop marker present at {stop_marker:?}, exiting"
            ));
            let _ = std::fs::remove_file(&stop_marker);
            return 0;
        }
        if started_at.elapsed() >= Duration::from_secs(MAX_LIFETIME_SECS) {
            log::info(&format!(
                "upgrade-server: max lifetime {MAX_LIFETIME_SECS}s elapsed, exiting"
            ));
            return 0;
        }

        // Try to accept a connection.
        match listener.accept() {
            Ok((stream, peer)) => {
                log::info(&format!("upgrade-server: connection from {peer}"));
                // Spawn a thread per connection. Short-lived; we don't
                // track JoinHandles. Connection count during an upgrade
                // window is single-digit.
                thread::spawn(move || {
                    handle_connection(stream);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // No pending connection. Sleep briefly, then re-check
                // stop conditions.
                thread::sleep(Duration::from_millis(ACCEPT_TIMEOUT_MS.max(STOP_MARKER_POLL_MS)));
            }
            Err(e) => {
                log::error(&format!("upgrade-server: accept error: {e}"));
                thread::sleep(Duration::from_millis(500));
            }
        }
    }
}

fn handle_connection(mut stream: TcpStream) {
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

    let response = build_response(path);
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
    // Best-effort shutdown to release the socket promptly.
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

fn build_response(path: &str) -> String {
    // Discrimination strategy: the static HTML page (served on root)
    // polls /api/config every 1s. We return 503 for any /api/* path so
    // the client knows the real app isn't up. When the real app IS up
    // (post-restart), the client gets 200 JSON from real Node and
    // reloads.
    if path.starts_with("/api/") {
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
    let body = UPGRADING_PAGE;
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
