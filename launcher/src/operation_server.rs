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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::log;

const MAX_LIFETIME_SECS: u64 = 30;
const STOP_MARKER_POLL_MS: u64 = 200;
const ACCEPT_TIMEOUT_MS: u64 = 200;

/// §51 — ceiling on concurrently-live connection-handler threads. `accept_one`
/// spawns one thread per accepted connection; the listener is loopback-only
/// (§48), but a local process could still open connections faster than the
/// 5s-read-timeout handlers drain and exhaust threads / memory. Legitimate
/// upgrade-window load is single-digit, so this ceiling never trips real
/// clients while bounding an attacker to a fixed pool of handler threads.
/// Connections beyond the ceiling are dropped (closed); the polling page just
/// retries on its next ~1s tick.
const MAX_INFLIGHT_CONNECTIONS: usize = 64;

// Compile-time floor: legitimate upgrade-window load is single-digit, so the
// ceiling must leave generous headroom for real clients while still bounding an
// attacker. Guards against a careless edit to a tiny value (e.g. 0 =
// drop-everything) — the crate won't build if this is violated.
const _: () = assert!(
    MAX_INFLIGHT_CONNECTIONS >= 16,
    "MAX_INFLIGHT_CONNECTIONS must leave headroom over single-digit legit load"
);

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

const PORT_FILE_NAME: &str = "operation-server-port";

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

pub fn write_port_file(data_root: &Path, port: u16) -> std::io::Result<PathBuf> {
    let dir = data_root.join("control");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(PORT_FILE_NAME);
    std::fs::write(&path, port.to_string())?;
    Ok(path)
}

#[allow(dead_code)]
pub fn read_port_file(data_root: &Path) -> Option<u16> {
    let path = data_root.join("control").join(PORT_FILE_NAME);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
}

pub fn delete_port_file(data_root: &Path) {
    let path = data_root.join("control").join(PORT_FILE_NAME);
    let _ = std::fs::remove_file(&path);
}

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
            match TcpListener::bind(("127.0.0.1", port)) {
                Ok(listener) => return Ok((listener, port)),
                Err(e) => {
                    let is_in_use = e.kind() == std::io::ErrorKind::AddrInUse;
                    if is_in_use && offset < max_offset {
                        log::info(&format!(
                            "operation-server: port {port} in use, trying next"
                        ));
                        break; // try next port
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
                            "operation-server: bind 127.0.0.1:{port} failed after {retry_timeout:?}: {e}"
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

/// Stream-hash `path` with SHA-256 and return the lowercase hex digest. Used to
/// verify a downloaded nupkg against Velopack's authenticated UpdateInfo (the
/// `sha256` field of the apply-update-verify manifest Node writes) before
/// extracting it over `current/`.
fn sha256_hex_of_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Verification manifest Node writes to `<data_root>/control/apply-update-verify.json`
/// immediately before spawning the operation-server for a Windows local-mode
/// in-app update. Carries the values from Velopack's authenticated
/// `UpdateInfo.TargetFullRelease`, so the operation-server can re-verify the
/// on-disk nupkg (which Velopack downloaded into the user-writable `packages/`
/// dir) before extracting + executing it. Trust anchor = the HTTPS release feed
/// Velopack already validated, NOT the co-located, user-writable package file.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyVerifyManifest {
    /// Target version, from `UpdateInfo.TargetFullRelease.Version`. Authoritative
    /// version string — replaces deriving it from the (attacker-influenceable)
    /// archive filename.
    version: String,
    /// Bare filename of the full nupkg, from `...TargetFullRelease.FileName`.
    file_name: String,
    /// Expected lowercase-hex SHA-256, from `...TargetFullRelease.SHA256`.
    sha256: String,
}

const APPLY_VERIFY_MANIFEST_FILENAME: &str = "apply-update-verify.json";

/// Read + parse the apply-update-verify manifest from `<data_root>/control/`.
/// Returns Err (→ fail-closed at the call site) when the file is absent or
/// malformed — an apply must never proceed without a verification anchor.
fn read_apply_verify_manifest(data_root: &Path) -> Result<ApplyVerifyManifest, String> {
    let path = data_root
        .join("control")
        .join(APPLY_VERIFY_MANIFEST_FILENAME);
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read apply-update-verify manifest {path:?}: {e}"))?;
    serde_json::from_str(&raw)
        .map_err(|e| format!("cannot parse apply-update-verify manifest {path:?}: {e}"))
}

/// True only if `name` is a single normal path component — no directory
/// separator, no `.`/`..`, no drive prefix or root. Guards the
/// `packages_dir.join(file_name)` lookup so the verified manifest can't
/// retarget it outside the packages dir (e.g. `..\\x`, `C:\\x`, `sub/x`).
fn is_bare_filename(name: &str) -> bool {
    let mut comps = std::path::Path::new(name).components();
    matches!(
        (comps.next(), comps.next()),
        (Some(std::path::Component::Normal(_)), None)
    )
}

/// Lexically collapse `.`/`..` in a relative path. `enclosed_name()` already
/// guarantees the NET path can't escape the archive root, but it may keep
/// interior `..` un-collapsed — and we strip a `lib/app/` prefix afterwards,
/// which would otherwise let `lib/app/../x` become `../x`. Normalizing first
/// keeps the post-strip remainder free of any traversal. Drops any leading
/// `..`/root components defensively (an enclosed name has none).
fn normalize_relative(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::Normal(c) => out.push(c),
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {}
        }
    }
    out
}

