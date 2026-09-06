# Linux tray design (todo item 63)

**Date:** 2026-09-06 · **Status:** approved by the user (brainstorm, architectural path) · **Next:** implementation plan via `superpowers:writing-plans`

## Goal

A Linux system-tray icon that mirrors the Windows tray: the app's icon in the panel, a tooltip that
says which mode is running, a left-click / **Open** that opens the app in the browser, and an
**Exit** that stops the server cleanly — on the desktops the smoke covers (KDE Plasma on Kubuntu
26.04; Fedora 44 GNOME), with the README's four "Windows only" qualifiers gone.

## Binding decisions (user, 2026-09-06)

1. **No tray host (stock GNOME, Fedora Workstation): detect and stand down silently.** No notice,
   no extension requirement. Settings → Server → "stop the server and close the app" stays the
   documented stop path there.
2. **Lifecycle: a thread inside the launcher process, not a separate supervised binary.** On Linux
   the launcher already runs in the user's session for local and user-scope service runs, so the
   icon lives and dies with the instance and there is nothing to respawn. System scope has no
   session and never spawns it. The Windows split (`tray/` process + `tray_supervisor.rs`) exists
   only because that launcher runs as LocalSystem under Servy.
3. **Crate: `ksni` 0.3 with the `blocking` feature.** A pure-Rust StatusNotifierItem
   implementation over `zbus`: no C library, no tokio in the launcher. `tray-icon` (Tauri) was
   rejected — on Linux it pulls `libappindicator` + GTK, C libraries that would have to ship
   inside the AppImage under the Local-Dependencies-Only rule and that `common/src/tray.rs`
   already refused once for breaking `cross check` (P4b).

## 1. Architecture

The Linux tray is the missing half of `common::tray::run`, today a stub that returns
`TrayAction::Cancelled`. It becomes a real implementation behind `#[cfg(target_os = "linux")]`
with the same signature as the Windows half (`icon_bytes`, `tooltip`, `confirm_title`,
`confirm_body`, `open_url_provider`, `startup_balloon`), so callers stay platform-agnostic.

The launcher spawns it as **one thread** from `supervisor::run`, before the supervising loop, when
the instance is eligible: a local run, or a user-scope service run. System scope never spawns it.
No supervisor, no respawn, no second binary in the AppImage.

## 2. Components

- **`common/src/tray.rs`, Linux branch.** A `ksni::Tray` implementation:
  - `id` = `ws-scrcpy-web`; `title` / `tool_tip` = `ws-scrcpy-web` or `ws-scrcpy-web (service)`
    (the same mode-aware strings the Windows helper uses; mode from `config.json` `installMode`).
  - `icon_pixmap` from a committed raw ARGB32 asset (`assets/tray-icon-22.argb`, 22×22, network
    byte order per the SNI spec), generated once by a repo script from `assets/tray-icon.png`
    (ImageMagick `-resize 22x22 -depth 8 ARGB:`); a unit test pins `len == 22*22*4`. No PNG decoder
    enters the tree. Theme-name icons (hicolor) are out of scope.
  - `activate` (left click) opens the URL. Menu: **Open ws-scrcpy-web**, separator, **Exit…**.
  - **Exit confirmation.** Windows uses a native MessageBox; ksni has no dialog and `zenity` /
    `kdialog` are external binaries. **Exit…** is a submenu: **stop and quit** / **cancel**. Same
    two-step guarantee, no new dependency.
- **Open the browser** via `/usr/bin/xdg-open <url>` by absolute path, matching every OS tool the
  Linux launcher already calls (`/usr/bin/systemctl`, `/usr/bin/pkill`, …). Flagged, not fixed
  here: the Node side (`src/server/openBrowser.ts`) spawns bare `xdg-open` from PATH today.
- **URL provider** re-reads `config.json` on every click (existing pattern), so a port change or a
  mode swap mid-session is reflected without restarting the tray.
- **Eligibility** is a pure function `should_spawn_tray(install_mode, scope, session_bus_present)`
  so it is unit-testable; the thread spawn site in `supervisor.rs` is the only caller.
- **Cargo.** `common/Cargo.toml`: `[target.'cfg(target_os = "linux")'.dependencies] ksni = { version
  = "0.3", default-features = false, features = ["blocking"] }`. Nothing new on Windows.

