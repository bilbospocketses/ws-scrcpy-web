# Linux system-service install redesign — `sudo` CLI + awaited-`pkexec`, one shared root core

**Date:** 2026-06-12
**Status:** Approved (design) — pending implementation plan
**Branch:** `feat/system-service-install-redesign`
**Supersedes:** the in-app `pkexec sh -c "<script>"` system-service install (`buildSystemInstallScript` + `runPkexec` with a kill-on-timeout) that failed runtime smoke five times (beta.53 → 57 → 58 → 61 → 64).

---

## 1. Problem

The Linux **system-scope** (root) service install has failed the Fedora/SELinux runtime smoke five consecutive times, each with a *new* failure mode at the same seam:

| Beta | Fix attempted | Next failure |
|---|---|---|
| 53 | stop self-`cp` of the `/opt` binary | post-install port-discovery race |
| 57 | port hand-off / `WS_SCRCPY_SERVICE` | fcontext `&&`-cascade short-circuit |
| 58 | `-a \|\| -m` idempotent fcontext | cascade *still* short-circuited |
| 61 | independent `;` fcontext + teardown env | `/var/opt` SELinux equivalency |
| 64 | system state `/var/opt` → `/var/lib` | **`kill EPERM`** |

Deep research (2026-06-12, freedesktop/polkit · `kill(2)` · Fedora/Debian packaging · Tailscale/Docker/Syncthing) established that this is **a wrong architecture, not a sequence of bugs**:

- **`kill EPERM` is a hard kernel guarantee.** Per `kill(2)`, an unprivileged parent can only signal a process whose real/effective UID equals the target's real or saved set-user-ID (or with `CAP_KILL`). A `pkexec` child is setuid-root (saved set-UID 0), so the parent **always** gets `EPERM`. `runPkexec`'s `execFileAsync('pkexec', …, { timeout: 60_000 })` calls `child.kill()` when the timeout fires → `EPERM`. **The supervise-and-kill-a-setuid-child model is unsupportable by construction.** (Reproduced: Node `#37736`/`#2549`, Deno `#19112`.)
- **The blessed pattern is to not signal a privileged child at all** — either the privileged work runs to completion and the caller awaits its exit, or a long-lived privileged *mechanism* owns its own lifecycle/cancellation.
- See `master_linux_platform` §6 (the captured lesson) and `master_verification_trust` (CI asserted the generated *script string*, never runtime `semanage` success — which is why four betas shipped green-but-broken).

## 2. Purpose & scope

**The system-scope service exists for one reason the working user-scope (`systemctl --user`) service cannot serve:** running **headless, at boot, before any user logs in**, reachable from another device. A `--user` unit only starts after login; a root system service does not need a session. (User confirmation, 2026-06-12.)

**Two install front-ends are in scope** (user confirmation, 2026-06-12):

- **Headless / CLI** — an admin at a root shell on the box (`sudo`/SSH).
- **Desktop GUI** — a one-click install from the web UI on a machine that has a desktop session.

**Non-goals:** a long-lived D-Bus/polkit *mechanism* daemon (considered and rejected as more standing root surface than an occasional one-shot install warrants — the awaited-`pkexec` path removes the actual failure cause without it). No change to the **user-scope** service, which works and is out of scope.

## 3. Goals / non-goals

**Goals**
1. A system-service install that passes Fedora-SELinux-enforcing **and** Ubuntu runtime smoke.
2. **No `kill()` of any privileged child, ever** — the `EPERM` class is removed by construction.
3. The privileged work is **real, testable code run as root**, not a generated `pkexec sh -c "<string>"`.
4. One privileged core shared by the CLI and GUI front-ends.
5. Clean, **automatic** install/uninstall transitions on the desktop — no "go wait" / "go close something" prompts.

**Non-goals**
- A privileged mechanism daemon (D-Bus/polkit-helper). YAGNI for a one-shot.
- Touching the user-scope service path or its existing hand-off.
- `.deb`/`.rpm` packaging (distribution stays AppImage + Velopack for now).

## 4. Architecture

One privileged core, three entry points; the running root service owns its own lifecycle.

```
                 ┌─ headless:  sudo ./WsScrcpyWeb --install-system-service --port N ─┐
                 │                                                                    ▼
  desktop GUI ──► pkexec ./WsScrcpyWeb --install-system-service  (awaited, NO kill) ─► installSystemService()  (asserts euid==0)
                                                                                      ├─ stage binary + deps → /opt/ws-scrcpy-web (bin_t)
  running root service ──► stop / restart / uninstall  (in-process, already root) ──► ├─ write /etc/systemd/system/WsScrcpyWeb.service
                                                                                      │     (Restart=on-failure, RestartSec=2s)
                                                                                      ├─ semanage fcontext + restorecon  (/opt → bin_t)
                                                                                      └─ daemon-reload → enable [--now]
```

