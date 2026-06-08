# App-section redesign + in-app Windows uninstall — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorder Settings → App, move the uninstall confirm to an overlay modal, add an in-app Windows uninstall (parity with Linux), and fix the Windows tray reap on "stop server & exit".

**Architecture:** Frontend (TS, `SettingsModal.ts` + a new modal) is one layer; backend (`ServiceApi.ts` win32 branch + a new Rust `windows_app_uninstall.rs` helper) is the other; the tray-reap fix is launcher-only. The contract between them is unchanged: the uninstall button POSTs `/api/service/uninstall-app { keep }` on both OSes; the server branches by platform. Mirror the existing Linux uninstall throughout (`linux_app_uninstall.rs`, `handleAppUninstall`).

**Tech Stack:** TypeScript (vitest, jsdom), Rust (launcher; `cargo`/`cross`), no new deps.

**Spec:** `docs/specs/2026-06-08-app-section-redesign-windows-uninstall-design.md`.

**Parallelization:** Phases A/B (frontend) and C (backend) are independent after this plan; D (tray-reap) is independent of all. Good `/build-with-agent-team` split: one agent on A+B, one on C, one on D.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/app/client/SettingsModal.ts` | App-section assembly + pure state helper + `buildUninstallControl` | modify: reorder appends; `appSectionButtonsState.showUninstall` → both OS; rewire uninstall button to open the modal |
| `src/app/client/UninstallConfirmModal.ts` | the overlay uninstall modal (checkbox + cancel/uninstall) | **create** |
| `src/app/client/__tests__/UninstallConfirmModal.test.ts` | modal unit tests | **create** |
| `src/app/client/__tests__/SettingsModal.test.ts` | state + ordering + rewire tests | modify |
| `src/style/modal.css` | red-outline "uninstall" button style | modify |
| `src/server/api/ServiceApi.ts` | `handleAppUninstall` win32 branch | modify (~L980–1060) |
| `src/server/__tests__/ServiceApi.test.ts` | win32-pinned branch test | modify |
| `launcher/src/windows_app_uninstall.rs` | pure command builder + parse_args + dispatch + run | **create** |
| `launcher/src/main.rs` | dispatch `--windows-app-uninstall` | modify (cfg(windows) flag dispatch) |
| `launcher/src/lib.rs` (or `main.rs` mod block) | declare `mod windows_app_uninstall` (cfg windows) | modify |
| `launcher/src/tray_supervisor.rs` + `supervisor.rs` + `main.rs` | stop the poll thread before the reap | modify |
| `docs/smoke-tests/smoke-full.md` + `smoke-checklist.md` | Windows uninstall + tray-reap rows | modify |

---

## Phase A — Frontend: reorder + uninstall-on-both-OS

### Task A1: `appSectionButtonsState` reveals uninstall on Windows too

**Files:** Modify `src/app/client/SettingsModal.ts:172-189`; Test `src/app/client/__tests__/SettingsModal.test.ts`.

- [ ] **Step 1 — failing test.** In `SettingsModal.test.ts`, in the `appSectionButtonsState` describe block, add:

```ts
it('shows uninstall on win32 (parity with linux), hides install-all-users', () => {
    const s = appSectionButtonsState({ platform: 'win32', machineWideInstalled: false });
    expect(s.showUninstall).toBe(true);          // NEW: win32 gets the uninstall row
    expect(s.showInstallAllUsers).toBe(false);   // install-all-users stays linux-only
});
it('shows both rows on linux', () => {
    const s = appSectionButtonsState({ platform: 'linux', machineWideInstalled: false });
    expect(s.showUninstall).toBe(true);
    expect(s.showInstallAllUsers).toBe(true);
});
```

- [ ] **Step 2 — run, expect FAIL** (`showUninstall` is `false` on win32 today). `npx vitest run src/app/client/__tests__/SettingsModal.test.ts -t appSectionButtonsState`
- [ ] **Step 3 — implement.** In `appSectionButtonsState`, compute `const showUninstall = linux || resp.platform === 'win32';` and return `showUninstall` (replace the `showUninstall: linux`). Update the doc-comment ("two Linux-only rows" → "install-all-users is Linux-only; uninstall shows on Linux + Windows").
- [ ] **Step 4 — run, expect PASS.** Same command.
- [ ] **Step 5 — commit.** `git add -A && git commit -m "feat(client): reveal App-section uninstall row on Windows"`

### Task A2: Reorder the App-section rows

**Files:** Modify `src/app/client/SettingsModal.ts:buildAppSection` (~1595-1702).

- [ ] **Step 1 — reorder the appends.** The desired DOM order (top→bottom) is: reset → install-all-users (Linux) → stop-server → uninstall. Move the `body.appendChild(...)` calls into that order. Keep each control's construction; only the append sequence changes. Specifically: build `reset` (+ its inline confirm panel) first and append; then `install` row + note; then `stop` row + note; then `uninstall` row. The reset confirm panel stays inline (only the *uninstall* confirm becomes a modal — Phase B). Result, in append order:
  1. reset row, reset confirm panel
  2. install-all-users row + note (hidden until Linux)
  3. stop-server row, stop note
  4. uninstall row (hidden until A1 reveals it)
- [ ] **Step 2 — verify ordering test.** Add a test asserting the rendered App-section row labels appear in order. In `SettingsModal.test.ts`, render the section (the test file already constructs a `SettingsModal`; follow its existing pattern for building the App section), collect `.settings-row` label texts, and assert `['reset welcome and bookmark prompts', 'install for all users', 'stop the server and close the app', 'uninstall ws-scrcpy-web']` is a subsequence. Run it; expect PASS after Step 1 (write the test first if the existing harness supports it — if rendering the full section in jsdom is heavy, assert order by reading `body.children` label cells).
- [ ] **Step 3 — run vitest** for the file; expect PASS.
- [ ] **Step 4 — commit.** `git commit -am "feat(client): reorder App-section (reset, install, stop, uninstall)"`

---

## Phase B — Frontend: uninstall confirm modal

### Task B1: `UninstallConfirmModal` (top-layer dialog + checkbox + cancel/uninstall)

**Files:** Create `src/app/client/UninstallConfirmModal.ts`; Create `src/app/client/__tests__/UninstallConfirmModal.test.ts`. **Pattern to mirror:** `src/app/client/ConfirmModal.ts` (static `confirm(): Promise<...>`, extends `Modal`, `showModal()` top layer) and `AdminConfirmModal.ts`. **Test pattern:** `src/app/client/__tests__/AdminConfirmModal.test.ts` (stubs `HTMLDialogElement.showModal`).

Contract:
```ts
// Resolves on cancel → { confirmed: false }; on uninstall → { confirmed: true, keep: <checkbox> }.
UninstallConfirmModal.confirm(): Promise<{ confirmed: boolean; keep: boolean }>
```

- [ ] **Step 1 — failing tests** (`UninstallConfirmModal.test.ts`), mirroring `AdminConfirmModal.test.ts`'s `showModal` stub:

```ts
it('defaults keep checkbox to checked', async () => {
    const p = UninstallConfirmModal.confirm();
    const box = document.querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(box.checked).toBe(true);                  // SAFETY DEFAULT
    (document.querySelector('.uninstall-cancel') as HTMLButtonElement).click();
    expect(await p).toEqual({ confirmed: false, keep: true });
});
it('resolves confirmed + keep=false when unchecked then uninstall clicked', async () => {
    const p = UninstallConfirmModal.confirm();
    (document.querySelector('input[type=checkbox]') as HTMLInputElement).checked = false;
    (document.querySelector('.uninstall-confirm') as HTMLButtonElement).click();
    expect(await p).toEqual({ confirmed: true, keep: false });
});
it('renders the body copy and red uninstall button', () => {
    void UninstallConfirmModal.confirm();
    expect(document.body.textContent).toContain('this removes the app, its dependencies, and any installed service.');
    expect(document.querySelector('.uninstall-confirm')?.className).toContain('settings-btn-danger-outline');
});
```

- [ ] **Step 2 — run, expect FAIL** (module missing). `npx vitest run src/app/client/__tests__/UninstallConfirmModal.test.ts`
- [ ] **Step 3 — implement** `UninstallConfirmModal.ts`: a `Modal` subclass building title `uninstall ws-scrcpy-web`, body `<p>this removes the app, its dependencies, and any installed service.</p>`, a `<label>` with a checked-by-default `<input type=checkbox>` + text `keep my settings & logs`, and two buttons: `cancel` (class `settings-btn uninstall-cancel`) and `uninstall` (class `settings-btn settings-btn-danger-outline uninstall-confirm`). `confirm()` opens via `showModal()`, wires cancel→resolve `{confirmed:false, keep:<box>}`, uninstall→resolve `{confirmed:true, keep:<box>}`, closes the dialog on either.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit.** `git commit -am "feat(client): UninstallConfirmModal (keep-checked default, red uninstall button)"`

### Task B2: red-outline button CSS

**Files:** Modify `src/style/modal.css`.

- [ ] **Step 1 — add the style.** Mirror the existing `settings-btn` / white-outline rule; add `.settings-btn-danger-outline { color: <red token>; border-color: <red token>; background: transparent; }` using the project's red token (grep `#f06c75` / the disconnect-red used elsewhere — the disconnect button color from the project conventions). Cancel reuses the plain `settings-btn` (white outline).
- [ ] **Step 2 — verify** the class name matches B1's test (`settings-btn-danger-outline`). No unit test for CSS; visual check happens in the smoke. Commit. `git commit -am "style: red-outline danger button for uninstall modal"`

