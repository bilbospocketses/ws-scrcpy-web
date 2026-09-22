# Local-Dependencies-Only Compliance Audit

**Date:** 2026-05-25
**Scope:** Full codebase (Rust launcher + Node server + frontend + scripts + CI)
**Result:** COMPLIANT — zero violations found

## Methodology

Exhaustive grep of every `spawn`, `execFile`, `execFileSync`, `execFileAsync`, `spawnSync`, and `Command::new` call across the entire repository. Each site classified as one of:

- **Local-deps compliant** — binary resolved from `<dependenciesPath>/` or the app's own install root
- **OS-utility carve-out** — system binary that cannot be vendored (part of the OS kernel/userland)
- **Build-only** — runs in CI/dev context only, never shipped in runtime package
- **Test-only** — runs in vitest context only

## Runtime Binaries (shipped in MSI/AppImage)

### Local-deps compliant (resolved from app's own folder)

| Binary | Resolution | Files |
|--------|-----------|-------|
| adb | `Config.resolveAdbPath()` → `<deps>/adb/adb.exe` | AdbClient.ts, AdbDaemonManager.ts, DependencyManager.ts, AdbUtils.ts |
| node | Launcher `spawn.rs::resolve_node_with` → `<deps>/node/node.exe` | spawn.rs |
| servy-cli | `<deps>/servy/servy-cli.exe` (fetched by fetch-servy.mjs) | elevatedRunner.ts (via launcher) |
| launcher (self) | `resolveLauncherPath()` → `<installRoot>/current/*.exe` | ServiceApi.ts, elevatedRunner.ts, active-session.ts, operation_server.rs, tray_supervisor.rs |
| mkcert | `resolveMkcertExe()` → `<deps>/mkcert/mkcert.exe` | createCertService.ts (binds `CertServiceDeps.run`), CertService.ts, DependencyManager.ts (`installMkcert`) |

> **mkcert, added 2026-09-19 with the Local HTTPS feature.** Compliant on the same terms as the rest:
> `resolveMkcertExe()` is `path.join(depsPath, 'mkcert', mkcertExeName())`, and it reuses
> `mkcertExeName()` from `DependencyDefinitions.ts` rather than re-deriving the filename — so the
> installer and the spawner cannot drift to different paths. Never resolved from `PATH`.
>
> Two ways it differs from the four above, both deliberate: it carries `deferInstall`, so it is
> fetched the first time a certificate is generated rather than at boot; and it is the only one whose
> download is verified before placement, against a SHA-256 pin held in this repo's own source
> (`MKCERT_SHA256SUMS_PIN`). The pin matters because mkcert mints a CA the user installs into their OS
> and phone trust stores — see `docs/TECHNICAL_GUIDE.md` §28.4.

### OS-utility carve-outs (cannot be vendored — they ARE the OS)

| Binary | Platform | Usage | Rationale |
|--------|----------|-------|-----------|
| `C:\Windows\System32\taskkill.exe` | Windows | Pre-update adb kill (UpdateService.ts) | Windows system process manager, present since XP |
| `sc.exe` | Windows | Service status query (ServyClient.ts) | Windows Service Control Manager CLI |
| `cmd.exe` | Windows | Browser open via `start` (openBrowser.ts) | Windows shell, best-effort UX nicety |
| `tar` | Linux | Archive extraction (DependencyManager.ts, NodePtyResolver.ts) | POSIX standard, present on every Linux distro; no single absolute path due to /usr-merge variance |
| `systemctl` | Linux | Systemd service management (SystemdClient.ts) | Linux service manager CLI |
| `loginctl` | Linux | Linger enable for user services (SystemdClient.ts) | Linux session manager CLI |
| `ip` | Linux | Route/interface detection (SubnetDetector.ts) | iproute2, standard on all modern Linux |
| `route` | Windows | Default gateway detection (SubnetDetector.ts) | Windows networking utility |
| `arp` | Win/Linux | MAC address resolution (MacResolver.ts) | OS networking utility |
| `xdg-open` | Linux | Browser open (openBrowser.ts) | freedesktop.org standard launcher |
| `open` | macOS | Browser open (openBrowser.ts) | macOS standard launcher (unreachable — no macOS builds) |
| `ldd` | Linux | glibc/musl detection (libcDetect.ts) | OS dynamic linker utility, graceful fallback on absence |

### Previously-fixed violations (historical, now resolved)

| Original finding | Fix | PR/Version |
|-----------------|-----|-----------|
| `powershell.exe Start-Process -Verb RunAs` via system PATH | Replaced with launcher's own `--request-uac` (ShellExecuteExW on self) | §30, pre-beta.39 |
| system-PATH adb resolution | Replaced with `resolveAdbPath()` → local `<deps>/adb/` | SP2/SP2b era |

## Build/CI Scripts (never shipped in runtime package)

| Binary | File | Note |
|--------|------|------|
| `C:\Windows\System32\tar.exe` | fetch-node.mjs, fetch-servy.mjs | Absolute path, with existence check |
| `C:\Windows\System32\taskkill.exe` | dev-supervisor.mjs | Absolute path |
| `tar` (bare) | fetch-prebuilts.mjs | Linux CI runner only |
| `ldd` | fetch-prebuilts.mjs | Linux CI glibc detection |
| `vpk` | package-linux.mjs | Installed by `dotnet tool install` in CI workflow |
| `npm`/`cmd.exe` | stage-publish.mjs | CI packaging step |
| `node` (bare) | vitest.globalSetup.ts | Test runner context (vitest invokes via the same node) |

## Consistency fixes applied in this audit

| File | Before | After |
|------|--------|-------|
| `UpdateService.ts:434` | `'taskkill'` (bare) | `'C:\\Windows\\System32\\taskkill.exe'` (absolute, matches dev-supervisor convention) |

## Conclusion

The codebase has zero Local-Dependencies-Only violations. All runtime binary dependencies resolve from the app's local `dependencies/` folder or the launcher's own install root. OS-utility invocations (service managers, networking tools, archive utilities, browser launchers) are documented carve-outs — they cannot be vendored and are guaranteed present on their target platforms.

The original sin (system-PATH adb) that motivated this audit was fixed long ago in the SP2/SP2b era. The PowerShell elevation path was eliminated in §30.