**Key structural win:** the privileged operation is the AppImage re-invoked with a flag, so the install logic is **the same real code** whether root was acquired via `sudo` (headless) or `pkexec` (desktop). The generated shell script (`buildSystemInstallScript`) is gone, and with it the shell-escaping and the string-only tests.

## 5. Components & changes

| Change | Detail |
|---|---|
| **NEW — CLI entry** | `--install-system-service [--port N]`, `--uninstall-system-service [--keep-state]`, `--system-service-status`. Each calls the core and exits with a clear code. Refuses if `euid≠0`: *"run via sudo, or use the desktop installer."* |
| **CHANGE — `runPkexec`** | Drop `timeout: 60_000`; **await the exit code** (no `kill`). This single change removes the entire `kill EPERM` class. The `sudo`-path runner is the same await-exit shape. |
| **REPLACE — `buildSystemInstallScript`** | The generated `pkexec sh -c "<script>"` → the in-code `installSystemService()` core (runs as root via either front-end). No shell string. |
| **CORE — `installSystemService()` / `uninstallSystemService()`** | Assert `euid==0`; idempotent; stage binary+deps → `/opt` (`bin_t`), write unit, `semanage`+`restorecon`, `daemon-reload`, `enable [--now]`. Reuses today's already-root install branch logic, refactored behind an **injected command runner** (for behavior-level tests). |
| **SCOPE-DOWN (not delete)** | The local-instance **out-of-cgroup detached hand-off helper** and the `loginctl` relaunch are **not used by the system-install path** — a headless boot service neither hands off from a desktop session nor relaunches into one. The desktop takeover uses systemd's own restart-retry instead (§7). **User-scope keeps its existing hand-off untouched.** The `loginctl` relaunch is retained *only* for the desktop uninstall-while-served fall-back (§8). |

## 6. The unit file

```ini
[Unit]
Description=ws-scrcpy-web — browser-based scrcpy front-end for Android devices
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
ExecStart=/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage   # bin_t, root-owned, stable path
Environment=DATA_ROOT=/var/lib/ws-scrcpy-web
Environment=WS_SCRCPY_SERVICE=1
Environment=WS_SCRCPY_WEB_PORT=<port>
Restart=on-failure
RestartSec=2s

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure` + `RestartSec=2s` is load-bearing for the desktop takeover (§7): the service retries binding the port until the outgoing local copy releases it, then catches and stays up. `StartLimitBurst=10` over 60s bounds the retry so a genuinely-stuck port still surfaces a failure rather than looping forever. `WantedBy=multi-user.target` is what makes it **headless / pre-login** (no graphical session required). Note: `StartLimitIntervalSec`/`StartLimitBurst` go in `[Unit]`, **not** `[Service]` — a systemd quirk this project's smoke explicitly checks for (`Unknown key 'StartLimitIntervalSec'` is the tell).

## 7. Install flow

**Headless (primary):** no local instance exists, so no port conflict.
```
sudo ./WsScrcpyWeb --install-system-service --port 8000
  → installSystemService() runs as root → enable --now → bound at boot.
```

**Desktop (local copy already running on the target port) — automatic takeover, no manual step:**
1. Settings → install → `pkexec` prompt → authorize.
2. Root core: stage `/opt`, SELinux, write unit, `daemon-reload`, **`enable --now`**. The port is still held, so the first bind fails and systemd queues a retry (per §6). **The core treats "unit enabled" as success and does NOT roll back on this transient first-bind failure** — `pkexec` returns success without waiting for the bind; the eventual bind is confirmed by the GUI's `/api/service/status` poll (step 4).
3. The UI shows **"switching to the system service…"** and the local copy **gracefully shuts itself down** (existing stop-server path), freeing the port.
4. systemd's next retry (≤ `RestartSec`) binds. The UI, polling `/api/service/status`, sees `servedByService` and the browser tab reconnects — now served by the system service.

This is **not** the dropped detached-helper hand-off: it is systemd's own restart-retry plus the local copy exiting on its own. No out-of-cgroup helper, no cgroup-reaping race, no parent-killed-by-child.

## 8. Uninstall flow (no "go wait" in any case)

- **Headless / `sudo … --uninstall-system-service`:** disable → rm unit → SELinux teardown → `rm -rf` trees → `daemon-reload`. Stops and is gone.
- **From the web UI while the system service is serving you:** the service is root → it removes *itself* in-process (respond to the request first, then teardown). On a **desktop** it then **auto-relaunches a local copy** for the active session (`loginctl` discovery) so the tab isn't left dead; **headless** just stops (nothing to fall back to, by design).
- **Desktop, service already stopped, uninstall via your local copy:** `pkexec … --uninstall-system-service` → removed; the local copy keeps serving.