### Task B3: rewire `buildUninstallControl` to the modal

**Files:** Modify `src/app/client/SettingsModal.ts` (`buildUninstallControl` ~L325 + its use in `buildAppSection` ~L1692-1699). Test: `SettingsModal.test.ts`.

- [ ] **Step 1 — failing test.** Replace/extend the existing `buildUninstallControl` test: clicking the uninstall button calls `UninstallConfirmModal.confirm` (mock it), and on `{confirmed:true, keep}` it POSTs `/api/service/uninstall-app` with `{ keep }` (mock `fetch`), then calls `onUninstalled`. On `{confirmed:false}` it does nothing.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** Change `buildUninstallControl` to return `{ button }` only (drop `confirmPanel`/`keepCheckbox`/`confirmButton`/`cancelButton`). The button's click handler: `const r = await UninstallConfirmModal.confirm(); if (!r.confirmed) return; button.disabled = true; button.textContent = 'uninstalling…'; await fetch('/api/service/uninstall-app', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ keep: r.keep }) }); opts.onUninstalled();`. In `buildAppSection`, remove the `confirmPanel` append (L1699) and the `uninstallConfirmPanel` field usage; update `applyAppSectionButtonsState` (L1740-1752) to drop the confirm-panel-collapse branch (no panel anymore).
- [ ] **Step 4 — run vitest (full client suite), expect PASS;** fix any references to the removed `uninstallConfirmPanel`/`keepCheckbox` fields (grep them).
- [ ] **Step 5 — commit.** `git commit -am "feat(client): uninstall confirm via overlay modal (drop inline panel)"`