/// Extract the verified full nupkg's `lib/app/` contents into `current_dir`
/// (overwrite), returning the target version. §49 hardening: the package is
/// selected by the EXACT filename in `manifest` (never "newest file in the
/// dir", which a dropped decoy could win) and its SHA-256 is checked against
/// `manifest.sha256` BEFORE any extraction — fail-closed, because the nupkg
/// lives in the user-writable `packages/` dir. Entry paths are constrained
/// with `enclosed_name()` (zip-slip defense), and the version is taken from
/// the manifest, not the (attacker-influenceable) archive filename. Replaces
/// Update.exe for local-mode updates — no rename dance, no CWD handle locks.
fn find_and_extract_nupkg(
    packages_dir: &Path,
    current_dir: &Path,
    manifest: &ApplyVerifyManifest,
) -> Result<String, String> {
    // Select strictly by the verified filename, and only if it is a bare name.
    let file_name = manifest.file_name.as_str();
    if !is_bare_filename(file_name) {
        return Err(format!("refusing unsafe nupkg file name: {file_name:?}"));
    }
    let nupkg_path = packages_dir.join(file_name);
    if !nupkg_path.is_file() {
        return Err(format!("nupkg named by manifest not found: {nupkg_path:?}"));
    }

    // Fail-closed integrity check against Velopack's authenticated SHA-256
    // (from UpdateInfo, relayed by Node). No match → extract nothing.
    let actual = sha256_hex_of_file(&nupkg_path)
        .map_err(|e| format!("cannot hash nupkg {nupkg_path:?}: {e}"))?;
    if !actual.eq_ignore_ascii_case(manifest.sha256.trim()) {
        return Err(format!(
            "nupkg SHA-256 mismatch for {nupkg_path:?}: expected {}, got {actual}",
            manifest.sha256
        ));
    }

    log::info(&format!(
        "operation-server: verified + extracting {nupkg_path:?}"
    ));

    let file =
        std::fs::File::open(&nupkg_path).map_err(|e| format!("cannot open nupkg: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("cannot read nupkg as zip: {e}"))?;

    let prefix = std::path::Path::new("lib").join("app");
    let mut extracted = 0u32;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry {i}: {e}"))?;
        // Zip-slip defense: enclosed_name() is None for any entry that would
        // escape the archive root (absolute, drive-prefixed, or `..`).
        let enclosed = match entry.enclosed_name() {
            Some(p) => p,
            None => {
                log::error(&format!(
                    "operation-server: skipping unsafe nupkg entry: {}",
                    entry.name()
                ));
                continue;
            }
        };
        let normalized = normalize_relative(&enclosed);
        // Only the app payload under lib/app/ is extracted, into current/.
        let relative = match normalized.strip_prefix(&prefix) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        let dest = current_dir.join(relative);
        if entry.is_dir() {
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
    Ok(manifest.version.clone())
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
                "operation-server: §40 bound 127.0.0.1:{bound_port} (app port={port})"
            ));

            if let Err(e) = write_port_file(&data_root, bound_port) {
                log::error(&format!(
                    "operation-server: failed to write port file: {e}"
                ));
            }

            let bg_stop = Arc::new(AtomicBool::new(false));
            let bg_stop2 = bg_stop.clone();
            let bg_listener = listener.try_clone().expect("clone listener");
            let bg_redirect: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            let bg_redirect2 = bg_redirect.clone();
            // §51 — one in-flight counter shared by the background page thread
            // and the main accept loop below; both serve the same cloned
            // listener, so the cap must span both acceptors.
            let inflight = Arc::new(AtomicUsize::new(0));
            let inflight_bg = inflight.clone();
            let _page_thread = thread::spawn(move || {
                while !bg_stop2.load(Ordering::SeqCst) {
                    accept_one(&bg_listener, &bg_redirect2, OperationVariant::ApplyUpdate, &inflight_bg);
                }
            });

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
            // §49 — fail-closed verification. The nupkg sits in the user-writable
            // packages/ dir (install_acl::ensure_writable grants the install root
            // write so the in-app updater works), so we re-verify it against the
            // manifest Node wrote from Velopack's authenticated UpdateInfo BEFORE
            // extracting + executing it. No manifest → no trust anchor → refuse.
            let manifest = match read_apply_verify_manifest(&data_root) {
                Ok(m) => m,
                Err(e) => {
                    log::error(&format!(
                        "operation-server: cannot verify update ({e}) — refusing to extract"
                    ));
                    bg_stop.store(true, Ordering::SeqCst);
                    delete_port_file(&data_root);
                    return 4;
                }
            };
            match find_and_extract_nupkg(&packages_dir, &current_dir, &manifest) {
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
                let launcher_path = current_dir.join("ws-scrcpy-web-launcher.exe");
                use std::os::windows::process::CommandExt;
                const DETACHED_PROCESS: u32 = 0x00000008;
                const CREATE_NO_WINDOW_FLAG: u32 = 0x08000000;
                match std::process::Command::new(&launcher_path)
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

            // Phase 3: Handoff — probe for the new Node on config_port..+10.
            let probe_redirect = bg_redirect.clone();
            thread::spawn(move || {
                probe_for_real_node_and_publish(port, probe_redirect);
            });

            let started_at = Instant::now();
            while started_at.elapsed() < Duration::from_secs(MAX_LIFETIME_SECS) {
                accept_one(&listener, &bg_redirect, OperationVariant::ApplyUpdate, &inflight);
            }

            log::info("operation-server: §40 max lifetime elapsed, cleaning up");
            bg_stop.store(true, Ordering::SeqCst);
            delete_port_file(&data_root);
            return 0;
        }
    }

    // --- Service-mode / uninstall path (unchanged from here down) ---
    let listener = {
        let bind_start = Instant::now();
        let mut first_busy_logged = false;
        loop {
            match TcpListener::bind(("127.0.0.1", port)) {
                Ok(l) => break l,
                Err(e) => {
                    // First failure logs once at info level (expected when
                    // spawned pre-exit while Node still holds the port).
                    // Subsequent failures are silent to avoid log spam.
                    if !first_busy_logged {
                        log::info(&format!(
                            "operation-server: bind 127.0.0.1:{port} busy ({e}), retrying every {BIND_RETRY_INTERVAL_MS}ms until port is free (timeout {BIND_RETRY_TIMEOUT_SECS}s)"
                        ));
                        first_busy_logged = true;
                    }
                    if bind_start.elapsed() >= Duration::from_secs(BIND_RETRY_TIMEOUT_SECS) {
                        log::error(&format!(
                            "operation-server: bind 127.0.0.1:{port} failed after {BIND_RETRY_TIMEOUT_SECS}s of retries: {e} — giving up"
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
        "operation-server: bound 127.0.0.1:{port}, serving updating page (max lifetime {MAX_LIFETIME_SECS}s)"
    ));

    let stop_flag = Arc::new(AtomicBool::new(false));
    let redirect_state: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    // §51 — shared in-flight counter caps concurrent connection-handler
    // threads across both this serving loop and the wind-down loop.
    let inflight = Arc::new(AtomicUsize::new(0));
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
            return wind_down(listener, redirect_state, port, variant, inflight);
        }
        if started_at.elapsed() >= Duration::from_secs(MAX_LIFETIME_SECS) {
            log::info(&format!(
                "operation-server: max lifetime {MAX_LIFETIME_SECS}s elapsed, exiting"
            ));
            return 0;
        }

        accept_one(&listener, &redirect_state, variant, &inflight);
    }
}

/// Wind-down phase entered after the stop marker is observed. Spawns a
/// background probe thread that sweeps neighboring ports for the new Node
/// (handles the case where Node lost the port race and auto-shifted to
/// e.g. config_port+1), and keeps serving connections so the polling page
/// can pick up the resulting redirect.
fn wind_down(listener: TcpListener, redirect_state: Arc<Mutex<Option<String>>>, config_port: u16, variant: OperationVariant, inflight: Arc<AtomicUsize>) -> i32 {
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
        accept_one(&listener, &redirect_state, variant, &inflight);
    }
}

/// Atomically reserve one connection-handler slot. Returns `true` if the
/// caller may spawn a handler (the slot is now counted as live), or `false`
/// if the in-flight ceiling `max` is already reached (the counter is left
/// unchanged). The optimistic increment-then-undo keeps the check race-free
/// across the multiple accept loops that share one counter, so the number of
/// live handler threads never exceeds `max`. A `true` result MUST be paired
/// with an `InflightGuard` so the slot is released when the handler finishes.
fn try_reserve_slot(inflight: &AtomicUsize, max: usize) -> bool {
    if inflight.fetch_add(1, Ordering::SeqCst) >= max {
        inflight.fetch_sub(1, Ordering::SeqCst);
        false
    } else {
        true
    }
}

/// RAII release for a reserved connection-handler slot. Decrements the shared
/// in-flight counter on drop, so a slot is freed when its handler returns —
/// including on panic (`handle_connection` does a couple of `expect`s),
/// preventing a leaked slot from permanently shrinking the available pool.
struct InflightGuard {
    counter: Arc<AtomicUsize>,
}

impl InflightGuard {
    fn new(counter: Arc<AtomicUsize>) -> Self {
        InflightGuard { counter }
    }
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::SeqCst);
    }
}

