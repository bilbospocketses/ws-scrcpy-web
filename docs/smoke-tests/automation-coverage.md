# Automation coverage register

Per-row automation status for `smoke-test.md`: one line for every row, carrying
the bucket it falls in and either the spec that covers it or the reason nothing
does. Companion to `smoke-test.md`, not a replacement — that document remains the
canonical list of rows and their steps.

Derived from `smoke-test.md` at `v0.1.30-beta.92`, which holds **140 rows**. Row
ids are stable and gappy; so are the lines here.

| | Rows | Where |
|---|---|---|
| Automated, fast tier | 29 | `build-and-test`, every PR |
| Automated, container tier | 7 | `build-and-test`'s docker step, and qa-harness nightly |
| Automated, device tier | 16 | qa-harness, nightly |
| Windows guest | 25 | qa-harness, nightly, once P4 lands |
| Windows guest **and** Linux residual | 2 | Windows half P4; Linux half nobody |
| Automatable, no spec written yet | 6 | nobody yet — 1 fast, 4 container, 1 device |
| **Residual — Linux installer and desktop** | **48** | nobody |
| **Residual — un-automatable** | **7** | nobody, ever |
| **Total** | **140** | |

**Automated today: 52 of 140 = 37 %.** After P4: 77 of 140 = 55 %, plus the
Windows halves of the two split rows.

Three different row counts have been quoted for this document, and only one of them
is wrong. The plan that commissioned this register worked from **127**, which was
the correct count for `v0.1.30-beta.82` — the version it named. Module 20's
thirteen container rows were added afterwards by P3 task 5, and nothing has been
removed since, so 127 + 13 = 140. A count of **135** also circulated while this
task was being scoped, and that one is a miscount: it matches row ids as
`<module>.<number>`, which silently drops the five that carry a suffix —
`4.2-user`, `4.2-system-cli`, `4.2-system-gui`, `5.3a` and `5.3b`. All five are
`[Linux]` system-scope install and uninstall rows, so that undercount fell
entirely on the Linux gap this register exists to measure.

`todo_ws_scrcpy_web` item 13 estimated "~60 % of the current smoke checklist goes
from manual minutes to automated seconds". That figure counted partial rows as
covered and assumed the Linux installer rows were reachable. The measured number
is **37 %**, and 55 % once P4 lands.

**Seven automated rows carry a manual half.** Each states both halves on its own
line below: 8.5, 8.8 and 9.5, whose remainder `smoke-test.md` itself calls
residual, and 9.4, 10.3, 12.4 and 13.3, whose remainder it calls manual. They are
counted once, in the tier that covers their automated half, so a reader adding the
buckets up does not count them twice — but the residual set is larger than its 55
rows by these seven halves.

Two further rows are marked **Split** rather than **Partial**, which is a different
thing: 7.2 runs its two halves in two different tiers, and 12.1’s container half is
rows 20.6 and 20.12. Neither leaves anything manual.

Buckets, once each, no row in two:

- **fast** — an untagged spec in `tests/e2e/`, run by `build-and-test` on every PR.
- **container** — a `@docker` spec. CI's docker step runs all of them; qa-harness's
  nightly docker tier runs all but the two marked `@docker-host`, which drive
  compose stacks of their own and need a docker CLI the runner does not have.
- **device** — a `@device` spec under `tests/e2e/device/`. qa-harness only, nightly,
  against the Android emulator P2 brings onto the run network.
- **Windows guest** — P4's territory. Not automated today.
- **no spec yet** — automatable with the tiers that already exist, and simply not
  written. Broken out rather than buried in the residual set, because these are the
  cheapest rows left on the board.
- **residual: linux-desktop** — blocked on a Linux desktop that no phase builds.
- **residual: un-automatable** — blocked on hardware, on an app defect, or on a
  product decision nobody has taken.

## Every row

Sorted by module, then by row number, which is not the doc's execution order.