---

## Phase C — Backend: in-app Windows uninstall

### Task C1: `windows_app_uninstall.rs` — pure builder + dispatch

**Files:** Create `launcher/src/windows_app_uninstall.rs`; Modify `launcher/src/main.rs` (declare `#[cfg(windows)] mod windows_app_uninstall;` near the other mods, and dispatch the flag before normal launch). **Pattern to mirror:** `launcher/src/linux_app_uninstall.rs` (pure builder + `parse_args` + `handle` dispatch + best-effort exec + extensive unit tests).

Pure builder contract:
```rust
/// Ordered steps for a complete Windows uninstall. `update_exe` = <installRoot>\Update.exe;
/// `data_root` = %ProgramData%\WsScrcpyWeb. Step 1 ALWAYS: Velopack uninstaller.
/// Then dataRoot keep/wipe — deps always removed; config.json + logs kept iff `keep`.
pub fn windows_app_uninstall_commands(update_exe: &str, data_root: &str, keep: bool) -> Vec<Vec<String>>
```

- [ ] **Step 1 — failing tests** (in `windows_app_uninstall.rs`, mirror `linux_app_uninstall.rs` test style — string-join argv for order-preserving asserts):

```rust
#[test]
fn wipe_removes_whole_data_root_after_update_uninstall() {
    let c = windows_app_uninstall_commands(r"C:\PF\WsScrcpyWeb\Update.exe", r"C:\PD\WsScrcpyWeb", false);
    assert_eq!(c[0], vec![r"C:\PF\WsScrcpyWeb\Update.exe".to_string(), "--uninstall".to_string()]); // primary
    // wipe: a single rmdir/remove of the whole data root.
    assert!(c.iter().any(|v| v.join(" ").contains(r"C:\PD\WsScrcpyWeb") && !v.join(" ").contains("dependencies")));
}
#[test]
fn keep_removes_deps_only_preserves_config_logs() {
    let c = windows_app_uninstall_commands(r"C:\PF\WsScrcpyWeb\Update.exe", r"C:\PD\WsScrcpyWeb", true);
    assert_eq!(c[0][1], "--uninstall");
    let joined: Vec<String> = c.iter().map(|v| v.join(" ")).collect();
    assert!(joined.iter().any(|s| s.contains(r"WsScrcpyWeb\dependencies")));   // deps gone
    assert!(!joined.iter().any(|s| s.contains("config.json")));                 // never named (preserved)
    // never a bare wipe of the whole root on keep.
    assert!(!joined.iter().any(|s| s.ends_with(r"\WsScrcpyWeb")));
}
```
Plus `parse_args` tests mirroring `linux_app_uninstall.rs::parse_args_*`: `--windows-app-uninstall --keep|--wipe --data-root <p> --update-exe <p>`; exactly one of keep/wipe; required data-root + update-exe.