/// One iteration of the non-blocking accept loop. Spawns a thread per
/// accepted connection (subject to the `MAX_INFLIGHT_CONNECTIONS` ceiling).
/// Shared between the normal-serving loop and the wind-down loop so connection
/// handling stays uniform.
fn accept_one(
    listener: &TcpListener,
    redirect_state: &Arc<Mutex<Option<String>>>,
    variant: OperationVariant,
    inflight: &Arc<AtomicUsize>,
) {
    match listener.accept() {
        Ok((stream, peer)) => {
            // §51 — bound the thread-per-connection amplifier. Reserve a slot
            // before spawning; beyond the ceiling, drop (close) the connection
            // instead of spawning an unbounded handler thread. The polling page
            // retries on its next ~1s tick, so a dropped poll is benign.
            if !try_reserve_slot(inflight, MAX_INFLIGHT_CONNECTIONS) {
                log::info(&format!(
                    "operation-server: connection from {peer} dropped — in-flight cap ({MAX_INFLIGHT_CONNECTIONS}) reached"
                ));
                // `stream` drops here → socket closed.
                return;
            }
            log::info(&format!("operation-server: connection from {peer}"));
            let state_clone = redirect_state.clone();
            // Variant is Copy, so capture-by-value into the thread closure
            // alongside the cloned state Arc.
            let v = variant;
            let inflight_clone = inflight.clone();
            // Spawn a thread per connection. Short-lived; we don't track
            // JoinHandles. The InflightGuard releases the reserved slot when
            // the handler returns (including on panic).
            thread::spawn(move || {
                let _slot = InflightGuard::new(inflight_clone);
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

    // §52 — a failed try_clone is fatal for this one connection but not for
    // the server: return (closing the socket) instead of panicking. The old
    // double-clone + `expect` would abort the process on a network-reachable
    // clone failure (e.g. fd exhaustion).
    let cloned = match stream.try_clone() {
        Ok(c) => c,
        Err(e) => {
            log::error(&format!("operation-server: connection stream clone failed ({e})"));
            return;
        }
    };
    let mut reader = BufReader::new(cloned);
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
            if let Some(url) = redirect {
                // §53 — encode via serde_json so the redirect is always
                // escaped and the body stays valid JSON regardless of contents.
                let body = serde_json::json!({ "status": "ready", "redirect": url }).to_string();
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

        if let Some(url) = redirect {
            // §53 — encode via serde_json so the redirect is always escaped
            // and the body stays valid JSON regardless of URL contents.
            let body = serde_json::json!({ "error": null, "redirect": url }).to_string();
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
        // bind_with_probe binds 127.0.0.1 (loopback only — #48), so the blocker
        // uses 127.0.0.1 to occupy the port on the same address.
        let blocker = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind blocker");
        let blocked_port = blocker.local_addr().expect("addr").port();
        let result = super::bind_with_probe(
            blocked_port,
            5,
            std::time::Duration::from_secs(1),
        );
        match result {
            Ok((listener, port)) => {
                assert!(port > blocked_port, "should have skipped to a higher port");
                // #48: the operation-server must bind loopback only, never 0.0.0.0
                // (which would expose the wait page + redirect to the LAN).
                let ip = listener.local_addr().expect("addr").ip();
                assert!(ip.is_loopback(), "bind_with_probe must bind loopback, got {ip}");
            }
            Err(_) => panic!("bind_with_probe should have found a free port"),
        }
    }

    #[test]
    fn sha256_hex_of_file_matches_known_vector() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let p = tmp.path().join("abc.bin");
        std::fs::write(&p, b"abc").expect("write");
        // Canonical SHA-256("abc").
        assert_eq!(
            super::sha256_hex_of_file(&p).expect("hash"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn read_apply_verify_manifest_parses_valid_json() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("control");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(
            dir.join("apply-update-verify.json"),
            r#"{"version":"0.1.30-beta.66","fileName":"WsScrcpyWeb-0.1.30-beta.66-full.nupkg","sha256":"ABCD1234"}"#,
        )
        .expect("write");
        let m = super::read_apply_verify_manifest(tmp.path()).expect("parse");
        assert_eq!(m.version, "0.1.30-beta.66");
        assert_eq!(m.file_name, "WsScrcpyWeb-0.1.30-beta.66-full.nupkg");
        assert_eq!(m.sha256, "ABCD1234");
    }

    #[test]
    fn read_apply_verify_manifest_errors_when_absent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(super::read_apply_verify_manifest(tmp.path()).is_err());
    }

    #[test]
    fn read_apply_verify_manifest_errors_on_garbage() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("control");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("apply-update-verify.json"), b"not json").expect("write");
        assert!(super::read_apply_verify_manifest(tmp.path()).is_err());
    }

    /// Build a minimal nupkg (a zip) with the given (entry-name, bytes) pairs.
    /// Entry names are written verbatim so a malicious `..` name can be tested.
    fn build_nupkg(path: &std::path::Path, entries: &[(&str, &[u8])]) {
        use std::io::Write;
        let file = std::fs::File::create(path).expect("create nupkg");
        let mut zw = zip::ZipWriter::new(file);
        for (name, data) in entries {
            zw.start_file(*name, zip::write::SimpleFileOptions::default())
                .expect("start_file");
            zw.write_all(data).expect("write entry");
        }
        zw.finish().expect("finish zip");
    }

    fn manifest(file_name: &str, sha256: &str, version: &str) -> super::ApplyVerifyManifest {
        super::ApplyVerifyManifest {
            version: version.to_string(),
            file_name: file_name.to_string(),
            sha256: sha256.to_string(),
        }
    }

    #[test]
    fn find_and_extract_nupkg_extracts_lib_app_and_returns_manifest_version() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let packages = tmp.path().join("packages");
        let current = tmp.path().join("current");
        std::fs::create_dir_all(&packages).expect("mkdir packages");
        std::fs::create_dir_all(&current).expect("mkdir current");

        let nupkg = packages.join("pkg-1.0.0-full.nupkg");
        build_nupkg(
            &nupkg,
            &[
                ("lib/app/index.js", b"console.log(1)"),
                ("lib/app/sub/style.css", b"body{}"),
                ("other/ignored.txt", b"nope"), // outside lib/app/ — must be skipped
            ],
        );
        let sha = super::sha256_hex_of_file(&nupkg).expect("hash");
        let m = manifest("pkg-1.0.0-full.nupkg", &sha, "9.9.9-from-manifest");

        let ver = super::find_and_extract_nupkg(&packages, &current, &m).expect("extract");
        // Version comes from the manifest, NOT the (attacker-influenceable) filename stem.
        assert_eq!(ver, "9.9.9-from-manifest");
        assert_eq!(
            std::fs::read_to_string(current.join("index.js")).unwrap(),
            "console.log(1)"
        );
        assert_eq!(
            std::fs::read_to_string(current.join("sub").join("style.css")).unwrap(),
            "body{}"
        );
        assert!(
            !current.join("ignored.txt").exists(),
            "entries outside lib/app/ must not be extracted"
        );
    }

    #[test]
    fn find_and_extract_nupkg_blocks_zip_slip_escape() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let packages = tmp.path().join("packages");
        let current = tmp.path().join("current");
        std::fs::create_dir_all(&packages).expect("mkdir packages");
        std::fs::create_dir_all(&current).expect("mkdir current");

        let nupkg = packages.join("pkg-1.0.0-full.nupkg");
        // `lib/app/../escape.txt` → the insecure code joins `../escape.txt` onto
        // current/, escaping into the install root. The fix must NOT write it.
        build_nupkg(
            &nupkg,
            &[
                ("lib/app/ok.txt", b"good"),
                ("lib/app/../escape.txt", b"PWNED"),
            ],
        );

        // Fixture sanity: confirm the malicious name survived the zip writer
        // (some writers sanitize — that would invalidate this test).
        {
            let f = std::fs::File::open(&nupkg).unwrap();
            let mut ar = zip::ZipArchive::new(f).unwrap();
            let mut found = false;
            for i in 0..ar.len() {
                if ar.by_index(i).unwrap().name().contains("..") {
                    found = true;
                }
            }
            assert!(found, "fixture: malicious '..' entry did not survive zip write");
        }

        let sha = super::sha256_hex_of_file(&nupkg).expect("hash");
        let m = manifest("pkg-1.0.0-full.nupkg", &sha, "1.0.0");

        super::find_and_extract_nupkg(&packages, &current, &m).expect("extract");
        // The good file lands; the escape file must NOT be written anywhere
        // outside current/ (the insecure code wrote it to current/../escape.txt).
        assert!(current.join("ok.txt").exists(), "normal entry should extract");
        assert!(
            !tmp.path().join("escape.txt").exists(),
            "zip-slip entry escaped current/ — traversal not blocked"
        );
    }

    #[test]
    fn find_and_extract_nupkg_rejects_sha256_mismatch() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let packages = tmp.path().join("packages");
        let current = tmp.path().join("current");
        std::fs::create_dir_all(&packages).expect("mkdir packages");
        std::fs::create_dir_all(&current).expect("mkdir current");

        let nupkg = packages.join("pkg-1.0.0-full.nupkg");
        build_nupkg(&nupkg, &[("lib/app/index.js", b"REAL")]);
        let m = manifest("pkg-1.0.0-full.nupkg", &"0".repeat(64), "1.0.0");

        let result = super::find_and_extract_nupkg(&packages, &current, &m);
        assert!(result.is_err(), "must reject on SHA-256 mismatch");
        assert!(
            !current.join("index.js").exists(),
            "fail-closed: nothing may be extracted on mismatch"
        );
    }

    #[test]
    fn find_and_extract_nupkg_ignores_unnamed_decoy_package() {
        // Attack: a decoy *-full.nupkg is present but is NOT the package the
        // verified manifest names. The old code picked the highest-versioned file
        // in the dir; the fix selects strictly by manifest.file_name and refuses
        // when that exact file is absent — never extracting the decoy.
        let tmp = tempfile::tempdir().expect("tempdir");
        let packages = tmp.path().join("packages");
        let current = tmp.path().join("current");
        std::fs::create_dir_all(&packages).expect("mkdir packages");
        std::fs::create_dir_all(&current).expect("mkdir current");

        build_nupkg(
            &packages.join("zzz-9.9.9-full.nupkg"),
            &[("lib/app/EVIL.js", b"pwn")],
        );
        let m = manifest("pkg-1.0.0-full.nupkg", &"0".repeat(64), "1.0.0"); // named pkg not on disk

        assert!(super::find_and_extract_nupkg(&packages, &current, &m).is_err());
        assert!(
            !current.join("EVIL.js").exists(),
            "a decoy package must never be extracted"
        );
    }

    #[test]
    fn find_and_extract_nupkg_rejects_non_bare_file_name() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let packages = tmp.path().join("packages");
        let current = tmp.path().join("current");
        std::fs::create_dir_all(&packages).expect("mkdir packages");
        std::fs::create_dir_all(&current).expect("mkdir current");

        build_nupkg(&packages.join("real-1.0.0-full.nupkg"), &[("lib/app/index.js", b"x")]);
        // A traversal-shaped file_name is refused even though a valid package exists.
        let m = manifest("../real-1.0.0-full.nupkg", &"0".repeat(64), "1.0.0");

        assert!(super::find_and_extract_nupkg(&packages, &current, &m).is_err());
    }

    // ----- §51: connection-handler concurrency cap (DoS amplifier fix) -----
    // accept_one spawns one OS thread per accepted connection. The listener
    // is loopback-only (§48), but a local process can still open connections
    // faster than the 5s-read-timeout handlers drain, exhausting threads /
    // memory. These tests pin the admission invariant: never more than
    // MAX_INFLIGHT_CONNECTIONS handler slots are live at once, every slot is
    // released when its handler finishes (even on panic), and the reservation
    // is race-free under contention.

    #[test]
    fn try_reserve_slot_admits_up_to_max_then_refuses() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let inflight = AtomicUsize::new(0);
        let max = 3usize;
        assert!(super::try_reserve_slot(&inflight, max), "1st admit");
        assert!(super::try_reserve_slot(&inflight, max), "2nd admit");
        assert!(super::try_reserve_slot(&inflight, max), "3rd admit fills the cap");
        assert!(!super::try_reserve_slot(&inflight, max), "refused at cap");
        assert!(!super::try_reserve_slot(&inflight, max), "still refused");
        assert_eq!(
            inflight.load(Ordering::SeqCst),
            max,
            "refused reservations must not leak the counter above max"
        );
    }

    #[test]
    fn try_reserve_slot_never_exceeds_max_under_contention() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let inflight = Arc::new(AtomicUsize::new(0));
        let max = 8usize;
        let attempts = 256usize;
        let granted = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..attempts {
            let inflight = inflight.clone();
            let granted = granted.clone();
            handles.push(std::thread::spawn(move || {
                // Hold the slot (never release) so the cap is genuinely contended.
                if super::try_reserve_slot(&inflight, max) {
                    granted.fetch_add(1, Ordering::SeqCst);
                }
            }));
        }
        for h in handles {
            h.join().expect("join");
        }
        assert_eq!(granted.load(Ordering::SeqCst), max, "exactly max slots granted");
        assert_eq!(
            inflight.load(Ordering::SeqCst),
            max,
            "counter must settle at max — never above it"
        );
    }

    #[test]
    fn inflight_guard_releases_slot_on_drop() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let inflight = Arc::new(AtomicUsize::new(0));
        let max = 1usize;
        assert!(super::try_reserve_slot(&inflight, max), "reserve the only slot");
        assert!(!super::try_reserve_slot(&inflight, max), "cap reached");
        {
            // The guard owns the matching release for the reserved slot.
            let _guard = super::InflightGuard::new(inflight.clone());
            assert_eq!(inflight.load(Ordering::SeqCst), 1, "slot held inside scope");
        }
        assert_eq!(inflight.load(Ordering::SeqCst), 0, "guard releases the slot on drop");
        assert!(super::try_reserve_slot(&inflight, max), "slot reusable after release");
    }

    #[test]
    fn inflight_guard_releases_slot_on_panic() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let inflight = Arc::new(AtomicUsize::new(0));
        assert!(super::try_reserve_slot(&inflight, 4), "reserve a slot");
        let inflight2 = inflight.clone();
        let h = std::thread::spawn(move || {
            let _guard = super::InflightGuard::new(inflight2);
            panic!("simulated handler panic");
        });
        assert!(h.join().is_err(), "handler thread should have panicked");
        assert_eq!(
            inflight.load(Ordering::SeqCst),
            0,
            "guard must release the slot even when the handler panics"
        );
    }

    // ----- §53: redirect URL must be JSON-escaped in build_response -----
    // The redirect string is interpolated into the /api JSON bodies. Today it
    // is always a safe port-only URL, but raw string interpolation emits
    // invalid JSON the moment it carries a quote/backslash. Encode via
    // serde_json so the body is always valid JSON and the field round-trips.

    #[test]
    fn build_response_escapes_redirect_in_discover_ready_body() {
        let evil = r#"http://localhost:8000/a"b\c"#;
        let resp = super::build_response("/api/discover", Some(evil), super::OperationVariant::ApplyUpdate);
        let body = resp.split("\r\n\r\n").nth(1).expect("response body");
        let parsed: serde_json::Value =
            serde_json::from_str(body).expect("discover body must be valid JSON");
        assert_eq!(parsed["status"], "ready");
        assert_eq!(parsed["redirect"], evil, "redirect must round-trip verbatim");
    }

    #[test]
    fn build_response_escapes_redirect_in_api_redirect_body() {
        let evil = r#"http://localhost:8000/a"b\c"#;
        let resp = super::build_response("/api/config", Some(evil), super::OperationVariant::ApplyUpdate);
        let body = resp.split("\r\n\r\n").nth(1).expect("response body");
        let parsed: serde_json::Value =
            serde_json::from_str(body).expect("api redirect body must be valid JSON");
        assert!(parsed["error"].is_null());
        assert_eq!(parsed["redirect"], evil, "redirect must round-trip verbatim");
    }
}
