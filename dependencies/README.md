# `dependencies/` — Linux dev fallback only

Managed binaries (Node, ADB, scrcpy-server, node-pty) are always resolved to an
absolute path under a dependencies folder — never from `PATH`, never from a host
environment guess. Which folder depends on how the app was started:

| How it runs | Dependencies folder | Is *this* folder used? |
|-------------|--------------------|------------------------|
| Windows (dev or MSI install) | `%PROGRAMDATA%\WsScrcpyWeb\dependencies\` | no — vestigial |
| Linux, installed (AppImage / service) | `<dataRoot>/dependencies/`, where `dataRoot` is `$DATA_ROOT`, else `$XDG_DATA_HOME/WsScrcpyWeb`, else `~/.local/share/WsScrcpyWeb` — the launcher passes it down as `DEPS_PATH` | no |
| **Linux, dev tree** (`npm start`, `node dist/index.js`, no `DEPS_PATH`) | **this folder** | **yes** |

The Linux dev case is why the `.gitkeep`-pinned subdirs exist:
`Config.ts::resolveDependenciesPath` falls through to `<entryDir>/../dependencies`
when it finds a `package.json` beside it, which in a checkout resolves to exactly
here. On Windows the same function takes the data-root branch first, so these subdirs
are never touched.

Resolution order in `resolveDependenciesPath`, highest first: `DEPS_PATH` env →
`dependenciesPath` in `config.json` → the per-platform default above. The launcher's
[`paths.rs`](../launcher/src/paths.rs) `compute()` derives the same path on its side,
and `config.depsPath.test.ts` locks the two together.

> `data_root_for_linux` **panics** rather than falling back to `/tmp` when none of
> `DATA_ROOT` / `XDG_DATA_HOME` / `HOME` is set (review #36): a root-owned service
> silently writing to `/tmp` loses its data on every reboot. A system-scope systemd
> unit must set `Environment=DATA_ROOT`, which the service installer does.

Do not commit binary contents of the subdirs here — they are populated at runtime by
`DependencyManager.autoInstallMissing()`, which downloads and SHA256-verifies each
dependency on first launch.