- [ ] **Step 2 — run, expect FAIL** (module/fn missing). `cargo test -p ws-scrcpy-web-launcher windows_app_uninstall` (Windows host runs the cfg(windows) module).
- [ ] **Step 3 — implement** the pure builder + `parse_args` + a `handle(args) -> Option<i32>` dispatcher + a best-effort executor. For the dataRoot removal use a deletion command resolvable without PATH per Local-Dependencies-Only (prefer Rust `std::fs::remove_dir_all` in the executor over shelling to `cmd /c rmdir`; the *pure builder* can model steps as either fs-op descriptors or argv — keep the builder returning argv for `Update.exe`, and have the executor do `std::fs::remove_dir_all` for the data-root steps; OR model both as argv and resolve the system `cmd.exe` via `%SystemRoot%\System32\cmd.exe` absolute path, never bare `cmd`). Decide in implementation; the unit test asserts the *Update.exe* argv + the data-root *targets*, not the deletion mechanism.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — wire dispatch** in `main.rs`: `#[cfg(windows)] mod windows_app_uninstall;` and, in the early flag-dispatch region (where other `--…` flags are handled), `#[cfg(windows)] if let Some(code) = windows_app_uninstall::handle(&args) { std::process::exit(code); }`. Build: `cargo build -p ws-scrcpy-web-launcher`. Commit. `git commit -am "feat(launcher): windows_app_uninstall helper (Update.exe --uninstall + dataRoot keep/wipe)"`

### Task C2: `ServiceApi.handleAppUninstall` win32 branch

**Files:** Modify `src/server/api/ServiceApi.ts` (`handleAppUninstall` ~L980-1060). Test: `src/server/__tests__/ServiceApi.test.ts`. **Pattern to mirror:** the Linux branch in the same method (resolve `keep`, spawn the detached helper, 200 `{ ok, status:'uninstalling' }`, `scheduleExit`).