| Row | Tag | What it checks | Bucket | Where it runs, or why it does not |
|---|---|---|---|---|
| 1.1 | `[Linux]` | First-run modal | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 1.2 | `[Linux]` | Accept → install + delete original | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 1.3 | `[Linux]` | Decline + remember | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 1.4 | `[Linux]` | Headless first-run | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 1.5 | `[Win]` | Fresh MSI install | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 1.6 | `[Win]` | Reinstall reuses config | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 1.7 | `[Linux]` | Cold-start opens one tab | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 1.8 | `[Win]` | Cold-start opens one tab | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 1.9 | `[Both]` | First-run dependency-bootstrap banner + Retry | container | `dependencies-panel.spec.ts` `@docker-host`. **CI only** - it drives a compose stack of its own, and the qa-harness runner has no docker CLI. |
| 1.10 | `[Win]` | Install-dir ACL grant + one-time UAC | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 2.1 | `[Fedora]` | Binary/deps labels | residual: linux-desktop | Residual. Needs a Fedora host with a policy store of its own, for `bin_t`/`var_lib_t` labelling and the `semanage` fcontext lifecycle. Containers share the host's. |
| 2.2 | `[Fedora]` | State labels | residual: linux-desktop | Residual. Needs a Fedora host with a policy store of its own, for `bin_t`/`var_lib_t` labelling and the `semanage` fcontext lifecycle. Containers share the host's. |
| 2.3 | `[Fedora]` | fcontext rules registered | residual: linux-desktop | Residual. Needs a Fedora host with a policy store of its own, for `bin_t`/`var_lib_t` labelling and the `semanage` fcontext lifecycle. Containers share the host's. |
| 2.4 | `[Fedora]` | Zero AVC during install | residual: linux-desktop | Residual. Needs a Fedora host with a policy store of its own, for `bin_t`/`var_lib_t` labelling and the `semanage` fcontext lifecycle. Containers share the host's. |
| 2b.1 | `[Ubuntu]` | Userns AppImage launch (potential 0.1.30 "Canonical" blocker) | residual: linux-desktop | Residual. Needs a stock Ubuntu desktop session: unprivileged-userns still restricted, AppArmor enforcing, no libfuse2 installed, a real file manager and a real menu. A container is none of those. |
| 2b.2 | `[Ubuntu]` | libfuse2 absent by default | residual: linux-desktop | Residual. Needs a stock Ubuntu desktop session: unprivileged-userns still restricted, AppArmor enforcing, no libfuse2 installed, a real file manager and a real menu. A container is none of those. |
| 2b.3 | `[Ubuntu]` | AppArmor zero-denials (service `/opt` exec) | residual: linux-desktop | Residual. Needs a stock Ubuntu desktop session: unprivileged-userns still restricted, AppArmor enforcing, no libfuse2 installed, a real file manager and a real menu. A container is none of those. |
| 2b.4 | `[Ubuntu]` | Install/uninstall with no SELinux tooling | residual: linux-desktop | Residual. Needs a stock Ubuntu desktop session: unprivileged-userns still restricted, AppArmor enforcing, no libfuse2 installed, a real file manager and a real menu. A container is none of those. |
| 2b.5 | `[Ubuntu]` | pkexec polkit dialog (GNOME) | residual: linux-desktop | Residual. Needs a stock Ubuntu desktop session: unprivileged-userns still restricted, AppArmor enforcing, no libfuse2 installed, a real file manager and a real menu. A container is none of those. |
| 2b.6 | `[Ubuntu]` | `systemd-run --user` survival | residual: linux-desktop | Residual. Needs a stock Ubuntu desktop session: unprivileged-userns still restricted, AppArmor enforcing, no libfuse2 installed, a real file manager and a real menu. A container is none of those. |
| 2b.7 | `[Ubuntu]` | Desktop menu entry + icon (GNOME) | residual: linux-desktop | Residual. Needs a stock Ubuntu desktop session: unprivileged-userns still restricted, AppArmor enforcing, no libfuse2 installed, a real file manager and a real menu. A container is none of those. |
| 3.1 | `[Linux]` | Per-user launch | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 3.2 | `[Linux]` | Single-instance ([flock](#g-flock)) | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 3.3 | `[Linux]` | Service-defer | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 3.4 | `[Win]` | Per-session tray | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 3.5 | `[Win]` | 2nd tray.exe rejected | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 3.6 | `[Win]` | Tray respawn after user-kill | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 3.7 | `[Win]` | Single-instance integrity (User vs Admin) | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 3.8 | `[Win]` | No startup Run-key (supervisor owns the tray) | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 4.1 | `[Linux]` | System-scope gate | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 4.2-system-cli | `[Linux]` | Install system scope — headless CLI | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 4.2-system-gui | `[Linux]` | Install system scope — desktop pkexec takeover | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 4.2-user | `[Linux]` | Install user scope | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 4.3 | `[Win]` | Install confirm UX | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 4.4 | `[Linux]` | Scope-radio legibility + detection | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 4.5 | `[Both]` | Confirm-dialog button style | no spec yet - fast | Automatable in the fast tier: a class assertion on confirm modals the suite already opens. The cheapest unclaimed row in the doc. |
| 4.6 | `[Linux]` | Service-unit hygiene | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 5.1 | `[Linux]` | Same-user uninstall (served-by-service) | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 5.2 | `[Linux]` | Different-admin uninstall | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 5.3 | `[Linux]` | Headless uninstall | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 5.3a | `[Linux]` | Headless uninstall `--keep-state` | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 5.3b | `[Linux]` | Ubuntu install + boot + uninstall | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 5.4 | `[Fedora]` | fcontext cleanup | residual: linux-desktop | Residual. Needs a Fedora host with a policy store of its own, for `bin_t`/`var_lib_t` labelling and the `semanage` fcontext lifecycle. Containers share the host's. |
| 5.5 | `[Win]` | Uninstall + handoff affordance | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 5.6 | `[Win]` | Uninstall handoff-failure guard | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 5.7 | `[Win]` | Full uninstall | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 5.8 | `[Linux]` | User-scope uninstall → relaunch local | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 5.9 | `[Linux]` | System-scope uninstall message | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 5.10 | `[Win]` | Non-admin uninstall, UAC declined | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 6.1 | `[Both]` | Update check | Windows guest (P4) + residual: linux-desktop | **Windows half:** P4. **Linux half:** residual - the row needs a real install at an older version, and nothing builds a Linux desktop. |
| 6.2 | `[Linux]` | Local-mode (home) update apply + relaunch | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 6.3 | `[Linux]` | No-service `/opt` update | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 6.4 | `[Linux]` | Newer home over `/opt` | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 6.5 | `[Linux]` | User-scope service update apply | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 6.6 | `[Linux]` | System-scope headless service update apply | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 6.8 | `[Win]` | In-app update apply + tray persists | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 7.1 | `[Both]` | Wireless connect | device | `device/connect.spec.ts` |
| 7.2 | `[Both]` | Scan subnet | device | `device/connect.spec.ts`. **Split across two tiers:** the public-range refusal is untagged and runs in the fast tier on every PR; the scan and connect-from-the-card need the emulator. |
| 7.3 | `[Win]` | USB device | residual: un-automatable | USB, barred by the wireless-only lock. Neither a container nor the emulator has a USB bus to offer. |
| 7.4 | `[Both]` | Device list updates in place | device | `device/connect.spec.ts` |
| 7.5 | `[Both]` | Remembered device model in scan hits | residual: un-automatable | The enrichment lives on `POST /api/devices/scan`, which the UI never calls (finding 7.6). Becomes a device row the moment that defect is fixed. |
| 8.1 | `[Both]` | Video stream | device | `device/streaming.spec.ts` |
| 8.2 | `[Both]` | Control | device | `device/streaming.spec.ts` |
| 8.3 | `[Both]` | Audio | device | `device/streaming.spec.ts` |
| 8.4 | `[Both]` | Codec/encoder settings | device | `device/streaming.spec.ts` |
| 8.5 | `[Both]` | H.264 + H.265 decode | device | `device/streaming.spec.ts`. **Partial:** H.264 is covered; the H.265 half is residual - no browser in the Linux runner decodes it (finding 8.11). |
| 8.6 | `[Both]` | AV1 / VP8 / VP9 decode | device | `device/streaming.spec.ts` |
| 8.7 | `[Both]` | Browser codec refusal is honoured | residual: un-automatable | Needs a second browser engine *and* a device whose encoder list includes H.265. No browser in the Linux runner decodes H.265 (finding 8.11), so "offered in Chromium" cannot be observed here at all. |
| 8.8 | `[Both]` | Locked device is reported, not shown as a black screen | device | `device/streaming.spec.ts`. **Partial:** the app reports the lock and never self-reconnects, which is covered; the banner half is residual because this emulator composes its keyguard instead of blanking it (finding 8.12). |
| 8.9 | `[Both]` | Hardware encoder is offered | residual: un-automatable | Needs a vendor hardware encoder (`c2.exynos.*`, `c2.amlogic.*`). The emulator offers only the `c2.android.*` software one. |
| 9.1 | `[Both]` | Shell modal | device | `device/modals.spec.ts` |
| 9.2 | `[Both]` | File listing/transfer | device | `device/modals.spec.ts` |
| 9.3 | `[Both]` | Device actions | device | `device/modals.spec.ts` |
| 9.4 | `[Both]` | Dependencies panel | fast | `dependencies-panel.spec.ts`, untagged. **Partial:** the table, check-for-updates and the admin gate are covered; the per-dependency update and the restart after it need an available update and stay manual. |
| 9.5 | `[Both]` | Shell-unavailable shows a reason | container | `dependencies-panel.spec.ts` `@docker-host`, **CI only**. **Partial:** the API half is covered; the per-device shell tooltip is residual - it needs a tracked device *and* an image without the node-pty prebuilt, and the device tier runs the full image. |
| 10.1 | `[Both]` | Service status API | fast | `server-surface.spec.ts` |
| 10.2 | `[Win]` | Logs clean | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 10.3 | `[Linux]` | Logs clean | fast | `server-surface.spec.ts`. **Partial:** the server's own `ws-scrcpy-web.log` is covered; `launcher.log` belongs to the Linux launcher and stays manual. |
| 10.4 | `[Both]` | Per-instance token / reload-on-restart | fast | `server-surface.spec.ts` |
| 10.5 | `[Both]` | 404 + security headers | fast | `server-surface.spec.ts` |
| 10.6 | `[Both]` | `allowedHosts` reverse-proxy opt-in | fast | `server-surface.spec.ts` |
| 10.7 | `[Win]` | Atomic writes survive the hidden attribute | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 11.1 | `[Linux]` | No-libfuse2 launch | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 11.2 | `[Linux]` | No-libfuse2 in-app update | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 11.3 | `[Linux]` | Locator fix watch (velopack#921) | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 11.4 | `[Win]` | PerMachine intact | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 12.1 | `[Linux]` | Local-mode clean exit + adb teardown | fast | `lifecycle.spec.ts`. **Split:** the bare server is covered; the container half is rows 20.6 and 20.12, both unwritten. No part of it is manual. |
| 12.2 | `[Both]` | Stop-exit service-mode gating | Windows guest (P4) + residual: linux-desktop | **Windows half:** P4. **Linux half:** residual - the gate is only meaningful with a systemd unit actually installed. |
| 12.3 | `[Win]` | Local-mode reaps everything | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 12.4 | `[Linux]` | DATA_ROOT override honored | fast | `lifecycle.spec.ts`. **Partial:** the Node side is covered; the launcher half stays manual. |
| 12.5 | `[Win]` | Abnormal-termination JobObject reap | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 13.1 | `[Both]` | Bookmark global-dismiss | fast | `settings-prompts.spec.ts` |
| 13.2 | `[Both]` | Reset welcome & bookmark prompts | fast | `settings-prompts.spec.ts` |
| 13.3 | `[Both]` | Server-section layout + web-port inline save | fast | `settings-prompts.spec.ts`. **Partial:** layout, inline save and the at-rest status are covered; "change port, save, persists and restarts" stays manual. |
| 14.1 | `[Linux]` | Install-for-all-users button | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 14.2 | `[Linux]` | Start-menu icon | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 14.3 | `[Linux]` | Complete uninstall — local | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 14.4 | `[Linux]` | Uninstall — user-service cascade | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 14.5 | `[Linux]` | Uninstall — system-service cascade | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 14.6 | `[Linux]` | Uninstall — keep settings & logs | residual: linux-desktop | Residual. Linux installer and desktop integration; no phase builds a Linux desktop. |
| 14.7 | `[Fedora]` | Uninstall — SELinux clean | residual: linux-desktop | Residual. Needs a Fedora host with a policy store of its own, for `bin_t`/`var_lib_t` labelling and the `semanage` fcontext lifecycle. Containers share the host's. |
| 15.1 | `[Win]` | In-app uninstall — keep | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 15.2 | `[Win]` | In-app uninstall — wipe | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 15.3 | `[Win]` | Uninstall modal UX | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 15.4 | `[Win]` | Stop-exit reaps tray + adb | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 15.5 | `[Win]` | Server-section order | Windows guest (P4) | P4, the qa-harness Windows guest suite. Not yet automated. |
| 16.1 | `[Both]` | Light/dark theme switch | fast | `a11y-theming.spec.ts` |
| 16.2 | `[Both]` | Keyboard focus ring | fast | `a11y-theming.spec.ts` |
| 16.3 | `[Both]` | Reduced motion | fast | `a11y-theming.spec.ts` |
| 16.4 | `[Both]` | Light-mode status tints | fast | `a11y-theming.spec.ts` |
| 16.5 | `[Both]` | Embed page lang | fast | `a11y-theming.spec.ts` |
| 16.6 | `[Both]` | Theme first-paint no-FOUC | fast | `a11y-theming.spec.ts` |
| 18.1 | `[Both]` | Default open mode | fast | `auth.spec.ts` |
| 18.2 | `[Both]` | 🔐 Secure the admin account | fast | `auth.spec.ts` |
| 18.3 | `[Both]` | 🔐 Login | fast | `auth.spec.ts` |
| 18.4 | `[Both]` | 🔐 Brute-force lockout + generic error | fast | `auth.spec.ts` |
| 18.5 | `[Both]` | 🔐 Admin clears a lockout | fast | `auth.spec.ts` |
| 18.6 | `[Both]` | 🔐 Manage users (role / disable / reset / delete + last-admin guard) | fast | `auth.spec.ts` |
| 18.7 | `[Both]` | 🔐 Non-admin authz (UI + server) | fast | `auth.spec.ts` |
| 18.8 | `[Both]` | 🔐 Change own password | fast | `auth.spec.ts` |
| 18.9 | `[Both]` | 🔐 Logout | fast | `auth.spec.ts` |
| 18.10 | `[Both]` | 🔐📱 WebSocket streams gated | fast | `auth.spec.ts` |
| 18.11 | `[Both]` | 🔐 Return to open mode | fast | `auth.spec.ts` |
| 18.12 | `[Both]` | 🔐 Sessions survive restart | fast | `auth.spec.ts` |
| 19.1 | `[Both]` | 📱 Open-mode labels unchanged | device | `device/labels.spec.ts` |
| 19.2 | `[Both]` | 🔐📱 Per-user label isolation | device | `device/labels.spec.ts` |
| 19.3 | `[Both]` | 🔐📱 Labels in live scan hits | device | `device/labels.spec.ts` |
| 20.1 | `[Both]` | Settings → Service in a container | container | `docker-gating.spec.ts` |
| 20.2 | `[Both]` | Settings → Updates in a container | container | `docker-gating.spec.ts` |
| 20.3 | `[Both]` | libfuse2 banner | residual: un-automatable | Nothing left to test - the libfuse2 gate this row checked no longer exists. A tombstone, kept so the number is not reused. |
| 20.4 | `[Both]` | "install for all users" row in a container | residual: un-automatable | Blocked on an open product decision, not on automation: what the "install for all users" row should do in a container is undecided (register 20.4). |
| 20.5 | `[Both]` | "uninstall ws-scrcpy-web" row in a container | residual: un-automatable | Blocked on an open product decision, not on automation: what "uninstall ws-scrcpy-web" should do in a container is undecided (register 20.5). |
| 20.6 | `[Both]` | "stop server & exit" in a container | no spec yet - container | Automatable as a `@docker-host` spec that drives `docker stop` from outside the container. The bare-server half is already covered by 12.1. |
| 20.7 | `[Both]` | Linux system-wide-install offer in a container | container | `docker-gating.spec.ts` |
| 20.8 | `[Both]` | Pull `:beta` from Docker Hub | no spec yet - container | Automatable as a pull-and-compare check against `jchapz30/ws-scrcpy-web:beta`, which publishes on every beta since beta.90 (2026-09-03) and passes the Scout gate since beta.94; nothing blocks the spec now. |
| 20.9 | `[Both]` | First-boot hydrate on a fresh `/data` volume | container | `docker-gating.spec.ts` |
| 20.10 | `[Both]` | Wireless connect from a container | no spec yet - device | Automatable by pointing the device tier at the container subject instead of the bare server. Needs the emulator and the container on one network. |
| 20.11 | `[Both]` | Persistence across `docker rm` + re-run | no spec yet - container | Automatable as a `@docker-host` spec. Unblocked 2026-09-04: finding 20.14 is fixed, so the container writes its log to `/data/logs` on the volume and the log half can pass. |
| 20.12 | `[Both]` | Graceful `docker stop` | no spec yet - container | Automatable as a `@docker-host` spec asserting exit 0 within the grace period. |
| 20.13 | `[Both]` | `HEALTHCHECK` healthy | container | `tests/e2e/support/dockerStack.ts` — `composeUpFresh` brings the stack up with `--wait`, which refuses to proceed unless the image reports healthy. |

---

## Module 20 — container (Docker) behaviour

New module. Modules run 1–19 with 17 a deliberate tombstone, so 20 is the next
free number.

### Gated in task 5 (SP4 E4)

| # | Affordance | Container behaviour | Status |
|---|---|---|---|
| 20.1 | Settings → Service | replaced by *"service install not applicable — this instance runs in a container."* | automated (`settingsModal.dockerGating.test.ts`; container smoke in task 11) |
| 20.2 | Settings → Updates | replaced by *"update via `docker pull jchapz30/ws-scrcpy-web:latest`."* | automated (same) |
| 20.3 | libfuse2 banner | **nothing to hide — the gate no longer exists** | n/a, see below |

**20.3 is satisfied by deletion, not by gating.** SP4 decision 4 requires the
libfuse2 banner hidden in Docker, but the libfuse2 first-run gate was removed
end-to-end in an earlier release — `isLibfuse2Installed` / `ensureLibfuse2`
(`SystemdClient.ts`), the `/api/updates/install-libfuse2` endpoint, the
`libfuse2Installed` status field, **and the Settings prompt in
`SettingsModal.ts`** (see CHANGELOG, "Removed the libfuse2 first-run gate").
`grep -ri libfuse src/` returns nothing today. The requirement is moot rather
than outstanding, and is recorded here so a future reader does not go looking
for a gate to implement.

### Findings — surfaced by task 5 step 3, deliberately NOT fixed there

Task 5's grep for host-assuming affordances surfaced three more, all in the
**Server** section, which task 5 does not gate. Recorded rather than fixed,
because gating the Server section is a scoped decision and not part of SP4
decision 4's locked list.

| # | Affordance | In a container | Assessment |
|---|---|---|---|
| 20.4 | **"install for all users"** — the Settings → Server *row* | POSTs `/api/service/install-system-wide`, which runs `pkexec`, relocates to `/opt` and re-execs | **Finding, still open.** A container has no polkit and relocating inside the image is meaningless; the row is Linux-gated but not container-gated. Needs a decision: hide it in Docker, or leave it and let it fail loudly. |
| 20.7 | **the same offer as a first-run modal** (`SystemWideInstallModal`) | opened on first load of every container and, being a `<dialog>`, swallowed the clicks meant for the page beneath it | **FIXED.** `offerMachineWide` now requires `status.docker !== true`. It could not be left to the decline marker, which is per-data-root: a fresh volume has none. Asserted by `docker-gating.spec.ts`. |

**20.7 is why the container suite exists.** It is Linux-only, so it cannot appear on a Windows dev box; and because the modal is loaded by a dynamic `import()`, a fast machine can land the next click before it renders. It therefore **passed locally and failed only in CI** — the same trap `playwright.config.ts` already documents for this exact modal in the fast tier. The fix is a gate rather than a marker precisely so it stops being a race.
| 20.5 | **"uninstall ws-scrcpy-web"** | tears down a service/install that does not exist here | **Finding.** The container equivalent is `docker rm`. Same decision as 20.4. |
| 20.6 | **"stop server & exit"** | graceful shutdown — `adb kill-server`, service release, exit 0 | **Correct in a container, and load-bearing.** This is exactly what smoke row 12.1 asserts against `docker stop` (SIGTERM reaching node *through* `start.sh` via `tini -g`). Must NOT be gated. |

20.4 and 20.5 are the two rows a container-aware Server section would cover. They
are listed as one decision because they share a cause: both are install-lifecycle
affordances whose lifecycle the container owns instead.

---

## Module 18 — auth subsystem (opt-in login)

All twelve rows are automated by `tests/e2e/auth.spec.ts` (P3 task 10) as one
serial state machine: 18.2 secures the admin account and turns login on, rows
18.3–18.10 run against the locked server, 18.11 returns it to open mode, and
18.12 restarts a server of its own. Each row was designed with an inverted
assertion and an app mutation it must catch; `tests/e2e/README.md` records the
harness facts the file relies on (the per-run database wipe, `retries: 0`, the
return-to-open-mode `afterAll`, the never-retry-a-login rule).

| # | Row | Status |
|---|---|---|
| 18.1 | default open mode | automated |
| 18.2 | secure the admin account | automated — the farewell text is recorded by an observer and read back from the login page, because the client reloads in the same synchronous run |
| 18.3 | login | automated — the row's "dependencies" is the page-level panel, not a Settings section; the spec asserts the five section headings and the admin-only rows |
| 18.4 | brute-force lockout + generic error | automated — the enumeration half is byte-identical bodies plus identical UI text; timing blinding is covered by the unit tests, not end to end |
| 18.5 | admin clears a lockout | automated |
| 18.6 | manage users + last-admin guard | automated |
| 18.7 | non-admin authz (UI + server) | automated — the row's "401/403" is exactly `403 {"error":"forbidden"}` for an authenticated non-admin; 401 is only ever the no-session case |
| 18.8 | change own password | automated |
| 18.9 | logout | automated — proves the session row is deleted server-side, not just the cookie |
| 18.10 | WebSocket streams gated | automated — same context before and after login, so only the session cookie differs |
| 18.11 | return to open mode | automated |
| 18.12 | sessions survive restart | automated on a spec-owned server (port 8124), never the shared one |

### Findings — surfaced by task 10, deliberately NOT fixed there

| # | Finding | Assessment |
|---|---|---|
| 18.13 | **The client and the server disagree about when the first-user lockdown applies.** `UsersModal` shows the "Secure the admin account" block whenever `me().authEnabled` is false; the server takes the lockdown branch only while no enabled admin has a password. After 18.11 (login disabled, admin still passworded) the client offers "Secure & add user", the server answers the normal-create `201 {id}`, and the client announces "Login is now required. Reloading…" into an app that is still open. | **Finding, open.** The spec asserts neither behaviour. Fix direction: key the client on the same fact as the server (expose it on `/api/auth/me`, or have the server refuse the admin fields when it will ignore them). |
| 18.14 | **Live WebSocket connections survive logout and disable.** Deleting the session row refuses NEW connections (4401, proven by 18.9/18.10) but nothing tears down sockets the SPA opened while the session was valid. | **Finding, open.** Decide: revoke live sockets when their session is deleted (logout, disable, delete), or document that a stream outlives its login. Not asserted either way. |
| 18.15 | **`/login-assets/` is allow-listed in `AuthGate` but nothing serves it**, and there is no `/login` route (the login page is served inline). | **Code-quality finding.** A dead allow-list entry is a standing invitation to serve something unauthenticated by accident; remove it or give it a purpose. |

---

## Modules 9, 10, 12 and row 1.9 — server surface, dependencies, lifecycle

Ten rows, automated by `tests/e2e/server-surface.spec.ts`, `lifecycle.spec.ts`
and `dependencies-panel.spec.ts` (P3 task 11). Anything that stops or restarts
a server, needs a boot-time config key, reads the server's log, or needs locked
mode runs on a spec-owned server; the two rows that need a host the fast tier
cannot be (`1.9`, `9.5`) are `@docker` and bring up their own compose stacks
from `tests/docker/` (see `tests/e2e/README.md`).

| # | Row | Status |
|---|---|---|
| 1.9 | first-run bootstrap banner + Retry | automated, container tier — the stack boots with no working resolver, so every download fails at once; Retry after the resolver is restored clears the banner |
| 9.4 | Dependencies panel | automated: the table, check-for-updates and the admin gate. **Not** the per-dependency update and the restart after it: the `update` button renders only for `update-available`, which an up-to-date install cannot offer deterministically, and there is no standalone restart control (only `Restart Now` after a restart-requiring update) |
| 9.5 | shell unavailable shows a reason | automated, container tier — the API half (`{"shell":false,"shellReason":"no-seed-package"}`), with the full image as the `{"shell":true}` contrast. The per-device shell link's tooltip is residual: it needs a tracked device AND the no-node-pty image at once, and the device tier runs the full image (9.1 asserts the healthy `aria-disabled`-free link there) |
| 10.1 | service status API | automated |
| 10.3 | logs clean | automated for the server's own `ws-scrcpy-web.log`: the teardown line on stop, and zero `ERROR`/`Error:` lines against an empty allow-list (finding 10.9 emptied it). `launcher.log` belongs to the Linux launcher and stays manual |
| 10.4 | per-instance token / reload on restart | automated on a spec-owned server |
| 10.5 | 404 + security headers | automated — the 404 now holds for a document request too, and the headers are server-wide (findings 10.7, 10.8) |
| 10.6 | `allowedHosts` | automated — the listed host served, an unlisted one refused, defaults intact, on a spec-owned server seeded with the key |
| 12.1 | clean exit + adb teardown | automated for the bare server (the UI path: confirm, the stopped notice, exit 0, no `.restart` marker, the teardown lines in order). The container half is 20.6 / 20.12 |
| 12.4 | `DATA_ROOT` honoured | automated for the Node side — and see finding 12.5 for what "same root" actually rests on |

### Findings — surfaced by task 11, deliberately NOT fixed there

| # | Finding | Assessment |
|---|---|---|
| 12.5 | **The log file and the dependencies folder are keyed on `DEPS_PATH`, not `DATA_ROOT`.** A bare `node dist/index.js` with only `DATA_ROOT` set puts `config.json` and the store under it but logs to the repo root and, on Linux, hydrates into `<repo>/dependencies`. Row 12.4's "Node side and launcher agree" holds only because the Rust launcher sets both variables; Windows ignores `DATA_ROOT` entirely. | **Fixed 2026-09-04.** `resolveDataRoot` honours an explicit `DATA_ROOT` on every platform, Windows included, and `resolveDependenciesPath` derives `<DATA_ROOT>/dependencies` from it — so `DATA_ROOT` alone now means what the row says. `DEPS_PATH` and `config.json` still win over it.
| 20.14 | **In the container there is no server log at all.** `start.sh` exports `DEPS_PATH=/app/dependencies` (a symlink to `/data/dependencies`), so the log path resolves to `/app/logs/ws-scrcpy-web.log` — and `/app` is root-owned while the app runs as uid 1000, so the directory is never created and every write no-ops (measured 2026-09-03: no `/app/logs`, no `/data/logs`, `docker logs` carries only `start.sh`'s own lines, because the console echo is TTY-only). SP4 §13 ("config + logs survive") and smoke row 20.11 assume a log on the volume. | **Fixed 2026-09-04.** The log path keys on `DATA_ROOT` first and falls back to `dirname(DEPS_PATH)`, so the desktop launcher's answer is unchanged and the container's log lands on the volume at `/data/logs`. `start.sh` no longer clobbers an inherited `DEPS_PATH`, and the entrypoint pre-creates `/data/logs` under the app's uid.
| 20.16 | **adb aborted on every invocation inside the container.** The entrypoint's step-down kept the root shim's `HOME=/root`; adb creates `$HOME/.android` on every run, `adb --version` included, and aborts with a core dump when it cannot (`Cannot mkdir '/root/.android'`). The server's version probe swallowed the abort into `installedVersion: null`, so the first-run banner named adb as failed to download on every boot of the shipped image, the Dependencies panel showed it as not installed, and no device could have connected. Nothing in the container tier had asked; row 20.9 was marked as proven by `up --wait`, which only proves the loopback health probe. | **FIXED in the task 11 PR** (`docker/entrypoint.sh` exports a volume-backed `HOME=/data/home` before `setpriv`, so the adb key pair also survives `docker rm`, and owns that directory on **every** boot — a volume from an earlier image is already owned by the app user, so the one-time recursive chown skips it and a root-owned `/data/home` would reproduce the abort; the guard caught exactly that on a stale volume), and now guarded: `docker-gating.spec.ts` asserts every dependency, adb's real version included, is installed on a fresh volume. Found by row 1.9's Retry never clearing the banner. |
| 20.15 | **The restart marker is written where the Docker launcher never looks.** Node writes `<dataRoot>/.restart` (`/data/.restart`); `start.sh` checks `$DEPS_PATH/.restart`. Restart still works because it keys on exit code 75, so this is dead plumbing rather than a broken restart. | **Fixed 2026-09-04.** `start.sh` mirrors `resolveDataRoot` and keys the marker on the same root Node writes, so the plumbing is live rather than dead.
| 10.7 | **An unknown `/api/*` path answers with the SPA shell when navigated to as a document.** The static fallback keys on `Accept: text/html` plus an extensionless path, and `/api/no-such-route` is extensionless; a JSON caller gets the 404 the row describes, a browser address bar gets 200 and the shell. | **Fixed 2026-09-04.** `isSpaNavigation` excludes `/api` and `/api/*` outright, so an unknown API path 404s whatever the `Accept` header says.
| 10.8 | **API JSON responses and the request gate's 403 carry no `X-Content-Type-Options` / `X-Frame-Options`.** Static responses, the login page and its 401 do. | **Fixed 2026-09-04.** `securityHeaders()` is applied once at the request-handler choke point (`createHttpRequestHandler`), so the gate's 403 and every API JSON response carry them; `writeHead(status, headers)` still merges over them, so handlers that spread the helper themselves are unaffected.
| 9.6 | **The Dependencies panel is not hidden from a user-role account.** It renders its heading and table for everyone and, on the 403, shows `Failed to load dependencies` — the row's "doesn't see it" is the panel failing, not being gated. | **Finding, open.** Gate the panel's mount on the same role the API uses, or accept the failure row as the design and reword the smoke row. |
| 9.7 | **`retry-install` replies before the retried install has finished.** The response can be `{"success":false,"stillMissing":["adb"],"errors":{}}` for a retry that completes ten seconds later; the banner's own poll is what actually clears it. | **Finding, open.** Either await the install or document the reply as "started", and let the client key off the poll only. |
| 10.9 | **The node-pty resolver reports the seed's absence at ERROR level.** A checkout that has not run `npm run stage-seed` (CI's `npm ci` + build tree) logs `[NodePtyResolver] ERROR no seed node-pty package found; cannot resolve` at every boot, for a condition the app itself treats as a capability, not a fault (`/api/capabilities` answers `shellReason: 'no-seed-package'`, row 9.5). The Linux CI run of 10.3 caught it; the spec now tolerates that one line only while the seed really is absent from the tree. | **Fixed 2026-09-04.** The line is a WARN naming the capability it reports (`shellReason: no-seed-package`), and row 10.3's allow-list is empty again.


## Modules 7, 8, 9 and 19 — the device tier (task 15)

Runs only inside qa-harness's Linux runner, against the subject container and P2's Android
emulator on the run network (`tests/e2e/device/*.spec.ts`, tagged `@device`; the runner refuses
to start Playwright unless its own adb sees the emulator in `device` state). Every row is judged
on the device through the runner's out-of-band adb or the app's own device routes, never on the
UI's claim alone. The runner reaches the subject on **loopback** inside the subject's network
namespace — see finding 8.10 for why that is not a convenience.

| # | Row | Status |
|---|---|---|
| 7.1 | wireless connect | automated — the manual-add form; the row appears in ~5 s (annotated per run; the bound is one adb poll cycle, 20 s) |
| 7.2 | scan subnet + private-range guard | automated — the refusal (public CIDR and a malformed subnet, and proof no scan started) in the **fast** tier; a /32 scan finding the emulator and connect-from-the-card in the device tier. One stub: the gateway prefill, which would otherwise be the container's /16 |
| 7.4 | device list updates in place | automated — a settled device causes zero table refreshes in 6 s, a rename costs exactly zero label fetches and keeps the row node, a real reconnect yields a new node (the control). With one device "once per row" and "once per refresh" are indistinguishable; the row's ~1 s is one adb poll cycle in practice (measured 0.8-3.3 s to drop, ~5.3 s to return) |
| 7.5 | remembered model in scan hits | **manual** — finding 7.6 |
| 8.1 | video stream | automated, device tier — a picture arrives (decoded frames counted, canvas changing, not black), no decode errors; the canvas follows a viewport resize keeping the device aspect ratio. **Intermittently red by name: finding 8.14** (video arrives, nothing decodes, nothing reports it) |
| 8.2 | control | automated, device tier — the on-screen Home/Back buttons, verified out of band through `dumpsys window`'s focus; see the spec for what key input can and cannot prove |
| 8.3 | audio | automated, device tier — opus, aac and the source toggle each connect and report their codec (headless chromium cannot prove sound); **the audio-disabled connect fails by name: finding 8.13**, the stream never starts on the reverse tunnel with audio off |
| 8.4 | codec/encoder settings + resize persistence | automated, device tier — codec and bitrate saved, surviving a reload and a resize, and the stream reconnecting with the saved codec |
| 8.5 | H.264 + H.265 decode | automated for H.264, device tier — the assertion is a picture, never a connection. The H.265 half is residual on Linux (finding 8.11) |
| 8.6 | AV1 / VP8 / VP9 decode | automated, device tier — every codec the emulator offers besides H.264, the list asserted non-empty first; codecs the emulator does not encode are named in the spec |
| 8.8 | locked device reported | **partial**, device tier — with the swipe keyguard enabled (the AVD ships with it off, restored in a finally) the app reports `locked:true`, no self-reconnect while locked, frames after unlock; the banner assertion is live only when a canvas sample goes black, and this emulator composes the keyguard (50 decoded frames while locked, all pictured), so the banner half is residual real-device behaviour — finding 8.12 |
| 9.1 | shell modal | automated — commands whose output the device must compute, the session visible in the device's process table while open and gone after the confirmed close |
| 9.2 | file listing/transfer + quiet console | automated — navigate into a directory, upload, download (bytes compared), delete through the confirm, the icon-size preference persisting through a reload, zero console errors (one by-design refusal allowed by URL) and the per-message traces gated behind the debug flag |
| 9.3 | device actions | automated — sleep/wake through the button, the effect read from the device, the button's colour from the theme's danger/success variables |
| 19.1 | open-mode labels | automated — set from the row, stored for the implicit user, surviving a reload |
| 19.2 | per-user label isolation | automated with the negative — B sees "Unnamed Device", B's own map is empty, A still reads A-name after B renames |
| 19.3 | labels in live scan hits | automated — the hit's identity read from the wire, the empty-label control, then A and B each seeing their own label on the same hit. See finding 19.4 for why the row's premise does not hold through the product's own path |

### Findings — surfaced by task 15, deliberately NOT fixed there

| # | Finding | Assessment |
|---|---|---|
| 8.10 | **On an insecure origin the app registers no player and says nothing.** WebCodecs is exposed only in a secure context, so at `http://<ip>:8000` `WebCodecsPlayer.isSupported()` is false and `getPlayers()` is empty: the device card has no connect link, ConfigureScrcpy's connect button does nothing (`openStream()` returns early with no player name), and its video inputs are never filled. Measured 2026-09-03 with this repo's chromium 151: `http://127.0.0.1:PORT` → `isSecureContext: true`, `VideoDecoder: function`; `http://192.168.87.3:PORT` → `false`, `undefined`. Chromium's `--unsafely-treat-insecure-origin-as-secure` — alone, with `--enable-features=UnsafelyTreatInsecureOriginAsSecure`, with `--allow-insecure-localhost --ignore-certificate-errors`, and through a persistent context — changed nothing. A LAN user opening the app from another machine over plain HTTP, which is the Docker image's intended use, gets a device list they cannot stream from and no explanation. The chain: `src/app/player/WebCodecsPlayer.ts:33` `isSupported()` is false → `StreamClientScrcpy.players` stays empty → `DeviceTracker.ts:405` renders no `a.link-stream` (it only calls `updateLink` for a registered player) → `ConfigureScrcpy.ts:803` `openStream()` returns early on a missing player name. No `isSecureContext` handling exists anywhere in `src/`. | **Fixed 2026-09-04.** `insecureOriginNotice` says why, in the device card (a full-width notice under the modal-launch grid, shown when no player registered and the origin is insecure) and in the config modal's status line. The README states it as a requirement and names the loopback URL. The chain itself is unchanged — the browser really does withhold the decoder — so this reports the condition rather than working around it.
| 7.6 | **Row 7.5's "remembered model in scan hits" is unreachable from the UI.** The `observed.model` enrichment lives in `POST /api/devices/scan` (the mDNS REST route), which no client code calls; the scan-network UI uses `/ws-scan`, whose TCP hits carry the live handshake banner as `name`, and only the `label` is rehydrated (the scanner's MAC-then-serial lookup). Either the beta.67 feature moved to a route the UI no longer takes, or the WebSocket path regressed it. | **Finding, open.** Decide which; until then the row stays manual and is marked so. |
| 8.11 | **No browser in the Linux runner decodes H.265.** Chromium never ships HEVC; Chrome on Linux relies on a platform decoder the `noble` base does not have. Measured inside the runner 2026-09-03 (`docs/adr/2026-09-01-browser-codec-matrix.md` in qa-harness, Linux rows). Not a product defect — a platform limit — but it moves 8.5's H.265 half and 8.7's positive half to the residual set on this tier, naming the platform. | **Residual on Linux, coverable on a Windows host with Chrome** (the P4 Windows guest tier's natural home). The specs select the codec by name, so a runner base with HEVC decode makes the pair automatable without a spec change. |
| 19.4 | **A label set on the device row never reaches that device's scan hits.** The row keys labels on the device's own `ro.serialno` (`DeviceTracker.ts:224-225`, PUT at `:545`); a TCP scan hit's identity is the probe address (`NetworkScanner.ts:265,277-279`: `serial: address`), and the per-spectator lookup asks the MAC alias first and then that serial (`:349-353`). The only bridge, the MAC alias, is written solely when a label is supplied at connect time (`DeviceDiscoveryApi.ts:96-114`, `if (success && label)`). Name a device from the list, disconnect it, scan: the hit comes back unnamed. The label is filed under a key the scan never asks for. Smoke row 19.3's premise ("with A and B each holding a distinct label from 19.2") does not hold through the product's own path; the spec stores each user's label under the key the hit actually carries and tests the per-spectator resolution, which is what the row is about. | **Finding, open.** Write the MAC alias whenever a label is saved for a connected device (or resolve scan-hit labels through the same serial the row uses). |
| 7.7 | **A device connected by hostname is still reported as a scan hit by IP.** `NetworkScanner.ts:218,228,267` excludes already-connected devices by exact address string, so `qa-android:5555` does not suppress a hit at `<ip>:5555`; the same device sits in the connected list and appears as a fresh hit at once. | **Finding, open.** Exclude by resolved address (or by the device's serial), not by the string the user typed. |
| 7.8 | **`POST /api/devices/disconnect` answers 500 for an address that is not connected.** adb prints "no such device" and the route maps `!success` to 500, so a disconnect that is already true is an error to the caller. A cleanup or arrange step that may run against either state has to accept both statuses and assert the outcome instead (`disconnectIfConnected` in the device helper). | **Fixed 2026-09-04.** `classifyDisconnectResult` treats adb's "no such device" as the no-op it is and answers 200 `{success: true, message: 'not connected'}`, mirroring connect's "already connected"; a genuine adb failure still answers 500.
| 8.12 | **The emulator composes its keyguard; a real phone blanks it.** Row 8.8 rests on Android handing scrcpy a black surface while locked (issue #498). On this AVD (Android 36, google_apis, swiftshader), with the swipe keyguard enabled and the display kept awake, the stream delivered 50 decoded frames while `locked:true`, every one with a picture, so `checkForDegradation` correctly never fired and the banner correctly never showed. The app's lock detection itself is fine on SDK 36 (`{"awake":false,"locked":true}` with the keyguard up). | **Residual on the emulator, real-device behaviour (spec §11.1).** 8.8's banner assertion is conditional on a canvas sample going black and turns live by itself on a fixture that blanks the keyguard; the tier records the composed frames as an annotation. |
| 8.13 | **Clearing "enable audio" stops the stream from starting on the reverse tunnel.** With `audio=false` the reverse-tunnel path still waits for three TCP connections — `acceptSockets(server, count, …)` at `src/server/ScrcpyConnection.ts:354` — and closes the WebSocket with `4005 Timeout waiting for 3 TCP connections (got 2)`; the forward-tunnel path (`:215-227`) correctly skips the audio connect for `audio=false`. Measured on the socket in four harness runs: the audio-disabled connect delivered `{"messages":0,"bytes":0}` and that close, while the three audio-enabled connects in the same test each delivered 12–13 messages, ~46–49 KB and a `First decoded frame`. The synthetic `AUDIO_DISABLED` sentinel socket (`:225-226`) was reproduced in isolation on the same Node and is not the fault. | **Fixed 2026-09-04 (high).** The reverse path now derives its socket count from the audio option — `expectedTunnelSocketCount(audioEnabled)` — and splices the synthetic `AUDIO_DISABLED` socket into slot 1 via `assembleReverseTunnelSockets`, so the positional [video, audio, control] triple holds either way. Both tunnel paths share the one sentinel factory now. Row 8.3 is unblocked.
| 8.14 | **A session can deliver video the browser never decodes, and nothing reports it.** Intermittent and not path-specific: first seen on 8.1's connect-link session (runs 2f68, 5940, cccc, 3c57-adjacent), then in run bece it hit 8.1, 8.4 and 8.5 in one run — 8.4 and 8.5 stream from the config modal at native 1080×1920 with no `maxSize`, and both had passed eight runs running. Two harness runs shared the host during bece, which may raise the odds; the product must report the condition either way. The socket witness on a failing 8.1: `{"messages":5782,"bytes":20688483,"closed":null}` on the stream socket, `decoded frames 0 -> 0`, canvas still `300x150` (its untouched default). So `VideoDecoder.configure` never ran, and because `armDecodeWatchdog` arms only after configure, the 5 s watchdog never fired: a `Connected:` line, then silence, then a black rectangle with no explanation — issue #508's shape one layer earlier. | **Reporting fixed 2026-09-04; trigger still open.** The watchdog is armed at session start rather than on configure, so "video arrived, nothing configured" now reports itself instead of being gated behind the step that did not happen — and it says so in its own words, since the issue #498 message blames codec support and would misdirect here. `parseConfig`'s four silent `return null` paths now name what they rejected and why, with the packet length and its first bytes: that is the evidence the next occurrence needs, and its absence is why the trigger is still unknown. Rows 8.1, 8.4 and 8.5 will now fail loudly rather than silently when it recurs.

---

## Why 55, and what would move most of them

48 of the 55 are Linux **installer** and **desktop-integration** rows, and two more
contribute their Linux halves: AppImage launch under Ubuntu's unprivileged-userns
restriction and with no `libfuse2` on the host, AppArmor denials, polkit dialogs
under both GNOME and KDE, desktop menu entries and icon caches, systemd user- and
system-scope units, SELinux `bin_t`/`var_lib_t` labelling and the `semanage`
fcontext lifecycle, and Velopack in-place self-update. A container has no polkit, no
desktop session, no per-container SELinux policy store and no AppImage mount.
Testing the container does not test the AppImage — they are two distribution
channels that share only a codebase.

The design has an asymmetry it does not name: P1 builds a Windows desktop, which is
what makes the 25 W rows reachable. It builds no Linux desktop, so the Linux
installer half has no phase at all. Spec §3.5's "ships on Windows AND Linux, so it
needs both a Linux container suite and a Windows guest suite" reads as though the
container suite covers the Linux side. It covers a THIRD channel that did not exist
when that sentence was written.

RECOMMENDED, EXPLICITLY OUT OF P3: a Linux desktop guest phase. It is far cheaper
than P1's — no licence, no 20-minute unattended install, no 8.4 GB ISO that dockur
deletes afterwards; a Fedora and an Ubuntu cloud image boot under the same KVM this
host already exposes, and the whole overlay mechanism P1 built transfers unchanged.
Its scope is exactly these 48 rows plus the two Linux halves. Not all of them need a
graphical session — the SELinux labelling, the headless install and uninstall paths
and the no-`libfuse2` rows would boot on a plain cloud image — but the ones that do,
the GUI first-run modal, the pkexec takeover, the GNOME and KDE menu entries, are
precisely the ones no container will ever reach, which is what makes it a *desktop*
phase rather than a container with systemd in it. Recorded as a recommendation, not
scheduled: P0–P6 are not being widened here.

The remaining 7 are un-automatable, though not all for the same kind of reason, and
the distinction matters to anyone deciding what to fix:

- **Hardware that does not exist here.** 7.3 (USB, barred by the wireless-only lock)
  and 8.9 (a vendor hardware encoder the emulator does not have). No budget moves
  these; see spec §11.1.
- **A capability the Linux runner lacks.** 8.7 needs a browser that decodes H.265 in
  order to observe one being *offered*, and no browser in this runner does (finding
  8.11).
- **An app defect, not a testing limit.** 7.5's enrichment lives on a route the UI
  never calls (finding 7.6). It becomes an ordinary device row the day that is fixed.
- **A decision nobody has taken.** 20.4 and 20.5 wait on what "install for all users"
  and "uninstall" should even mean inside a container. 20.3 is a tombstone — the
  libfuse2 gate it checked no longer exists.

Six further rows are automatable with the tiers already built and simply have no
spec yet: 4.5 in the fast tier, 20.6, 20.8, 20.11 and 20.12 in the container tier,
and 20.10 in the device tier. They are the cheapest coverage left anywhere in this
document and are listed as their own bucket so they cannot be mistaken for residual
manual work.
