# System-service state dir → `/var/lib` (SELinux fix) — Design

**Date:** 2026-06-12 · **Branch:** `system-state-var-lib` → beta.64 · **Status:** Approved (brainstorm 2026-06-12)

## Problem

The Linux **system-scope** service install fails on Fedora at:

```
semanage fcontext -a -t var_lib_t '/var/opt/ws-scrcpy-web(/.*)?'
  → ValueError: File spec … conflicts with equivalency rule '/var/opt /opt'
```

**Root cause (triple-confirmed):** `/var/opt → /opt` is a **stock Fedora SELinux default equivalency**
(`/etc/selinux/targeted/contexts/files/file_contexts.subs_dist:38`; the local `file_contexts.subs` is empty —
not ours; our `.ts`/`.rs` only ever emit `-t` type rules, never `-e`). Under that equivalency `semanage`
**refuses** any custom label rule beneath `/var/opt`, and the path inherits `/opt`'s label:

- `matchpathcon /var/opt/ws-scrcpy-web` → `bin_t`
- captured evidence bundle: `/var/opt/ws-scrcpy-web/config.json` actually labeled `bin_t`.

So the system-service install has been **impossible on SELinux distros since Path 2 (beta.41)** — #9 never
passed on Fedora. The beta.57 `usr_t` / beta.58 `-a||-m` / beta.61 independent-steps "fixes" all just rearranged
an un-addable command. It evaded CI because `SystemdClient.test.ts` asserts the generated script *string*
(`toContain("semanage … var_lib_t …")`), never that semanage *succeeds* — CI has no SELinux.

## Decision

Move the system-service **writable state** dir:

```
/var/opt/ws-scrcpy-web  →  /var/lib/ws-scrcpy-web
```

and **delete the `semanage … var_lib_t` step entirely** — `/var/lib` defaults to `var_lib_t` via the policy's
built-in `/var/lib(/.*)?` rule (proven: `matchpathcon /var/lib/ws-scrcpy-web → var_lib_t`). A guarded
`restorecon -Rv /var/lib/ws-scrcpy-web` stays as a belt-and-suspenders label.

**Unchanged:** the binary + deps stay at `/opt/ws-scrcpy-web` (`bin_t`) — the root service execs node/adb from
there and `bin_t` is correct for executables. Only `config.json` + `logs/` move.

**Works across the support matrix:**

- **Red Hat (Fedora/RHEL/Rocky/Alma):** `/var/lib(/.*)? → var_lib_t` is a built-in default; the dir is labeled
  `var_lib_t` on creation — no custom rule, no equivalency to collide with.
- **Canonical (Ubuntu/Debian):** AppArmor, not SELinux; we ship no profile → `/var/lib/ws-scrcpy-web` is a plain
  root-writable dir. (The `semanage` steps were already skipped on non-SELinux hosts.)

**Forward-only — no migration.** Existing `/var/opt` (or beta.40 `/opt/.../data`) system installs are NOT
migrated (they only ever worked on non-SELinux Ubuntu anyway). All migration machinery is **deleted**.

## Scope (file-by-file)

**TS — server:**
- `SystemdClient.ts`: `SYSTEM_STATE_DIR` → `/var/lib/ws-scrcpy-web`; `buildSystemInstallScript` drops the
  `semanage … var_lib_t` add (keep BOTH `restorecon`s — `/opt` relabels copied deps to `bin_t`, `/var/lib`
  asserts `var_lib_t`); delete `LEGACY_SYSTEM_DATA_DIR` + `buildSystemMigrationScript`; drop the now-unused
  `semanage` local in the install builder.
- `ServiceApi.ts`: remove the `/api/service/migrate-system` handler + `systemServiceNeedsMigration` +
  `serviceMigrationNeeded` wiring.
- `ServiceClient.ts`, `common/ServiceEvents.ts`, `app/index.ts`: remove the migration field / comment / UI offer.

**Rust — launcher:**
- `linux_service.rs`: teardown dirs `/var/opt` → `/var/lib`; the fcontext-removal specs drop the `/var/opt`
  var_lib_t spec (there is no rule now — keep only `/opt` bin_t); `AppConfig::load` paths → `/var/lib`.
- `linux_app_uninstall.rs`: `FCONTEXT_SPECS` (keep `/opt`, drop `/var/opt` + legacy); `/var/opt` keep/wipe → `/var/lib`.
- `main.rs:175`: `AppConfig::load` → `/var/lib`.

**Docs / tooling:**
- `clear-install.sh`: `VAR_OPT_DIR` → `/var/lib/ws-scrcpy-web`; fcontext specs keep `/opt` + the legacy
  `/var/opt` + `/opt/.../data` as harmless `-d` cleanup.
- Smoke docs (checklist/full/runbook): **2.2** `ls -Z /var/lib/ws-scrcpy-web → var_lib_t`; **2.3** only the
  `/opt` bin_t rule exists (`/var/lib` needs NO custom rule — `var_lib_t` by default); **5.4** empty after
  uninstall; remove the **6.7** legacy-migration row.
- `TECHNICAL_GUIDE.md`, `CHANGELOG.md` (`[Unreleased]` Fixed).

## Tests

- Flip `/var/opt` → `/var/lib` in `SystemdClient.test.ts`, `ServiceApi.test.ts`, `systemScopePaths.test.ts`,
  launcher `SystemdClient.test.ts`, and the Rust `linux_service.rs` / `linux_app_uninstall.rs` tests.
- **New guard (closes the gap that hid this 4×):** assert `buildSystemInstallScript` emits **NO** `var_lib_t`
  and **NO** `/var/opt`.
- Delete the migration tests (`buildSystemMigrationScript`, `migrate-system`, `systemServiceNeedsMigration`),
  and the Rust `/var/opt` var_lib_t fcontext-removal assertion.
- **Real proof = the VM smoke #9 2.2** (`ls -Z` shows `var_lib_t`) — the only thing that verifies runtime SELinux.

## Out of scope

- System-service **dep auto-update** SELinux behavior (deps in `/opt` are `bin_t`; a root service writing
  updated deps may need a relabel) — a separate concern, exercised by smoke Module 6 (6.6); not touched here.

## Release

`release:beta` PR → auto-bump → **beta.64**; delete the **beta.63** release once beta.64 posts (keep ALL tags).
Re-smoke **#9 only** on the Fedora VM.
