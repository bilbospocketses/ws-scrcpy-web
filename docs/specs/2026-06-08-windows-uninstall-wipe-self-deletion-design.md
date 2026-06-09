# Windows in-app uninstall — wipe self-deletion fix

> **Status:** design approved (brainstorm 2026-06-08).
> **Target release:** `v0.1.30-beta.52` (fix-forward).
> **Branch:** `fix-windows-uninstall-wipe-self-deletion`.

## Problem

beta.51 shipped the first in-app Windows uninstall (Settings → App → uninstall). The Node
server (`ServiceApi.handleAppUninstall`, win32 branch, `src/server/api/ServiceApi.ts:1003`)
spawns a detached Rust helper — the **staged** launcher copy at
`%ProgramData%\WsScrcpyWeb\control\operation-server\ws-scrcpy-web-launcher.exe` (chosen
deliberately because the `Program Files\...\current\` launcher is deleted mid-uninstall,
ServiceApi.ts:1014-1018). The helper (`launcher/src/windows_app_uninstall.rs::run_uninstall`)
runs `Update.exe --uninstall`, then `remove_dir_all`s the dataRoot targets (`--wipe` = the
whole `%ProgramData%\WsScrcpyWeb`; `--keep` = `dependencies` / `bin` / `control`, preserving
`config.json` + `logs`).

On `--wipe` this leaves an **orphaned dataRoot** behind (and on `--keep`, an orphaned
`control\`) via **three** mechanisms:

1. **Running-exe lock.** The helper's own image lives at
   `…\control\operation-server\ws-scrcpy-web-launcher.exe`, *inside* the tree it deletes.
   Windows refuses to delete a running executable image, so `remove_dir_all` fails partway
   and the non-empty ancestors (`control\`, the root) survive.
2. **CWD lock.** The detached helper inherits the Node server's working directory (spawned
   with no `cwd`, ServiceApi.ts:127-131); if that path is under dataRoot, the directory is
   pinned open.
3. **Log-dir recreation.** `common/src/log.rs::append()` calls `create_dir_all(<dataRoot>/logs)`
   on *every* log line (log.rs:61). The helper's own post-delete log line (`"removed …"`,
   windows_app_uninstall.rs:179) **recreates** `<dataRoot>\logs\launcher.log`, resurrecting
   the tree even after an otherwise-clean delete.

The `--keep` path's `control\` orphan is benign (regenerated next run). The `--wipe` path is
the user-facing failure: "remove everything" leaves `%ProgramData%\WsScrcpyWeb` behind.
Confirmed from source, not merely suspected.

## Goal / success criteria

- A `--wipe` uninstall removes **all** of `%ProgramData%\WsScrcpyWeb`.
- A `--keep` uninstall removes `dependencies` / `bin` / `control` and preserves `config.json`
  + `logs`; a reinstall reuses the saved port.
- No leftover under dataRoot from the helper's own image, its CWD, or its logging.
- The only artifact left anywhere is the cleaner copy in the OS temp dir — acceptable (temp
  is self-managing).
- Pure logic stays unit-testable on any OS; the Windows-only runtime is confirmed by VM
  smoke 15.2.
- Orthogonal to VM-gated decisions #1 (Update.exe self-elevation) and #3 (Update.exe vs
  `msiexec /x` ARP cleanliness) — those are unaffected.

## Design — two-phase "temp-copy cleaner"

`ServiceApi.ts` is **unchanged**: it still spawns
`helper --windows-app-uninstall --keep|--wipe --data-root <dr> --update-exe <exe>`. The phase
split lives entirely inside the Rust helper, keeping the TS blast radius at zero.

### Phase 1 — bootstrapper (the originally-spawned helper; runs from `dataRoot\control\…`)

On `--windows-app-uninstall`:

1. Resolve the context-appropriate temp dir via **`GetTempPath2W`** — returns the user's temp
   under a user token and `C:\Windows\Temp` under a SYSTEM / system-service token (it is also
   the SYSTEM-hardened API). This *is* the "user vs system temp" split, with no explicit
   branching. Fall back to `GetTempPathW` if `GetTempPath2W` is unavailable (pre-Win10 1903).
2. **Copy** `current_exe()` into temp as `ws-scrcpy-web-uninstall-<pid>.exe` — a plain file
   copy (cross-volume-safe; no running-exe rename trick required).
3. Spawn the temp copy **detached** (no console window, survives parent exit) with **CWD set
   to temp**, passing:
   `--windows-app-uninstall-run --wait-pid <own-pid> --no-log --keep|--wipe --data-root <dr> --update-exe <exe>`.
4. Exit `0` immediately.

**Fallback:** if the copy or spawn fails, fall through to the legacy in-place best-effort path
(today's behavior) so the uninstall still proceeds — accepting the known orphan. No worse than
current.

### Phase 2 — cleaner (the temp copy; logging disabled; CWD in temp)

On `--windows-app-uninstall-run`:

1. `log::disable()` (driven by `--no-log`) — `append()` early-returns; the process never
   touches dataRoot for logging.
2. **Wait for the bootstrapper to exit:** `OpenProcess(SYNCHRONIZE, <wait-pid>)` +
   `WaitForSingleObject(handle, 30s)`. If the handle cannot be opened (already exited),
   proceed immediately. The step-4 delete-retry is the *actual* guarantee that the lock has
   cleared; `--wait-pid` is only a best-effort fast-path, so a 30 s timeout or a PID-reuse
   mismatch is non-fatal.
3. Run `Update.exe --uninstall` (absolute path passed in; Velopack → Program Files removal +
   ARP cleanup + the `--veloapp-uninstall` service/tray hook). Best-effort; continue on
   failure.
4. Remove each dataRoot target (same list as today: wipe = whole root; keep =
   deps/bin/control), each wrapped in a **bounded retry** (≤10 attempts × 500 ms) to absorb
   any residual handle-release lag. Best-effort.
5. Exit `0`. The copy remains in temp — no self-cleanup (temp is self-managing).

### Why every leftover mechanism closes

| Mechanism | Closed by |
|---|---|
| Running-exe lock | Deleter runs from temp; waits for the bootstrapper (whose image was in dataRoot) to exit; delete-retry absorbs lag. |
| CWD lock | Cleaner's CWD is temp, not dataRoot. |
| Log-dir recreation | Cleaner is silent (`log::disable()`); never calls `create_dir_all(<dataRoot>/logs)`. |

## Components & files

- **`launcher/src/windows_app_uninstall.rs`** — split `run_uninstall` into:
  - Phase 1 bootstrapper: temp-dir resolve, self-copy, detached spawn, legacy fallback.
  - Phase 2 cleaner: wait-pid, Update.exe, retry-delete.
  Add arg parsing for `--windows-app-uninstall-run`, `--wait-pid <pid>`, `--no-log`. Keep the
  existing pure builders (`windows_app_uninstall_commands`, the keep/wipe target lists) and
  their tests intact.
- **`common/src/log.rs`** — add `disable()` backed by an `AtomicBool` (or `OnceLock<bool>`)
  gate checked at the top of `append()`.
- **`launcher/src/main.rs`** — dispatch `--windows-app-uninstall-run` to the Phase 2 handler.
- Win32 via the existing `windows` crate (already a launcher dep, Cargo.toml:21): `GetTempPath2W`
  / `GetTempPathW`, `OpenProcess`, `WaitForSingleObject`, `CloseHandle` — same `unsafe` + `to_wide`
  idiom as `install_acl.rs` / `single_instance.rs` / `user_session_spawn.rs`.

## Error handling

- Phase 1 copy/spawn failure → legacy in-place best-effort (uninstall proceeds; known orphan;
  no worse than today).
- Phase 2 wait timeout (30 s) → proceed to Update.exe + retry-delete anyway (best-effort).
- Update.exe non-zero / spawn failure → continue to dataRoot delete (the app is being removed
  regardless).
- `remove_dir_all` failure after retries → best-effort; leave what couldn't be removed
  (matches today's contract).
- All silent (`--no-log`) — observability is the VM smoke. **Decision:** fully silent per user
  directive; trivially flippable to a temp-resident log (beside the copy, never in dataRoot)
  if teardown diagnostics are ever wanted.

## Testing

- **Unit (any OS):** keep/wipe target-list builders (existing); arg round-trip for the new
  flags; `log::append()` early-returns when disabled; temp-copy filename + param-vector
  construction (pure helper). The Win32 copy/spawn/wait/delete sits behind `#[cfg(windows)]`,
  validated via `cross` compile + `clippy -D warnings`, runtime-confirmed in smoke.
- **Runtime (VM):** smoke **15.2** (wipe leaves nothing under `%ProgramData%\WsScrcpyWeb`),
  **15.1** (keep preserves config + logs, removes deps), **15.4** (stop-exit reap — unaffected,
  same module).

## Release sequencing & companion doc fixes

- Ships as **`v0.1.30-beta.52`** (fix-forward), cut via `npm run version:bump` + auto-release
  Mode 1 (one `release:beta` PR; no manual bump — see `reference_wsscrcpy_version_bump`).
- **Doc fix #1 (smoke-target tag):** bump the `> Smoke target:` line in `smoke-checklist.md`
  + `smoke-full.md` to **`v0.1.30-beta.52`** (the fixed build we will actually smoke) — **not**
  beta.51. Lands with the release.
- **Doc fix #2 (checklist Windows batch):** add the Windows in-app-uninstall batch to
  `smoke-checklist.md`, mirroring `smoke-full.md` Module 15 (15.1 keep / 15.2 wipe / 15.3 modal
  UX / 15.4 stop-exit reap / 15.5 app-section order). Version-agnostic; rides the beta.52 tag.

## Out of scope

- VM decisions **#1** (does `Update.exe --uninstall` self-elevate from the unelevated caller)
  and **#3** (`Update.exe --uninstall` vs `msiexec /x {ProductCode}` for clean ARP removal) —
  both require VM observation; unaffected by this fix.
- Linux uninstall paths (`linux_app_uninstall.rs`) — unaffected.
