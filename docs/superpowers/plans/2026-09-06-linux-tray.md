# Linux Tray Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Linux launcher a system-tray icon that mirrors the Windows tray — mode-aware tooltip, Open, a two-step Exit that stops the server cleanly — on desktops with a StatusNotifier host, and stands down silently on desktops without one.

**Architecture:** The Linux half of `common::tray::run` is implemented with `ksni` (a pure-Rust StatusNotifierItem over D-Bus) and spawned as one thread from the launcher's supervisor for local and user-scope-service runs; system scope never spawns it. Menu callbacks only post events on a channel; the `run` loop owns the URL provider, opens the browser via `/usr/bin/xdg-open`, and on a confirmed exit flips the supervisor's stop flag — which now sends Node SIGTERM (the server's existing graceful path) before it kills. Pure decisions (eligibility, labels, the icon asset) live in a new cross-platform module so they are unit-tested on every host.

**Tech Stack:** Rust 2021 (`common`, `launcher`, `tray` crates), `ksni` 0.3 (`blocking` + `async-io`, no tokio), `rustix` 1.1 (`process` feature, already a Linux dependency), Node 24 (one asset script), vitest, ImageMagick (developer-side asset generation only, never invoked by code).

**Spec:** `docs/superpowers/specs/2026-09-06-linux-tray-design.md` — the plan argues from it; executors read both.

## Global Constraints

- **Local-Dependencies-Only:** no binary resolved from PATH. The browser opener is `/usr/bin/xdg-open` by absolute path (the Linux launcher's existing convention: `/usr/bin/systemctl`, `/usr/bin/pkill`). ImageMagick runs once, by hand, to produce a committed asset; no script or build step invokes it.
- **No C libraries:** `ksni = { version = "0.3", default-features = false, features = ["blocking", "async-io"] }` under `[target.'cfg(target_os = "linux")'.dependencies]` in `common/Cargo.toml`. `tray-icon`/`libappindicator`/GTK are out. `cargo check --workspace --target x86_64-unknown-linux-musl` must stay green (release builds Linux on musl).
- **Windows untouched in behaviour:** the Windows tray helper keeps its process model; the only Windows-visible change is that its label strings come from `common::tray_policy::TrayLabels` (identical text).
- **Stand down silently** with no tray host or no session bus: one info line in `launcher.log`, nothing else. Never block launcher startup on the tray.
- **Copy motif:** menu labels lower-case except the product name — `Open ws-scrcpy-web`, `Exit…`, `stop the server and quit` / `stop the service and quit`, `cancel`. Tooltip `ws-scrcpy-web` / `ws-scrcpy-web (service)` (the Windows strings, verbatim).
- **Smoke-doc wording is user-acknowledged before it lands** (rows 14.8 and 14.9 below): the qa-harness asserts that doc.
- **Commits:** `git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" …`, conventional prefixes, one commit per task, on branch `feat/linux-tray` cut off `origin/main` with `pwsh C:/Users/jscha/.claude/scripts/git-new-branch.ps1 -Repo "C:/Users/jscha/source/repos/ws-scrcpy-web" -Branch feat/linux-tray` (or its hand-rolled equivalent with the `HEAD == origin/main` assertion if pwsh is unavailable).
- **Verification on this Windows box:** cross-platform tests run with `cargo test --workspace`; Linux-only code is compiled with `cargo check --workspace --target x86_64-unknown-linux-gnu` and `cargo clippy --workspace --all-targets --target x86_64-unknown-linux-gnu -- -D warnings` (both targets are installed). Linux-only unit tests run in CI (`build-and-test` on ubuntu). Behaviour is verified by smoke rows 14.8 / 14.9 and the qa-harness Linux guests.

---

## File Structure

| File | Responsibility |
|---|---|
| `common/src/tray_policy.rs` (new) | Pure, platform-independent decisions: eligibility (`should_spawn_tray`), session-bus detection (`session_bus_present`), the label set (`TrayLabels`), the embedded 22×22 ARGB icon and its validator. Unit-tested on every host. |
| `common/src/lib.rs` | `pub mod tray_policy;` + doc bullet. |
| `common/Cargo.toml` | Linux-only `ksni` dependency. |
| `common/src/tray.rs` | Linux `run` (ksni) replaces the `#[cfg(not(windows))]` stub; the stub stays for non-Windows, non-Linux targets. |
| `assets/tray-icon-22.argb` (new, generated) + `assets/TRAY-ICON-ARGB.md` (new) | The pixmap ksni serves, and how to regenerate it. |
| `scripts/rgba-to-argb.mjs` (new) | Ten-line stdin→stdout byte rotation used once to produce the asset. |
| `launcher/src/linux_tray.rs` (new) | Eligibility check, session-bus env fix-up, the tray thread, stop-flag hand-off. |
| `launcher/src/supervisor.rs` | Spawns the Linux tray thread after the Ctrl+C handler; `wait_with_signal` sends SIGTERM before SIGKILL on Linux. |
| `launcher/src/main.rs` | `mod linux_tray;` (cfg linux). |
| `tray/src/main.rs` | Uses `TrayLabels::for_mode` instead of its literal tuple (DRY). |
| `src/server/service/SystemdClient.ts` + `src/server/__tests__/SystemdClient.test.ts` | Dead autostart writer removed (the tray is a launcher thread; no Linux tray binary will ever exist). |
| `README.md`, `docs/TECHNICAL_GUIDE.md`, `CHANGELOG.md` | Four "Windows only" reverts, §20.2/§21 Linux half, `### Added`. |
| `docs/smoke-tests/smoke-test.md`, `docs/smoke-tests/automation-coverage.md` | Rows 14.8 / 14.9 + TOC + register. |

---

### Task 1: `common::tray_policy` — eligibility, session bus, labels

**Files:**
- Create: `common/src/tray_policy.rs`
- Modify: `common/src/lib.rs` (add `pub mod tray_policy;` after `pub mod tray;` and a doc bullet)
- Test: inline `#[cfg(test)] mod tests` in `common/src/tray_policy.rs`

**Interfaces:**
- Produces: `pub fn should_spawn_tray(install_mode: Option<&str>, session_bus_present: bool) -> bool`; `pub fn session_bus_present(dbus_session_bus_address: Option<&str>, runtime_bus_socket_exists: bool) -> bool`; `pub struct TrayLabels { tooltip, exit_title, exit_body, exit_action, balloon_title, balloon_body: &'static str }` with `pub fn for_mode(is_service_mode: bool) -> TrayLabels`; `pub const SYSTEM_SERVICE_MODE: &str`.

- [ ] **Step 1: Write the failing tests**

Create `common/src/tray_policy.rs` with ONLY the module doc and the test module first:

```rust
//! Pure, platform-independent tray decisions (todo item 63).
//!
//! Everything here is testable on every host: which instances get a tray, how
//! a session bus is detected, and the label set both trays share. The Linux
//! tray (`common::tray`, `launcher/src/linux_tray.rs`) consumes all of it; the
//! Windows tray helper (`tray/src/main.rs`) consumes `TrayLabels`.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_and_user_service_runs_get_a_tray_when_a_session_bus_exists() {
        assert!(should_spawn_tray(None, true));
        assert!(should_spawn_tray(Some("user"), true));
        assert!(should_spawn_tray(Some("user-service"), true));
    }

    #[test]
    fn system_scope_never_gets_a_tray() {
        // No session to draw in, even if a bus address leaked into the env.
        assert!(!should_spawn_tray(Some("system-service"), true));
        assert!(!should_spawn_tray(Some("system-service"), false));
    }

    #[test]
    fn no_session_bus_means_no_tray() {
        assert!(!should_spawn_tray(None, false));
        assert!(!should_spawn_tray(Some("user-service"), false));
    }

    #[test]
    fn session_bus_is_detected_from_the_env_var_or_the_runtime_socket() {
        assert!(session_bus_present(Some("unix:path=/run/user/1000/bus"), false));
        assert!(session_bus_present(None, true));
        assert!(!session_bus_present(None, false));
        // An empty or blank address is not an address.
        assert!(!session_bus_present(Some(""), false));
        assert!(!session_bus_present(Some("   "), false));
    }

    #[test]
    fn labels_mirror_the_windows_helper_strings() {
        let local = TrayLabels::for_mode(false);
        assert_eq!(local.tooltip, "ws-scrcpy-web");
        assert_eq!(local.exit_title, "Exit ws-scrcpy-web?");
        assert_eq!(local.exit_body, "Stop the server and quit?");
        assert_eq!(local.exit_action, "stop the server and quit");
        assert_eq!(local.balloon_title, "ws-scrcpy-web tray");

        let service = TrayLabels::for_mode(true);
        assert_eq!(service.tooltip, "ws-scrcpy-web (service)");
        assert_eq!(service.exit_body, "Stop the service and quit?");
        assert_eq!(service.exit_action, "stop the service and quit");
        assert_eq!(service.balloon_title, "ws-scrcpy-web (service) tray");
        // The balloon body is identical in both modes on purpose (see tray/src/main.rs).
        assert_eq!(local.balloon_body, service.balloon_body);
        assert!(local.balloon_body.contains("exit option from the tray menu"));
    }
}
```

Add to `common/src/lib.rs` after `pub mod tray;`:

```rust
pub mod tray_policy;
```

and a bullet in the module doc list: ``//!   - [`tray_policy`] — pure tray decisions (eligibility, session-bus detection, labels, the 22×22 ARGB icon) shared by both trays``.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p ws-scrcpy-web-common tray_policy`
Expected: compile error — `should_spawn_tray`, `session_bus_present`, `TrayLabels` not found.

- [ ] **Step 3: Implement**

Above the test module in `common/src/tray_policy.rs`:

```rust
/// `installMode` value of a system-scope service. It has no user session and
/// therefore no tray, whatever the environment says.
pub const SYSTEM_SERVICE_MODE: &str = "system-service";

/// Whether this launcher instance should show a tray icon at all.
///
/// Local runs (`installMode` absent or `"user"`) and user-scope services
/// (`"user-service"`) run inside the user's session and get one — provided a
/// session bus exists to register on. A system-scope service never does.
pub fn should_spawn_tray(install_mode: Option<&str>, session_bus_present: bool) -> bool {
    session_bus_present && install_mode != Some(SYSTEM_SERVICE_MODE)
}

/// Whether a D-Bus session bus is reachable: either `DBUS_SESSION_BUS_ADDRESS`
/// is set (non-blank), or `$XDG_RUNTIME_DIR/bus` exists (systemd's user
/// manager puts the bus there even when a unit's environment lacks the
/// variable — the caller then exports the address itself before spawning).
pub fn session_bus_present(dbus_session_bus_address: Option<&str>, runtime_bus_socket_exists: bool) -> bool {
    dbus_session_bus_address.is_some_and(|a| !a.trim().is_empty()) || runtime_bus_socket_exists
}

/// The text both trays show. Mode-aware because the service instance binds a
/// different port and the user should see which one they are quitting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrayLabels {
    /// Hover text on the icon.
    pub tooltip: &'static str,
    /// Windows confirm-dialog title.
    pub exit_title: &'static str,
    /// Windows confirm-dialog body.
    pub exit_body: &'static str,
    /// Linux `Exit…` submenu action — there is no dialog, the menu item IS the confirmation.
    pub exit_action: &'static str,
    /// Windows startup balloon title (launcher-spawned tray).
    pub balloon_title: &'static str,
    /// Windows startup balloon body — identical in both modes on purpose.
    pub balloon_body: &'static str,
}

impl TrayLabels {
    pub fn for_mode(is_service_mode: bool) -> Self {
        const BALLOON_BODY: &str =
            "tray started by launcher. to clear the tray, use the exit option from the tray menu.";
        if is_service_mode {
            Self {
                tooltip: "ws-scrcpy-web (service)",
                exit_title: "Exit ws-scrcpy-web?",
                exit_body: "Stop the service and quit?",
                exit_action: "stop the service and quit",
                balloon_title: "ws-scrcpy-web (service) tray",
                balloon_body: BALLOON_BODY,
            }
        } else {
            Self {
                tooltip: "ws-scrcpy-web",
                exit_title: "Exit ws-scrcpy-web?",
                exit_body: "Stop the server and quit?",
                exit_action: "stop the server and quit",
                balloon_title: "ws-scrcpy-web tray",
                balloon_body: BALLOON_BODY,
            }
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p ws-scrcpy-web-common tray_policy`
Expected: `test result: ok. 5 passed`.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add common/src/tray_policy.rs common/src/lib.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(tray): common::tray_policy — eligibility, session-bus detection and the shared label set (item 63)"
```

---

### Task 2: The 22×22 ARGB icon asset and its validator

**Files:**
- Create: `scripts/rgba-to-argb.mjs`
- Create: `assets/tray-icon-22.argb` (generated, 1,936 bytes) and `assets/TRAY-ICON-ARGB.md`
- Modify: `common/src/tray_policy.rs` (constants + `icon_argb_22()` + tests)

**Interfaces:**
- Produces: `pub const ICON_SIDE: i32 = 22`; `pub const ICON_ARGB_LEN: usize = 1936`; `pub fn icon_argb_22() -> Result<&'static [u8], String>` returning the embedded blob after a length check.

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `common/src/tray_policy.rs`:

```rust
    #[test]
    fn the_embedded_icon_is_a_22x22_argb32_pixmap_in_network_byte_order() {
        let px = icon_argb_22().expect("embedded icon passes the length check");
        assert_eq!(px.len(), ICON_ARGB_LEN);
        assert_eq!(ICON_ARGB_LEN, 22 * 22 * 4);
        // ARGB32, network order: byte 0 of a pixel is its alpha. The source PNG
        // has fully transparent corners and an opaque green centre, so a byte
        // order that is NOT A,R,G,B shows up here as a tinted or opaque corner.
        let corner = &px[0..4];
        assert_eq!(corner, &[0, 0, 0, 0], "top-left pixel must be fully transparent");
        let c = (11 * 22 + 11) * 4;
        let centre = &px[c..c + 4];
        assert_eq!(centre[0], 255, "centre pixel must be opaque (alpha first)");
        assert_eq!(&centre[1..4], &[166, 221, 59], "centre pixel must be the icon's green (R,G,B)");
        let opaque = px.chunks(4).filter(|p| p[0] == 255).count();
        let transparent = px.chunks(4).filter(|p| p[0] == 0).count();
        assert_eq!((opaque, transparent), (118, 158), "22x22 downscale of assets/tray-icon.png");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p ws-scrcpy-web-common the_embedded_icon`
Expected: compile error — `icon_argb_22` / `ICON_ARGB_LEN` not found.

- [ ] **Step 3: Write the byte-rotation script**

Create `scripts/rgba-to-argb.mjs`:

```js
#!/usr/bin/env node
/**
 * Rotate raw RGBA pixels into ARGB32, network byte order — the pixmap format
 * a StatusNotifierItem host expects (`ksni::Icon`). ImageMagick can emit raw
 * `RGBA:` but has no `ARGB:` coder, hence this shim. stdin → stdout.
 *
 *   magick assets/tray-icon.png -resize 22x22 -depth 8 RGBA:- \
 *     | node scripts/rgba-to-argb.mjs > assets/tray-icon-22.argb
 *
 * Developer-side, run once when the icon changes; the result is committed and
 * embedded with include_bytes! (common/src/tray_policy.rs). Nothing at build
 * or run time invokes ImageMagick.
 */
import { readFileSync, writeSync } from 'node:fs';

const rgba = readFileSync(0);
if (rgba.length === 0 || rgba.length % 4 !== 0) {
    console.error(`rgba-to-argb: ${rgba.length} bytes is not a whole number of RGBA pixels`);
    process.exit(1);
}
const argb = Buffer.alloc(rgba.length);
for (let i = 0; i < rgba.length; i += 4) {
    argb[i] = rgba[i + 3];
    argb[i + 1] = rgba[i];
    argb[i + 2] = rgba[i + 1];
    argb[i + 3] = rgba[i + 2];
}
writeSync(1, argb);
```

- [ ] **Step 4: Generate the asset (Git Bash, from the repo root)**

```bash
cd "C:/Users/jscha/source/repos/ws-scrcpy-web" && magick assets/tray-icon.png -resize 22x22 -depth 8 RGBA:- | node scripts/rgba-to-argb.mjs > assets/tray-icon-22.argb && wc -c < assets/tray-icon-22.argb
```

Expected: `1936`. Then `od -An -tu1 -N4 assets/tray-icon-22.argb` → `0 0 0 0`, and `od -An -tu1 -j 1012 -N4 assets/tray-icon-22.argb` (pixel 11,11 = byte offset (11·22+11)·4) → `255 166 221 59`.

Create `assets/TRAY-ICON-ARGB.md`:

```markdown
# tray-icon-22.argb

The 22×22 pixmap the Linux tray serves (`common::tray_policy::icon_argb_22`), as
ARGB32 in network byte order — the StatusNotifierItem spec's format. Generated
from `tray-icon.png` by hand; regenerate when the icon changes:

    magick assets/tray-icon.png -resize 22x22 -depth 8 RGBA:- | node scripts/rgba-to-argb.mjs > assets/tray-icon-22.argb

`common/src/tray_policy.rs` pins its length and its corner/centre pixels in a
unit test, so a wrong byte order or size fails `cargo test`. No build or run
step invokes ImageMagick (Local-Dependencies-Only).
```

- [ ] **Step 5: Implement the constants and validator**

Above the test module in `common/src/tray_policy.rs`:

```rust
/// Tray pixmap side, in pixels. 22 is the panel size KDE and the AppIndicator
/// extension render at natively; a host scales as needed.
pub const ICON_SIDE: i32 = 22;
/// Byte length of a 22×22 ARGB32 pixmap.
pub const ICON_ARGB_LEN: usize = (ICON_SIDE * ICON_SIDE * 4) as usize;
/// The committed pixmap (`assets/TRAY-ICON-ARGB.md` says how it is made).
const TRAY_ICON_ARGB_22: &[u8] = include_bytes!("../../assets/tray-icon-22.argb");

/// The embedded icon, after the one check that can fail at build time: a
/// regenerated asset of the wrong size would otherwise be rejected by the host
/// with no useful message.
pub fn icon_argb_22() -> Result<&'static [u8], String> {
    if TRAY_ICON_ARGB_22.len() != ICON_ARGB_LEN {
        return Err(format!(
            "assets/tray-icon-22.argb: expected {ICON_ARGB_LEN} bytes for a {ICON_SIDE}x{ICON_SIDE} ARGB32 pixmap, got {}",
            TRAY_ICON_ARGB_22.len()
        ));
    }
    Ok(TRAY_ICON_ARGB_22)
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p ws-scrcpy-web-common tray_policy`
Expected: `6 passed`.

Also: `npm run lint` — biome formats `scripts/rgba-to-argb.mjs`; run `npm run format` if it complains.

- [ ] **Step 7: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add scripts/rgba-to-argb.mjs assets/tray-icon-22.argb assets/TRAY-ICON-ARGB.md common/src/tray_policy.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(tray): 22x22 ARGB32 tray pixmap asset + validator (item 63)"
```

---

### Task 3: The Linux `common::tray::run` on ksni

**Files:**
- Modify: `common/Cargo.toml` (Linux-only dependency)
- Modify: `common/src/tray.rs` — replace the `#[cfg(not(windows))]` stub block (the section that starts at the `// =====…` banner "Linux (and other non-Windows) stub — SP3 P4b decision: path (b)" and runs to the end of the file) and update the module doc's "## Linux (best-effort stub …)" section.

**Interfaces:**
- Consumes: `common::tray::TrayAction` (unchanged), `common::log::info` / `error`, `common::tray_policy::{ICON_SIDE, ICON_ARGB_LEN}`.
- Produces: `#[cfg(target_os = "linux")] pub fn run(icon_bytes: &[u8], tooltip: &str, confirm_title: &str, confirm_body: &str, open_url_provider: Box<dyn Fn() -> String>, startup_balloon: Option<(&str, &str)>) -> anyhow::Result<TrayAction>` — same signature as Windows. On Linux `icon_bytes` is the 22×22 ARGB32 pixmap (not an ICO), `confirm_body` is the label of the confirming menu item, `confirm_title` and `startup_balloon` are unused.

- [ ] **Step 1: Add the dependency**

In `common/Cargo.toml`, after the `[target.'cfg(windows)'.dependencies]` block:

```toml
# Linux-only: the tray is a StatusNotifierItem over D-Bus, pure Rust (item 63).
# `blocking` gives the launcher a synchronous API; `async-io` is the runtime
# ksni drives it with (one of `tokio` / `async-io` is mandatory, and the
# launcher has no tokio). No C library anywhere in this tree — `cross check`
# and the musl release build stay green, unlike the tray-icon/libappindicator
# path P4a tried and P4b removed.
[target.'cfg(target_os = "linux")'.dependencies]
ksni = { version = "0.3", default-features = false, features = ["blocking", "async-io"] }
```

Run: `cargo check -p ws-scrcpy-web-common --target x86_64-unknown-linux-gnu`
Expected: compiles (downloads ksni + zbus + async-io). If it fails with `Either "tokio" (default) or "async-io" must be enabled`, the feature list above is wrong — fix the feature list, do not add tokio.

- [ ] **Step 2: Replace the stub with the implementation**

Replace everything from the banner comment `// Linux (and other non-Windows) stub — SP3 P4b decision: path (b).` (including the `#[cfg(not(windows))] pub fn run` and its `linux_stub_tests` module) with:

```rust
// =====================================================================
// Linux — StatusNotifierItem over D-Bus via ksni (todo item 63).
//
// Design (docs/superpowers/specs/2026-09-06-linux-tray-design.md):
//   - the tray runs on the caller's thread (the launcher spawns one),
//   - menu callbacks only post events on a channel — ksni warns that a
//     blocking callback freezes the menu — and this loop does the work,
//   - no StatusNotifier host / no session bus → log once, return Cancelled
//     (stand down silently; Settings → Server is the stop path there),
//   - Exit… is a submenu (stop and quit / cancel): the menu item IS the
//     confirmation, since ksni has no dialog and zenity/kdialog are
//     external binaries.
// =====================================================================

#[cfg(target_os = "linux")]
mod linux {
    use std::process::{Command, Stdio};
    use std::sync::mpsc::Sender;

    use ksni::menu::{MenuItem, StandardItem, SubMenu};
    use ksni::{Category, Icon, Status, ToolTip};

    /// What the tray asks the `run` loop to do. Callbacks never do it themselves.
    pub(super) enum TrayEvent {
        Open,
        ConfirmedExit,
    }

    pub(super) struct LinuxTray {
        pub(super) tooltip: String,
        pub(super) exit_action: String,
        pub(super) icon_argb: Vec<u8>,
        pub(super) events: Sender<TrayEvent>,
    }

    impl LinuxTray {
        fn emit(&self, event: TrayEvent) {
            // The receiver is the run loop; if it is gone the tray is going too.
            let _ = self.events.send(event);
        }
    }

    impl ksni::Tray for LinuxTray {
        fn id(&self) -> String {
            "ws-scrcpy-web".into()
        }

        fn title(&self) -> String {
            self.tooltip.clone()
        }

        fn category(&self) -> Category {
            Category::ApplicationStatus
        }

        fn status(&self) -> Status {
            Status::Active
        }

        fn icon_pixmap(&self) -> Vec<Icon> {
            vec![Icon {
                width: crate::tray_policy::ICON_SIDE,
                height: crate::tray_policy::ICON_SIDE,
                data: self.icon_argb.clone(),
            }]
        }

        fn tool_tip(&self) -> ToolTip {
            ToolTip {
                title: self.tooltip.clone(),
                ..Default::default()
            }
        }

        /// Left click: open the app, the same as the Windows tray.
        fn activate(&mut self, _x: i32, _y: i32) {
            self.emit(TrayEvent::Open);
        }

        fn menu(&self) -> Vec<MenuItem<Self>> {
            vec![
                MenuItem::Standard(StandardItem {
                    label: "Open ws-scrcpy-web".into(),
                    activate: Box::new(|t: &mut Self| t.emit(TrayEvent::Open)),
                    ..Default::default()
                }),
                MenuItem::Separator,
                MenuItem::SubMenu(SubMenu {
                    label: "Exit\u{2026}".into(),
                    submenu: vec![
                        MenuItem::Standard(StandardItem {
                            label: self.exit_action.clone(),
                            activate: Box::new(|t: &mut Self| t.emit(TrayEvent::ConfirmedExit)),
                            ..Default::default()
                        }),
                        MenuItem::Standard(StandardItem {
                            label: "cancel".into(),
                            activate: Box::new(|_t: &mut Self| {}),
                            ..Default::default()
                        }),
                    ],
                    ..Default::default()
                }),
            ]
        }
    }

    /// Open `url` in the user's default browser. Absolute path on purpose
    /// (Local-Dependencies-Only): the Linux launcher never resolves a tool
    /// from PATH. Fire-and-forget, like the Windows `ShellExecuteW` path.
    pub(super) fn open_url(url: &str) {
        match Command::new("/usr/bin/xdg-open")
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(_) => crate::log::info(&format!("tray: opened {url} via /usr/bin/xdg-open")),
            Err(e) => crate::log::error(&format!("tray: /usr/bin/xdg-open {url} failed: {e}")),
        }
    }
}

/// Linux implementation of [`run`]. Same signature as Windows; here
/// `icon_bytes` is the 22×22 ARGB32 pixmap from
/// [`crate::tray_policy::icon_argb_22`], `confirm_body` is the label of the
/// confirming `Exit…` submenu item, and `confirm_title` / `startup_balloon` are
/// unused (no dialog, no balloon in the SNI model).
///
/// Returns `Ok(TrayAction::Cancelled)` — after ONE info line — when the icon
/// cannot be shown: no session bus, no StatusNotifier host (stock GNOME,
/// Fedora Workstation), or the host went away. That is the spec's "stand down
/// silently" (decision 1). Startup is never blocked: callers run this on its
/// own thread.
#[cfg(target_os = "linux")]
pub fn run(
    icon_bytes: &[u8],
    tooltip: &str,
    _confirm_title: &str,
    confirm_body: &str,
    open_url_provider: Box<dyn Fn() -> String>,
    _startup_balloon: Option<(&str, &str)>,
) -> anyhow::Result<TrayAction> {
    use ksni::blocking::TrayMethods;
    use linux::{LinuxTray, TrayEvent};

    if icon_bytes.len() != crate::tray_policy::ICON_ARGB_LEN {
        return Err(anyhow::anyhow!(
            "tray: icon must be a {}x{} ARGB32 pixmap ({} bytes), got {}",
            crate::tray_policy::ICON_SIDE,
            crate::tray_policy::ICON_SIDE,
            crate::tray_policy::ICON_ARGB_LEN,
            icon_bytes.len()
        ));
    }

    let (tx, rx) = std::sync::mpsc::channel::<TrayEvent>();
    let tray = LinuxTray {
        tooltip: tooltip.to_string(),
        exit_action: confirm_body.to_string(),
        icon_argb: icon_bytes.to_vec(),
        events: tx,
    };

    // spawn() fails immediately when there is no StatusNotifierWatcher on the
    // bus (ksni::Error::Watcher) or no bus at all (ksni::Error::Dbus). Both are
    // the stand-down case, not an error: the app is fine, it just has no
    // tray on this desktop.
    let handle = match tray.spawn() {
        Ok(handle) => handle,
        Err(e) => {
            crate::log::info(&format!(
                "linux-tray: no StatusNotifier host on this desktop ({e}); standing down — Settings → Server stops the app"
            ));
            return Ok(TrayAction::Cancelled);
        }
    };
    crate::log::info(&format!("linux-tray: icon registered (tooltip {tooltip:?})"));

    loop {
        match rx.recv() {
            Ok(TrayEvent::Open) => linux::open_url(&open_url_provider()),
            Ok(TrayEvent::ConfirmedExit) => {
                crate::log::info("linux-tray: exit confirmed from the tray menu");
                let _ = handle.shutdown();
                return Ok(TrayAction::ConfirmedExit);
            }
            // Every sender is gone: ksni dropped the tray (watcher went away).
            Err(_) => {
                crate::log::info("linux-tray: tray service ended (host gone); standing down");
                return Ok(TrayAction::Cancelled);
            }
        }
    }
}

/// Other non-Windows targets (macOS builds of the workspace) keep the P4b
/// stub: no tray, [`TrayAction::Cancelled`] immediately.
#[cfg(not(any(windows, target_os = "linux")))]
pub fn run(
    _icon_bytes: &[u8],
    _tooltip: &str,
    _confirm_title: &str,
    _confirm_body: &str,
    _open_url_provider: Box<dyn Fn() -> String>,
    _startup_balloon: Option<(&str, &str)>,
) -> anyhow::Result<TrayAction> {
    Ok(TrayAction::Cancelled)
}

#[cfg(all(test, not(any(windows, target_os = "linux"))))]
mod stub_tests {
    use super::*;

    #[test]
    fn run_returns_cancelled_on_other_platforms() {
        let action = run(b"", "tooltip", "title", "body", Box::new(|| "http://localhost:8000".to_string()), None)
            .expect("stub must not error");
        assert_eq!(action, TrayAction::Cancelled);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::*;

    #[test]
    fn a_wrong_sized_icon_is_an_error_before_any_dbus_work() {
        let err = run(b"not a pixmap", "t", "title", "body", Box::new(String::new), None)
            .err()
            .expect("wrong length must be rejected");
        assert!(err.to_string().contains("ARGB32"));
    }
}
```

Also update the module doc at the top of `common/src/tray.rs`: replace the `//! ## Linux (best-effort stub — SP3 P4b decision: path (b))` section (through `//! StatusNotifierItem implementation) is deferred to P5+.`) with:

```rust
//! ## Linux (ksni — todo item 63, 2026-09-06)
//!
//! A StatusNotifierItem over D-Bus, pure Rust (`ksni`, `blocking` + `async-io`,
//! no tokio, no C libraries), run on the calling thread — the launcher spawns
//! one (`launcher/src/linux_tray.rs`). Menu callbacks post events on a channel
//! and the `run` loop acts on them: **Open** → `/usr/bin/xdg-open`, **Exit… →
//! stop the server and quit** → [`TrayAction::ConfirmedExit`] (the launcher then
//! flips its stop flag and SIGTERMs Node). With no StatusNotifier host (stock
//! GNOME / Fedora Workstation) or no session bus, `run` logs one line and
//! returns [`TrayAction::Cancelled`]: stand down silently, Settings → Server
//! remains the stop path. `icon_bytes` is the 22×22 ARGB32 pixmap from
//! `tray_policy::icon_argb_22`, not an ICO. The P4b history (tray-icon +
//! libappindicator pulled GTK and broke `cross check`) is why it is ksni.
```

- [ ] **Step 3: Compile for Linux and run clippy on it**

Run: `cargo check -p ws-scrcpy-web-common --target x86_64-unknown-linux-gnu && cargo clippy -p ws-scrcpy-web-common --all-targets --target x86_64-unknown-linux-gnu -- -D warnings`
Expected: clean. Likely first-compile fixes: if `StandardItem`/`SubMenu` do not implement `Default` for this `T`, spell every field (`enabled: true, visible: true, icon_name: String::new(), icon_data: vec![], shortcut: vec![], disposition: ksni::menu::Disposition::Normal`); if `Handle::shutdown()` returns a value that must be awaited, `let _ =` already discards it.

Run: `cargo check -p ws-scrcpy-web-common --target x86_64-unknown-linux-musl`
Expected: clean (release target).

Run: `cargo test -p ws-scrcpy-web-common`
Expected: on this Windows host the Windows tests + the 6 `tray_policy` tests pass (the Linux module is not compiled here; CI's ubuntu leg runs `linux_tests`).

- [ ] **Step 4: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add common/Cargo.toml common/src/tray.rs Cargo.lock
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(tray): Linux StatusNotifierItem tray on ksni in common::tray::run; stands down with no host (item 63)"
```

---

### Task 4: Graceful stop — the supervisor sends SIGTERM before it kills (Linux)

**Files:**
- Modify: `launcher/src/supervisor.rs` — `wait_with_signal` (currently lines 403–420) and a new pure helper + tests near `decide_restart`.

**Interfaces:**
- Produces: `pub(crate) const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(10)`; `pub(crate) fn graceful_wait_exhausted(elapsed: Duration) -> bool`.
- Why: the tray's exit flips the same `stop` flag Ctrl+C sets; today that path is `child.kill()` (SIGKILL on Linux), which skips Node's `gracefulShutdown` (adb teardown, db backup). Node already handles SIGTERM (`process.on('SIGTERM', …)` in `src/server/index.ts`), so the launcher sends that first.

- [ ] **Step 1: Write the failing tests**

In `launcher/src/supervisor.rs` `mod tests`, after `decide_restart_marker_takes_precedence_over_exit_75`:

```rust
    #[test]
    fn graceful_wait_is_exhausted_exactly_at_the_timeout() {
        assert!(!graceful_wait_exhausted(Duration::from_secs(0)));
        assert!(!graceful_wait_exhausted(GRACEFUL_STOP_TIMEOUT - Duration::from_millis(1)));
        assert!(graceful_wait_exhausted(GRACEFUL_STOP_TIMEOUT));
        assert!(graceful_wait_exhausted(GRACEFUL_STOP_TIMEOUT + Duration::from_secs(1)));
    }

    #[test]
    fn graceful_timeout_is_ten_seconds() {
        // Long enough for adb kill-server + the SQLite backup on a slow disk,
        // short enough that a wedged Node does not hold a Ctrl+C for long.
        assert_eq!(GRACEFUL_STOP_TIMEOUT, Duration::from_secs(10));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p ws-scrcpy-web-launcher graceful`
Expected: compile error — `graceful_wait_exhausted` / `GRACEFUL_STOP_TIMEOUT` not found.

- [ ] **Step 3: Implement**

After `decide_restart` (around line 36–50) add:

```rust
/// How long a stop request waits for Node to exit on its own after SIGTERM
/// before the supervisor kills it. Node's SIGTERM handler runs
/// `gracefulShutdown` (adb kill-server, service release, SQLite backup) and
/// exits 0 well inside this.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// Pure: has the graceful window closed? Kept separate so the timing rule is
/// unit-tested without a child process.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn graceful_wait_exhausted(elapsed: Duration) -> bool {
    elapsed >= GRACEFUL_STOP_TIMEOUT
}
```

Replace `wait_with_signal` with:

```rust
/// Wait for child to exit, polling for the stop flag at POLL_INTERVAL.
///
/// On stop: Linux sends SIGTERM first — Node's `process.on('SIGTERM')` runs the
/// same graceful teardown the Settings "stop server & exit" button does — and
/// only kills after `GRACEFUL_STOP_TIMEOUT`. Windows has no SIGTERM
/// (`kill()` is TerminateProcess either way), so it keeps the immediate kill.
/// The Linux tray's exit and Ctrl+C both arrive here through `stop`.
fn wait_with_signal(
    child: &mut std::process::Child,
    stop: &Arc<AtomicBool>,
) -> Result<std::process::ExitStatus> {
    loop {
        if stop.load(Ordering::SeqCst) {
            #[cfg(target_os = "linux")]
            {
                log::info(&format!(
                    "supervisor: stop requested; sending SIGTERM to child pid {} for a graceful exit",
                    child.id()
                ));
                let pid = rustix::process::Pid::from_child(child);
                if let Err(e) = rustix::process::kill_process(pid, rustix::process::Signal::TERM) {
                    log::error(&format!("supervisor: SIGTERM to child failed ({e}); killing instead"));
                } else {
                    let started = std::time::Instant::now();
                    loop {
                        if let Some(status) = child.try_wait()? {
                            log::info("supervisor: child exited on SIGTERM");
                            return Ok(status);
                        }
                        if graceful_wait_exhausted(started.elapsed()) {
                            log::error(&format!(
                                "supervisor: child ignored SIGTERM for {}s; killing",
                                GRACEFUL_STOP_TIMEOUT.as_secs()
                            ));
                            break;
                        }
                        thread::sleep(POLL_INTERVAL);
                    }
                }
            }
            log::info(&format!("supervisor: terminating child pid {}", child.id()));
            let _ = child.kill();
            return Ok(child.wait()?);
        }
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        thread::sleep(POLL_INTERVAL);
    }
}
```

`rustix` with the `process` feature is already a Linux dependency of the launcher (`launcher/Cargo.toml`, `[target.'cfg(target_os = "linux")'.dependencies]`); `Pid::from_child`, `kill_process` and `Signal::TERM` are rustix 1.1's names (verified in the registry source).

- [ ] **Step 4: Run the tests and the cross-target checks**

Run: `cargo test -p ws-scrcpy-web-launcher` → the two new tests pass alongside the existing ones.
Run: `cargo clippy -p ws-scrcpy-web-launcher --all-targets --target x86_64-unknown-linux-gnu -- -D warnings` → clean.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/supervisor.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "fix(launcher): a stop request SIGTERMs Node before killing it on Linux, so Ctrl+C and the tray exit run the graceful teardown (item 63)"
```

---

### Task 5: `launcher/src/linux_tray.rs` — eligibility, bus fix-up, the tray thread

**Files:**
- Create: `launcher/src/linux_tray.rs`
- Modify: `launcher/src/main.rs` — add `#[cfg(target_os = "linux")] mod linux_tray;` next to the other `#[cfg(target_os = "linux")] mod …;` lines (around lines 22–28).
- Modify: `launcher/src/supervisor.rs` — spawn the tray right after the Ctrl+C handler block (after `log::error(&format!("could not install Ctrl+C handler: {e}"));` `}` — currently line 196).

**Interfaces:**
- Consumes: `common::tray::run`, `common::tray_policy::{should_spawn_tray, session_bus_present, TrayLabels, icon_argb_22}`, `common::config::AppConfig::{load, is_service_mode}`, the supervisor's `stop: Arc<AtomicBool>`.
- Produces: `pub fn spawn_if_eligible(data_root: &Path, stop: Arc<AtomicBool>)` (cfg linux) — returns immediately; the thread is fire-and-forget.

- [ ] **Step 1: Write the module**

Create `launcher/src/linux_tray.rs`:

```rust
//! The Linux tray, as a thread inside the launcher (todo item 63, decision 2).
//!
//! Windows needs a separate tray process and a supervisor because that
//! launcher runs as LocalSystem under Servy and the icon must live in the
//! user's session. On Linux the launcher already runs in the session for local
//! and user-scope service runs, so the icon simply lives and dies with the
//! instance: nothing to respawn. System scope has no session and stands down.
//!
//! Stand-down cases (decision 1 — silently, one info line):
//!   - `installMode` is `system-service`,
//!   - no session bus (`DBUS_SESSION_BUS_ADDRESS` unset AND no `$XDG_RUNTIME_DIR/bus`),
//!   - no StatusNotifier host on the bus (stock GNOME, Fedora Workstation) —
//!     detected by `common::tray::run`, which returns `Cancelled`.
//!
//! A confirmed exit flips the supervisor's `stop` flag; `wait_with_signal`
//! then SIGTERMs Node (graceful teardown) and the launcher exits.

#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use common::config::AppConfig;
use common::tray::TrayAction;
use common::tray_policy::{icon_argb_22, session_bus_present, should_spawn_tray, TrayLabels};

use crate::log;

/// `$XDG_RUNTIME_DIR/bus` — where systemd's user manager puts the session bus.
fn runtime_bus_socket() -> Option<PathBuf> {
    std::env::var_os("XDG_RUNTIME_DIR").map(|dir| PathBuf::from(dir).join("bus"))
}

/// A user-scope systemd unit can run without `DBUS_SESSION_BUS_ADDRESS` in its
/// environment while the bus socket is right there in the runtime dir. zbus
/// needs the variable, so export it from the socket when it is missing.
/// Returns whether a session bus is now reachable.
fn ensure_session_bus_env() -> bool {
    let addr = std::env::var("DBUS_SESSION_BUS_ADDRESS").ok();
    let socket = runtime_bus_socket();
    let socket_exists = socket.as_deref().is_some_and(Path::exists);
    if !session_bus_present(addr.as_deref(), socket_exists) {
        return false;
    }
    if addr.as_deref().is_none_or(|a| a.trim().is_empty()) {
        if let Some(sock) = socket {
            let value = format!("unix:path={}", sock.display());
            log::info(&format!("linux-tray: DBUS_SESSION_BUS_ADDRESS was unset; using {value}"));
            std::env::set_var("DBUS_SESSION_BUS_ADDRESS", value);
        }
    }
    true
}

/// Spawn the tray thread when this instance should have one. Never blocks;
/// never fails the caller.
pub fn spawn_if_eligible(data_root: &Path, stop: Arc<AtomicBool>) {
    let cfg = AppConfig::load(data_root);
    let bus = ensure_session_bus_env();
    if !should_spawn_tray(cfg.install_mode.as_deref(), bus) {
        log::info(&format!(
            "linux-tray: not spawning (installMode={:?}, session bus={bus}); Settings → Server stops the app",
            cfg.install_mode
        ));
        return;
    }
    let icon = match icon_argb_22() {
        Ok(bytes) => bytes,
        Err(e) => {
            log::error(&format!("linux-tray: {e}; not spawning"));
            return;
        }
    };
    let labels = TrayLabels::for_mode(cfg.is_service_mode());
    let data_root = data_root.to_path_buf();

    let spawned = std::thread::Builder::new().name("linux-tray".into()).spawn(move || {
        // Re-read config.json on every click: a web-port change or a mode swap
        // mid-session must open the port that is live NOW (same rule as the
        // Windows helper). The tray opens the browser ON this machine, so
        // localhost is the right host here.
        let provider: Box<dyn Fn() -> String> = Box::new(move || {
            let live = AppConfig::load(&data_root);
            format!("http://localhost:{}", live.web_port.unwrap_or(8000))
        });
        match common::tray::run(icon, labels.tooltip, labels.exit_title, labels.exit_action, provider, None) {
            Ok(TrayAction::ConfirmedExit) => {
                log::info("linux-tray: exit confirmed; asking the supervisor to stop Node");
                stop.store(true, Ordering::SeqCst);
            }
            Ok(TrayAction::Cancelled) => {
                // run() already logged why (no host / no bus / host gone).
            }
            Err(e) => log::error(&format!("linux-tray: {e}")),
        }
    });
    if let Err(e) = spawned {
        log::error(&format!("linux-tray: could not spawn the tray thread: {e}"));
    }
}
```

`Option::is_none_or` is stable since Rust 1.82 (the toolchain is 1.98 and clippy already demands it elsewhere in this crate).

- [ ] **Step 2: Wire it in**

`launcher/src/main.rs`, with the other Linux modules:

```rust
#[cfg(target_os = "linux")]
mod linux_tray;
```

`launcher/src/supervisor.rs`, immediately after the Ctrl+C handler block (after the closing `}` of `if let Err(e) = ctrlc::set_handler(...) { ... }`):

```rust
    // Item 63 — the Linux tray is a thread in THIS process (Windows spawns a
    // helper above, in the cfg(windows) block). It shares `stop` with the
    // Ctrl+C handler: a confirmed exit from the tray menu is a stop request,
    // and wait_with_signal turns that into SIGTERM → graceful teardown.
    #[cfg(target_os = "linux")]
    crate::linux_tray::spawn_if_eligible(&paths.data_root, stop.clone());
```

- [ ] **Step 3: Compile for Linux, clippy, and run the host tests**

Run: `cargo check --workspace --target x86_64-unknown-linux-gnu && cargo clippy --workspace --all-targets --target x86_64-unknown-linux-gnu -- -D warnings`
Expected: clean.
Run: `cargo check --workspace --target x86_64-unknown-linux-musl`
Expected: clean.
Run: `cargo test --workspace`
Expected: all green on this host (Windows + cross-platform tests).

- [ ] **Step 4: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/linux_tray.rs launcher/src/main.rs launcher/src/supervisor.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(launcher): spawn the Linux tray thread for local and user-scope runs; stand down for system scope or no session bus (item 63)"
```

---

### Task 6: The Windows tray helper reads its labels from `TrayLabels`

**Files:**
- Modify: `tray/src/main.rs` lines 169–186 (the `let (tooltip, exit_title, exit_msg, balloon_title, balloon_text) = if is_service_mode_at_start { … } else { … };` tuple).

**Interfaces:**
- Consumes: `common::tray_policy::TrayLabels::for_mode`.

- [ ] **Step 1: Replace the tuple**

Replace the whole `let (tooltip, exit_title, exit_msg, balloon_title, balloon_text): (&str, &str, &str, &str, &str) = if is_service_mode_at_start { … } else { … };` statement with:

```rust
    // The label set is shared with the Linux tray (common::tray_policy) so the
    // two cannot drift; the wording is unchanged from the pre-item-63 tuple.
    let labels = common::tray_policy::TrayLabels::for_mode(is_service_mode_at_start);
    let (tooltip, exit_title, exit_msg, balloon_title, balloon_text) = (
        labels.tooltip,
        labels.exit_title,
        labels.exit_body,
        labels.balloon_title,
        labels.balloon_body,
    );
```

Keep the comment block above it (lines 163–168) — it still explains why the balloon body is mode-independent.

- [ ] **Step 2: Build and test the Windows helper**

Run: `cargo test -p ws-scrcpy-web-tray && cargo clippy -p ws-scrcpy-web-tray --all-targets -- -D warnings`
Expected: green. The `labels_mirror_the_windows_helper_strings` test in Task 1 is the guard that the text did not change.

- [ ] **Step 3: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add tray/src/main.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "refactor(tray): Windows helper takes its labels from common::tray_policy (item 63)"
```

---

### Task 7: Remove the dead Linux tray-autostart writer (Node)

**Files:**
- Modify: `src/server/service/SystemdClient.ts` — delete `TRAY_HELPER_BIN` (line 64), `resolveTrayHelperPath` (lines ~374–396), `writeTrayAutostart` (lines ~668–699) and the call in `install()` (lines ~557–563); reword the class doc (lines 13–15) and the `removeTrayAutostart` doc.
- Modify: `src/server/__tests__/SystemdClient.test.ts` — delete the test `'user scope: writes an ABSOLUTE-path tray autostart when a tray binary exists (never a bare PATH name)'` (lines ~240–257); reword the comment at lines ~211–212.

**Why:** the writer only ever ran when a `ws-scrcpy-web-tray` binary sat next to the launcher; with the tray as a launcher thread no such binary will exist on Linux, so the branch is dead. The **remover** stays: pre-beta.45 installs wrote the file and uninstall must still clean it (the launcher's `linux_app_uninstall.rs` does the same defensively).

- [ ] **Step 1: Write the failing test change**

In `src/server/__tests__/SystemdClient.test.ts`, delete the whole `it('user scope: writes an ABSOLUTE-path tray autostart when a tray binary exists (never a bare PATH name)', …)` block, and change the comment above the `desktopWrites` assertion in the first user-scope test to:

```ts
            // Item 63: the Linux tray is a thread inside the launcher, so there is no
            // tray binary and NO autostart .desktop is ever written (the remover in
            // uninstall() stays, for pre-beta.45 installs that have one).
```

Run: `npx vitest run src/server/__tests__/SystemdClient.test.ts`
Expected: still green (the deleted test asserted a branch that is about to go).

- [ ] **Step 2: Remove the writer**

In `src/server/service/SystemdClient.ts`:
1. Delete `const TRAY_HELPER_BIN = 'ws-scrcpy-web-tray';` and its doc line. Keep `TRAY_AUTOSTART_FILE`.
2. Delete the `resolveTrayHelperPath` function and its doc block.
3. In `install()`, delete the block from `// Best-effort tray autostart. System scope skips this — headless` through the `}` closing its `try/catch`.
4. Delete `writeTrayAutostart` and its doc block.
5. Reword the class doc lines 13–15 from ``A `~/.config/autostart/ ws-scrcpy-web-tray.desktop` file is written to autostart the tray helper at desktop login (best-effort).`` to: ``No autostart entry is written since item 63 — the Linux tray is a thread inside the launcher — but `uninstall()` still removes the `~/.config/autostart/ws-scrcpy-web-tray.desktop` older installs left behind.``
6. Reword `removeTrayAutostart`'s doc: `/** Remove the legacy tray autostart .desktop file (written by pre-beta.45 installs). Idempotent. */`.

- [ ] **Step 3: Verify**

Run: `npm run lint && npx tsc --noEmit && npx vitest run src/server/__tests__/SystemdClient.test.ts`
Expected: lint clean (biome will flag an unused `fileExists` import only if nothing else uses it — `resolveActiveScope` does), tsc clean, tests green.

- [ ] **Step 4: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/service/SystemdClient.ts src/server/__tests__/SystemdClient.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "chore(service): drop the dead Linux tray-autostart writer; the tray is a launcher thread (item 63)"
```

---

### Task 8: Docs — README, TECHNICAL_GUIDE, CHANGELOG

**Files:**
- Modify: `README.md` lines 43, 262, 306–308, 326
- Modify: `docs/TECHNICAL_GUIDE.md` §20.2 (line ~1800), §20.9 Key Files table, §21 (new §21.4 after §21.3), §21.3 Key Files
- Modify: `CHANGELOG.md` under `## [Unreleased]`

- [ ] **Step 1: README — the four "Windows only" spots**

Line 43, replace the whole bullet with:

```markdown
- **System tray icon** -- quick-open browser, a mode-aware tooltip (local vs. service) and a clean exit. Windows: a standalone helper the launcher's supervisor auto-spawns and auto-recovers. Linux: a StatusNotifierItem icon inside the launcher — KDE Plasma and any desktop with a StatusNotifier host; stock GNOME (Fedora Workstation) has no host, so no icon appears there and Settings → Server → **stop the server and close the app** remains the exit path.
```

Line 262, replace with:

```markdown
2. **Tray** -- Windows: the tray supervisor spawns the standalone tray helper and polls every 10 seconds, respawning it if it crashes or is killed. Linux: the tray is a thread inside the launcher (`ksni`, StatusNotifierItem over D-Bus) for local and user-scope-service runs; it lives and dies with the instance, so there is nothing to respawn, and it stands down silently when the desktop has no StatusNotifier host.
```

Lines 306–308 (`#### Tray icon` and its paragraph), replace the paragraph with:

```markdown
On Linux the launcher shows a StatusNotifierItem tray icon wherever a StatusNotifier host is running (KDE Plasma out of the box; GNOME only with the AppIndicator extension). Hover for the mode (`ws-scrcpy-web` or `ws-scrcpy-web (service)`), left-click or **Open ws-scrcpy-web** to open the app, **Exit… → stop the server and quit** to stop it cleanly (the launcher sends Node SIGTERM, so the adb teardown runs). Where there is no host — stock GNOME, Fedora Workstation — the icon simply does not appear and `launcher.log` says so once; use Settings → Server → **stop the server and close the app** there. System-scope services have no desktop session and never show a tray.
```

Line 326, replace `the primary clean-exit path on Linux (no tray there), disabled in service mode.` with `the clean-exit path on desktops without a tray host (stock GNOME), disabled in service mode; where a StatusNotifier host exists (KDE Plasma) the tray's **Exit… → stop the server and quit** does the same.`

- [ ] **Step 2: TECHNICAL_GUIDE**

§20.2, after the bullet list, add:

```markdown
On Linux there is no tray supervisor: the tray is a thread inside the launcher (`launcher/src/linux_tray.rs`, section 21.4), spawned from `supervisor::run` right after the Ctrl+C handler and sharing its `stop` flag. A confirmed exit from the tray menu is a stop request, and `wait_with_signal` sends Node **SIGTERM** first (Node's handler runs the same graceful teardown as the Settings button), killing only after `GRACEFUL_STOP_TIMEOUT` (10 s).
```

§20.9 Key Files: add rows

```markdown
| `launcher/src/linux_tray.rs` | Linux tray thread: eligibility, session-bus fix-up, hand-off to the stop flag |
| `common/src/tray_policy.rs` | Pure tray decisions shared by both trays: eligibility, session bus, labels, the ARGB icon |
```

After §21.3's table (before the `---` that precedes `## 22.`), add:

```markdown
### 21.4 Linux tray (in-process)

Linux has no `ws-scrcpy-web-tray` binary. `common::tray::run`'s Linux implementation is a StatusNotifierItem over D-Bus built on `ksni` (pure Rust, `blocking` + `async-io`, no tokio and no C libraries — the `tray-icon`/libappindicator route P4a tried pulled GTK and broke `cross check`), run on a thread the launcher spawns for local and user-scope-service runs.

| Aspect | Behaviour |
|--------|-----------|
| Eligibility | `tray_policy::should_spawn_tray(installMode, session bus)` — never for `system-service`; needs `DBUS_SESSION_BUS_ADDRESS` or `$XDG_RUNTIME_DIR/bus` (the launcher exports the address from the socket when a user unit's environment lacks it). |
| No host | `spawn()` fails when no `org.kde.StatusNotifierWatcher` is on the bus (stock GNOME, Fedora Workstation): one info line in `launcher.log`, `TrayAction::Cancelled`, nothing else. Settings → Server is the exit path there. |
| Icon | `assets/tray-icon-22.argb`, a committed 22×22 ARGB32 pixmap (`assets/TRAY-ICON-ARGB.md`), pinned by a unit test. |
| Menu | **Open ws-scrcpy-web** · separator · **Exit…** → **stop the server and quit** / **cancel**. The submenu is the confirmation (ksni has no dialog; `zenity` would be an external binary). Left-click = Open. |
| Open | `/usr/bin/xdg-open http://localhost:<port>` — absolute path (Local-Dependencies-Only); the port is re-read from `config.json` on every click. |
| Exit | Flips the supervisor's `stop` flag → SIGTERM to Node → graceful teardown → exit 0 → launcher exits → the thread's ksni handle drops and the icon disappears. Not the `/api/server/shutdown` POST: that is behind the per-instance token (see todo item 114). |
```

§21.3 Key Files: add rows `| `common/src/tray.rs` | Tray event loops: Win32 (Windows) and ksni (Linux) |` and `| `common/src/tray_policy.rs` | Shared labels, eligibility, session-bus detection, the ARGB icon |`.

- [ ] **Step 3: CHANGELOG**

Under `## [Unreleased]` add (create the `### Added` heading if absent):

```markdown
### Added

- **Linux system tray.** The launcher shows a StatusNotifierItem icon on desktops with a StatusNotifier
  host (KDE Plasma; GNOME with the AppIndicator extension): mode-aware tooltip, left-click / **Open
  ws-scrcpy-web**, and **Exit… → stop the server and quit**, which stops the server cleanly. Pure Rust
  (`ksni`), a thread inside the launcher for local and user-scope-service runs — nothing to supervise,
  no second binary in the AppImage. Where there is no host (stock GNOME, Fedora Workstation) it stands
  down silently with one line in `launcher.log`, and Settings → Server remains the exit path. System-scope
  services never show one. README's "Windows only" qualifiers are gone.

### Changed

- **A stop request on Linux sends Node SIGTERM before killing it.** Ctrl+C and the tray exit now run the
  same graceful teardown as the Settings button (adb kill-server, service release, SQLite backup);
  the supervisor kills only after 10 s.
- The dead Linux tray-autostart writer in `SystemdClient` is gone (no Linux tray binary will ever exist);
  uninstall still removes the `.desktop` file older installs wrote.
```

- [ ] **Step 4: Verify and commit**

Re-read each edited passage once; `grep -n "Windows only" README.md` must show no tray mention.

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add README.md docs/TECHNICAL_GUIDE.md CHANGELOG.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs: the Linux tray — README qualifiers reverted, TECHNICAL_GUIDE 20.2/21.4, CHANGELOG (item 63)"
```

---

### Task 9: Smoke rows 14.8 and 14.9 + the coverage register (user-acknowledged wording)

**Files:**
- Modify: `docs/smoke-tests/smoke-test.md` — TOC line 117 (Module 14) and the `#15 — Server-section UX (Linux)` table (append after row 14.7, line 303)
- Modify: `docs/smoke-tests/automation-coverage.md` — append after row 14.7 (line 181)

**Gate:** show the user the two rows below and get an explicit acknowledgement before committing (the qa-harness asserts this doc's wording).

- [ ] **Step 1: Smoke rows**

TOC line 117: append ` · [14.8](#t-14-8) · [14.9](#t-14-9)`.

After row 14.7:

```markdown
| ☐ <a id="t-14-8"></a> **14.8** `[Linux]` Tray icon — StatusNotifier host (KDE) | Kubuntu 26.04 (Plasma) desktop; local run, then a user-scope service run; look at the panel's system tray | Icon present in both runs; hover → `ws-scrcpy-web` (`ws-scrcpy-web (service)` for the service); left-click / **Open ws-scrcpy-web** opens the browser on the bound port; **Exit…** shows **stop the server and quit** (**stop the service and quit**) / **cancel** — cancel leaves everything running; the stop item ends the app cleanly (`ws-scrcpy-web.log`: `Received signal SIGTERM` then the adb teardown lines, exit 0, no restart) and the icon disappears. `busctl --user list \| grep StatusNotifierItem` shows the item while the app runs. |
| ☐ <a id="t-14-9"></a> **14.9** `[Fedora]` Tray stands down — no host (GNOME) | Fedora 44 Workstation (GNOME, no AppIndicator extension); same two runs | No icon anywhere; `launcher.log` carries exactly one `linux-tray: no StatusNotifier host on this desktop … standing down` line per run; Settings → Server → **stop the server and close the app** works as before; nothing else differs. A system-scope service on either desktop logs `linux-tray: not spawning (installMode="system-service"…)` and shows nothing. |
```

- [ ] **Step 2: Register rows**

After row 14.7 in `docs/smoke-tests/automation-coverage.md`:

```markdown
| 14.8 | `[Linux]` | Tray icon — StatusNotifier host (KDE) | residual: linux-desktop | Residual. Needs a Plasma session. qa-harness item 14's Linux guests can assert the `busctl --user list` name and the exit's `Received signal SIGTERM` log line under KDE. |
| 14.9 | `[Fedora]` | Tray stands down — no host (GNOME) | residual: linux-desktop | Residual. qa-harness item 14's Fedora guest can assert the single stand-down line in `launcher.log` and the absence of the D-Bus name. |
```

Then adjust the register's totals: the denominator grows by two (140 → 142); the automated numerator is unchanged, so restate the percentage from the new total wherever the file prints it (header line and the summary near line 433).

- [ ] **Step 3: Commit (after the user's acknowledgement)**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add docs/smoke-tests/smoke-test.md docs/smoke-tests/automation-coverage.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs(smoke): rows 14.8 (KDE tray) and 14.9 (GNOME stand-down) for the Linux tray (item 63)"
```

---

### Task 10: Final verification and the PR

- [ ] **Step 1: Everything green on this host**

```bash
cd "C:/Users/jscha/source/repos/ws-scrcpy-web" && npm run lint && npx tsc --noEmit && npm test && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo check --workspace --target x86_64-unknown-linux-gnu && cargo clippy --workspace --all-targets --target x86_64-unknown-linux-gnu -- -D warnings && cargo check --workspace --target x86_64-unknown-linux-musl && npm run build
```

Expected: every step exits 0.

- [ ] **Step 2: Audit the diff for the rules**

`git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" diff origin/main --stat` lists exactly the files in this plan's File Structure. `grep -rn "xdg-open" common/src launcher/src` shows only `/usr/bin/xdg-open`. `grep -rn "Windows only" README.md` shows no tray mention.

- [ ] **Step 3: Push and open the PR**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" push -u origin feat/linux-tray
gh pr create --repo bilbospocketses/ws-scrcpy-web --base main --head feat/linux-tray --label "release:beta" --title "feat(linux): system tray icon via ksni in the launcher; stands down without a StatusNotifier host (item 63)" --body-file <path to a body written with the Write tool>
gh pr merge --repo bilbospocketses/ws-scrcpy-web --squash --auto --delete-branch feat/linux-tray
```

The PR body: why (spec + three decisions), what (the ten tasks in one paragraph each), the SIGTERM change and item 114, the two smoke rows, verification output, and the qa-harness relay (new base on the beta this cuts; rows 14.8/14.9 for its Linux guests).

- [ ] **Step 4: After the beta is published**

Relay to the qa-harness session: the beta number, "re-pin the lock to it", rows 14.8 / 14.9 and what its KDE and Fedora guests can assert (`busctl --user list` name; `launcher.log` stand-down line; `Received signal SIGTERM` on exit).

---

## Self-review (done while writing)

- **Spec coverage:** §1 architecture → Tasks 3, 5; §2 components (labels, pixmap, two-step exit, xdg-open absolute, URL provider, eligibility fn, Cargo) → Tasks 1, 2, 3, 5; §3 lifecycle → Tasks 4, 5 (the spec's "POST /api/server/shutdown with stop-flag fallback" is replaced by SIGTERM-via-stop-flag — §8.3's verification found the POST is refused by the token gate (todo item 114), so the fallback became the path; the spec's contingency, made explicit here); §4 error handling → Tasks 3, 5; §5 testing → Tasks 1, 2, 4 (units), 9 (smoke), 10 (cross checks); §6 docs → Tasks 8, 9, and the autostart target → Task 7; §7 out of scope respected (no hicolor, no GNOME guidance, `openBrowser.ts` untouched); §8 verify items → 1 (Task 3 Step 3 behaviour of `spawn()`), 2 (Task 5 `ensure_session_bus_env` + row 14.8's service run), 3 (resolved: item 114), 4 (Task 2's pixel assertions + row 14.8).
- **Placeholders:** none; every code step carries its code; the ksni `Default`/`shutdown` uncertainties are named with their concrete fix.
- **Type consistency:** `should_spawn_tray(Option<&str>, bool)`, `session_bus_present(Option<&str>, bool)`, `TrayLabels::for_mode(bool)` with fields `tooltip/exit_title/exit_body/exit_action/balloon_title/balloon_body`, `icon_argb_22() -> Result<&'static [u8], String>`, `ICON_SIDE: i32`, `ICON_ARGB_LEN: usize`, `common::tray::run(&[u8], &str, &str, &str, Box<dyn Fn() -> String>, Option<(&str, &str)>) -> anyhow::Result<TrayAction>`, `linux_tray::spawn_if_eligible(&Path, Arc<AtomicBool>)`, `graceful_wait_exhausted(Duration) -> bool` — used identically in every task that names them.