- [ ] **Step 1 — failing test** (win32-pinned, per the cross-platform-test discipline — inject `platform:'win32'` into the factory). Assert: POST with `{ keep:false }` spawns the elevated helper with `--windows-app-uninstall --wipe --data-root <pd> --update-exe <installRoot>\Update.exe`, responds 200 `{ ok:true, status:'uninstalling' }`, and schedules exit. (Mock the detached-spawn + elevation seam the same way the Linux test mocks `spawnDetached`.)
- [ ] **Step 2 — run, expect FAIL** (today win32 returns `{ ok:false, reason:'unsupported' }`).
- [ ] **Step 3 — implement** the win32 branch: read `keep`; resolve `installRoot` (→ `Update.exe`) + `dataRoot` (ProgramData); build the helper argv (`--windows-app-uninstall` + keep/wipe + `--data-root` + `--update-exe`); spawn it **elevated + detached** via the existing elevated-runner / `ShellExecuteEx "runas"` seam (mirror `install-system-wide` / service uninstall elevation); write 200 `{ ok:true, status:'uninstalling' }`; `scheduleExit`. Keep the Linux branch unchanged; the `unsupported` fallback now only covers non-win32/non-linux.
- [ ] **Step 4 — run vitest (server suite), expect PASS** (both the new win32 test and the existing linux test).
- [ ] **Step 5 — commit.** `git commit -am "feat(server): in-app Windows uninstall (ServiceApi win32 branch)"`

---

## Phase D — Tray reap on stop-exit (item 4)

### Task D1: stop the tray-supervisor poll thread before the reap

**Files:** Modify `launcher/src/supervisor.rs` (L117 `let _stop = start_background(...)` — capture + return/expose the `stop_flag`), `launcher/src/tray_supervisor.rs`, `launcher/src/main.rs` (set the flag before `reap_tray_on_terminal_exit`).