## 3. Data flow and lifecycle

launcher starts → reads `installMode` + scope → eligible → spawns the tray thread → the thread
connects to the session bus and registers with `org.kde.StatusNotifierWatcher` → the icon shows.

**stop and quit** → POST `http://127.0.0.1:<port>/api/server/shutdown` exactly as the Windows
helper does (graceful: adb teardown, the "stopped" page, no restart requested); if the POST fails
(server already gone, port mismatch), fall back to the supervisor's stop flag (the Ctrl+C path).
→ node exits → supervisor exits → the thread's ksni handle drops → the icon disappears.

A node restart (web-port change → exit 75, update apply) leaves the thread and the icon in place;
the URL provider follows the new port.

`ureq` is already a workspace dependency (the Windows tray helper uses it); the launcher gains it
for the Linux target only.

## 4. Error handling

- **No session bus** (`DBUS_SESSION_BUS_ADDRESS` unset, system scope) or **no StatusNotifier
  host** (stock GNOME, Fedora Workstation): `run` logs one info line — "no tray host on this
  desktop; Settings → Server stops the app" — and returns `Cancelled`. The launcher treats that
  exactly as it treats today's stub. Nothing can block startup: the thread is fire-and-forget.
- **Host vanishes later** (extension disabled mid-session): same outcome; the thread ends.
- **POST fails on exit**: fall back to the stop flag; log both outcomes.
- **Asset malformed**: impossible at runtime (pinned by test), but `run` still returns an error
  rather than panicking if the pixmap is rejected by the host.

## 5. Testing

- **Unit (cross-platform, `cargo test`)**: `should_spawn_tray` truth table (local / user-service /
  system-service × bus present / absent); tooltip and menu model for both modes; ARGB asset length.
- **`cross check` stays green** — the reason for ksni; a CI leg already runs it.
- **Smoke rows, Module 14** (two new rows; wording to the user before they land):
  - Kubuntu 26.04 (KDE): icon present in the panel; tooltip names the mode; **Open** opens the
    browser on the bound port; **Exit… → stop and quit** ends the app cleanly (log shows the adb
    teardown, no restart); the icon is gone afterwards.
  - Fedora 44 (GNOME, no host): no icon; `launcher.log` carries the stand-down line; Settings →
    Server → stop works as before.
- **qa-harness** (its Linux guests, item 14): under KDE assert `busctl --user list` shows the
  `org.kde.StatusNotifierItem-<pid>-1` name while the app runs; under GNOME assert the stand-down
  log line.

## 6. Docs

- README: revert the four "Windows only" qualifiers (Features tag, "How the Launcher Works" item
  2, the "#### Tray icon" section, the Configuration "no tray there" note), describe the GNOME
  stand-down in one sentence.
- TECHNICAL_GUIDE tray section: the Linux half, eligibility, the stand-down, the two-step exit.
- The dead autostart `.desktop` `Exec` target: made real or removed in the same change (its own
  plan step).
- CHANGELOG under `## [Unreleased]`, `### Added`.

## 7. Out of scope

Icon theming through hicolor (pixmap avoids it), multi-seat, a Wayland-specific path (SNI is
D-Bus, display-agnostic), any GNOME extension guidance, and fixing `openBrowser.ts`'s bare
`xdg-open` (flagged separately).

## 8. Verify during implementation (not assumptions)

1. `ksni` 0.3 `blocking`: what `spawn`/`run` returns when no `org.kde.StatusNotifierWatcher` is on
   the bus — the stand-down must key on that result, not on a timeout.
2. The user-scope systemd unit sees `DBUS_SESSION_BUS_ADDRESS` (or `$XDG_RUNTIME_DIR/bus`); if the
   unit's environment strips it, the tray stands down in user-scope service mode and the smoke row
   must say so.
3. `POST /api/server/shutdown` with no token cookie is accepted from loopback (the Windows helper
   relies on it; confirm the Linux path hits the same exemption).
4. ImageMagick's raw `ARGB:` output byte order matches the SNI pixmap expectation on a real panel
   (KDE renders it; a swapped channel shows as a tinted icon).
