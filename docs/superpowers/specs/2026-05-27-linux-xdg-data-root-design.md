# Linux XDG Data Root

**Date:** 2026-05-27
**Status:** Approved
**Scope:** Fix Linux AppImage writable state by redirecting data_root from read-only squashfs mount to XDG_DATA_HOME

## Problem

The AppImage's type-2 runtime FUSE-mounts a read-only squashfs at runtime. On Linux, `data_root` collapses to `install_root`, which points inside that mount. All writable state (config, deps, logs, control markers) fails with EPERM. This breaks config saves, dependency downloads, log writes, and service install.

## Solution

Redirect `data_root` on Linux to `$XDG_DATA_HOME/WsScrcpyWeb` (defaults to `~/.local/share/WsScrcpyWeb` per the XDG Base Directory spec). Three layers compute the same path independently; the launcher passes `DATA_ROOT` env var to Node as a belt-and-suspenders bridge.

## Path Resolution

Both Rust and Node compute:

```
$XDG_DATA_HOME/WsScrcpyWeb    (if XDG_DATA_HOME is set and non-empty)
~/.local/share/WsScrcpyWeb    (default fallback per XDG spec)
```

Windows is unchanged: `%PROGRAMDATA%\WsScrcpyWeb`.

## Env Var Bridge

The Rust launcher passes `DATA_ROOT` to the Node child alongside the existing `DEPS_PATH`:

```rust
cmd.env("DEPS_PATH", deps_path)
    .env("DATA_ROOT", data_root);
```

Node priority chain in `resolveDataRoot()`:
1. `process.env.DATA_ROOT` (launcher bridge -- authoritative at runtime)
2. XDG computation (dev mode fallback)
3. Windows: `%PROGRAMDATA%\WsScrcpyWeb` (unchanged)

## Data Layout

```
~/.local/share/WsScrcpyWeb/
  config.json
  dependencies/
    node/
    adb/
    scrcpy-server/
  logs/
    server.log
    launcher.log
  control/
    .restart
    operation-server-port
    apply-update-pending
    uninstall-pending
```

Read-only in squashfs (unchanged): `dist/`, `seed/`, launcher binary, tray binary.

The `on_install` Velopack hook creates data_root and writes skeleton config.json. The Linux `grant_data_root_acl` stays a no-op -- XDG dirs are user-owned by default.

## Files Changed

| Layer | File | Change |
|-------|------|--------|
| Rust common | `common/src/config.rs` | Add `data_root_for_linux()` + update `data_root_from_env()` to return `Some` on Linux |
| Rust launcher | `launcher/src/paths.rs` | Call `data_root_for_linux()` instead of `install_root.clone()` on non-Windows |
| Rust launcher | `launcher/src/spawn.rs` | Pass `DATA_ROOT` env var to Node child (both `#[cfg]` variants) |
| Node server | `src/server/Config.ts` | `resolveDataRoot()` gains Linux branch: check `DATA_ROOT` env, then XDG fallback |
| Tests | `common/src/config.rs` | Tests for `data_root_for_linux()` with/without `XDG_DATA_HOME` |
| Tests | `launcher/src/paths.rs` | Update non-Windows test to assert XDG path instead of install_root collapse |
| Tests | `src/server/__tests__/` | Tests for `resolveDataRoot()` on Linux platform |

No new files. No new dependencies. No changes to AppImage build pipeline, systemd client, or service API -- they consume `data_root` and will automatically write to the correct location once it resolves to a writable path.

## Update Compatibility

Velopack replaces the AppImage file on disk. The running instance keeps its squashfs mount via the inode; next launch picks up the new file. Mutable state in `~/.local/share/WsScrcpyWeb/` survives updates -- same model as Windows with `%PROGRAMDATA%`.