- [ ] **Step 1 — failing/define test.** Add a pure ordering guard. The reap decision is already `should_reap_tray_on_exit` (tested). Add a small pure helper if the fix introduces a decision (e.g. none needed if it's pure wiring). If wiring-only, this task has no new unit test — its proof is the VM (Step 4 of Phase E). Record that explicitly here rather than inventing a hollow test.
- [ ] **Step 2 — implement.** Thread the `Arc<AtomicBool>` `stop_flag` from `tray_supervisor::start_background` up out of `supervisor::run` (return it alongside the exit code, or store it where `main` can reach it), and in `main.rs` **before** the `reap_tray_on_terminal_exit` call, `stop_flag.store(true, Ordering::SeqCst)` so the poll loop (which checks the flag at the top of each iteration) cannot respawn the tray the reap just killed. Keep the marker gating intact.
- [ ] **Step 3 — build + existing tests.** `cargo test -p ws-scrcpy-web-launcher tray_supervisor` (the `should_reap_tray_on_exit` tests still pass).
- [ ] **Step 4 — commit.** `git commit -am "fix(launcher): stop tray-supervisor poll before reaping tray on exit"`

### Task D1b: stop-exit must reap stray adb on Windows (mirror the update path)

**Files:** Modify `src/server/index.ts` (`gracefulShutdown` ~L283-291). Test: extend `src/server/__tests__/ServerShutdownApi.test.ts` or add a `gracefulShutdown` test. **Pattern to mirror:** `UpdateService.ts:689-697` preApply hygiene (the exact taskkill it already uses).

- [ ] **Step 1 — failing test** (win32-pinned): after the cleanup runs on win32, `execFileAsync` was called with `C:\Windows\System32\taskkill.exe ['/F','/IM','adb.exe','/T']`. Mock `execFileAsync`; pin `process.platform` to `win32`.
- [ ] **Step 2 — run, expect FAIL** (gracefulShutdown does `kill-server` only today). `npx vitest run -t "stop-exit reaps stray adb"`
- [ ] **Step 3 — implement.** In `gracefulShutdown`, after the `scanAdb.killServer()` try/catch, add:

```ts
if (process.platform === 'win32') {
    serverLog.info('Stopping stray adb (taskkill) ...');
    try {
        await execFileAsync('C:\\Windows\\System32\\taskkill.exe', ['/F', '/IM', 'adb.exe', '/T'], { timeout: 5000 });
    } catch {
        // non-zero = no matching adb process = success (mirror UpdateService preApply)
    }
}
```
Import `execFileAsync` if not already in `index.ts` (it's used via the adb managers; import the same `promisify(execFile)` helper the codebase uses).

- [ ] **Step 4 — run vitest, expect PASS** (win32 test passes; the non-win32 path is unchanged — assert it does NOT taskkill on linux).
- [ ] **Step 5 — commit.** `git commit -am "fix(server): reap stray adb on Windows stop-exit (taskkill belt-and-braces)"`

### Task D2: VM diagnosis (gated — done during Phase E smoke)

- [ ] On the Win11 VM, stop-exit then read `…\WsScrcpyWeb\logs\launcher.log`: is `tray-supervisor: terminal exit; reaping tray helper` present? a `leaving tray for relaunch` (marker) line? Does `ws-scrcpy-web-tray.exe` die? If D1 alone doesn't fix it, apply the diagnosed fix (stale-marker cleanup, or taskkill targeting). Record the finding in the smoke doc.

---

## Phase E — Integration, smoke, ship

### Task E1: smoke rows
- [ ] Add to `docs/smoke-tests/smoke-full.md` (Module 14) + `smoke-checklist.md` (batch #15): Windows install-via-MSI → in-app **uninstall** (keep checked → config/logs survive, deps gone, ARP entry gone, one UAC; unchecked → whole dataRoot gone); and a `[W]` **stop-exit reaps tray** row (Task 12.3 already exists — note it's now expected to pass). Version-agnostic phrasing per the existing docs. Commit.

### Task E2: build + PR + beta + VM
- [ ] Full local verify: `npx tsc --noEmit`, `npx vitest run`, `cargo test -p ws-scrcpy-web-launcher -p ws-scrcpy-web-common`, `cargo clippy --all-targets -- -D warnings`.
- [ ] CHANGELOG `[Unreleased]` entries (Added: in-app Windows uninstall; Changed: App-section order + uninstall modal; Fixed: tray reap on stop-exit).
- [ ] PR (`release:beta`) → CI green → squash-merge → bump bot cuts **beta.51**.
- [ ] **Win11 VM smoke** (the real gate): the Update.exe-vs-msiexec decision (§8) and the tray-reap diagnosis (D2). Fix-forward as needed.

---

## Self-Review

**Spec coverage:** §1 order → A2; §2 modal → B1/B2/B3; §3 Windows uninstall → C1/C2; §4 keep/wipe → C1 (builder) + B1 (checkbox); §5 testable units → A1/B1/C1/C2 tests; §6 verify → E2; §9 tray-reap → D1/D2. All sections mapped.

**Placeholder scan:** the only deferred specifics are the **VM-gated** runtime decisions (Update.exe-vs-msiexec in C/E2; the tray-reap root cause in D2) — these are genuinely VM-dependent and explicitly flagged, not lazy TODOs. The data-root deletion mechanism in C1 is left to implementation with the constraint stated (Local-Dependencies-Only: Rust fs-op or absolute `cmd.exe`), and the unit test asserts targets not mechanism — acceptable.

**Type consistency:** `UninstallConfirmModal.confirm(): Promise<{confirmed, keep}>` used identically in B1 + B3. `windows_app_uninstall_commands(update_exe, data_root, keep)` + the `--windows-app-uninstall --keep|--wipe --data-root --update-exe` flag set are consistent across C1 + C2. `appSectionButtonsState.showUninstall` used in A1 + A2 + B3.