`--keep-state` preserves `config.json` + `logs/` under `/var/lib/ws-scrcpy-web` (only `dependencies/` and the unit are removed); a reinstall reuses the saved port.

## 9. SELinux (enforcing Fedora) / AppArmor (Ubuntu)

- `/opt/ws-scrcpy-web` (binary + deps) → **`bin_t`**: `semanage fcontext -a -t bin_t '/opt/ws-scrcpy-web(/.*)?'` then `restorecon -R /opt/ws-scrcpy-web`. This is the slow step (`semanage` recompiles policy — seconds); it is **awaited, never killed**.
- `/var/lib/ws-scrcpy-web` (state) → **`var_lib_t` by the policy default `/var/lib(/.*)?` — NO custom rule** (a `restorecon -R` is belt-and-suspenders). Never `/var/opt` (stock Fedora `/var/opt`→`/opt` equivalency rejects a `var_lib_t` rule there — the beta.64 lesson).
- The service runs **unconfined** (targeted-policy default for a `bin_t` binary launched by systemd) — no custom domain or policy module.
- **Uninstall:** `semanage fcontext -d '/opt/ws-scrcpy-web(/.*)?'` + `restorecon`, then `rm -rf`. There is no `/var/lib` rule to delete.
- **Ubuntu/AppArmor:** no per-path relabel needed — the SELinux steps are no-ops there.

## 10. Errors & cancellation

- **No `kill`, ever** — await the `pkexec`/`sudo` exit code. A slow `semanage` shows "installing…", never a kill-on-timeout.
- **polkit cancel** → `pkexec` exit 126 → "install cancelled," clean; nothing partially installed (the core is the first privileged action).
- **Install failure** — a *genuine* core error (unit write, `semanage` rejection, SELinux relabel), **not** the transient first-bind retry of §7 → the core rolls back (disable/rm unit, revert persisted `installMode`), exits non-zero; the GUI surfaces the message; the local copy keeps serving.
- **Desktop takeover stall** — if the local copy never frees the port within `StartLimitBurst`, systemd gives up and the status poll surfaces a clear "service couldn't bind the port" error (the unit stays enabled → starts next boot as a floor).

## 11. Testing

- **Unit (behavior, not strings — per `master_verification_trust`):** inject a fake command runner and assert the *actual* `semanage` / `restorecon` / `systemctl` invocations the core issues, in order, with the right args; assert the `pkexec` argv carries **no `timeout` and no `kill`**; CLI arg parsing (`--install-system-service`, `--port`, `--keep-state`, euid≠0 refusal); the unit renders with `Restart=on-failure`/`RestartSec`.
- **Runtime smoke (the real gate — CI cannot exercise SELinux/systemd/pkexec):**
  - *Headless Fedora (SELinux enforcing):* `sudo … --install-system-service` → `ls -Z /var/lib/ws-scrcpy-web` = `var_lib_t`, `ls -Z /opt/ws-scrcpy-web` = `bin_t`, `semanage fcontext -l | grep ws-scrcpy-web` = only the `/opt` rule, service **survives a reboot**, **zero AVC**.
  - *Desktop Fedora:* `pkexec` install with a local copy running → automatic takeover (≤ a few seconds, one tab, no manual step); uninstall-while-served → auto fall-back to local.
  - *Uninstall symmetry:* `semanage fcontext -l | grep ws-scrcpy-web` empty after uninstall; trees gone; `--keep-state` preserves config+logs.
  - *Ubuntu pass:* install/boot/uninstall with the SELinux steps no-op'd.

## 12. Risks / open questions

- **Desktop takeover timing** — `RestartSec=2s` assumes the local copy exits within a couple of restart cycles. The local copy's graceful shutdown is fast (existing stop-server path), so 1–2 retries should bind; `StartLimitBurst=10` is the safety floor. Confirm on the desktop smoke.
- **`loginctl` fall-back relaunch** (desktop uninstall-while-served) is the one retained piece of session-discovery complexity. It is *not* on the headless path. If it proves fragile in smoke, the fallback is a "service removed — relaunch the app" message (a manual step we'd rather avoid).
- **`semanage` latency** under `pkexec` — the prompt + a multi-second `semanage` means the GUI shows "installing…" for a noticeable beat. Acceptable; just don't bound it with a kill.

## 13. References

- Deep-research report (2026-06-12): freedesktop/polkit `polkit-apps.html`, man7 `kill(2)`, `fedoraproject.org/wiki/Packaging:Systemd`, `wiki.debian.org/Teams/pkg-systemd/Packaging`, `tailscale.com/docs`, `docs.syncthing.net`.
- `master_linux_platform` §6 (the `kill(2)`-EPERM architecture lesson), §3/§4 (`/var/opt`→`/var/lib` SELinux equivalency).
- `master_verification_trust` (assert behavior, not generated-command strings — the 4-beta CI evasion).
