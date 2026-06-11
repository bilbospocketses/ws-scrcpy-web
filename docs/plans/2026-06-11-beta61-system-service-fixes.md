# beta.61 — Linux system-service fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. `git -C "C:/Users/jscha/source/repos/ws-scrcpy-web"`; branch `beta61-linux-service-fixes`; no push until all gates green. Each Rust task: `cross test`/`cross clippy -D warnings` (Docker; plain cargo has no Linux linker). Each TS task: `npm test -- <file>` AND `npx tsc --noEmit` (0 errors — vitest does NOT type-check). Verify each task's on-disk diff + the gate yourself; IDE mid-edit diagnostics are often stale.

**Goal:** Fix the two runtime-confirmed Linux system-service bugs from the beta.60 #9 smoke — `/var/opt` never gets `var_lib_t` (the SELinux gate), and the uninstall teardown helper core-dumps — plus the two robustness gaps they exposed.

**Architecture:** The SELinux labeling is reworked from a fragile `&&` chain (where one `semanage` failure short-circuits the rest) into independent `;`-separated steps that can't short-circuit, across all three builders. The teardown spawn gains the `--setenv=DATA_ROOT` the install handoff already has. The launcher gains a non-panicking data-root resolver for best-effort callers. The uninstall UI verifies completion instead of assuming it.

**Tech Stack:** TypeScript server (`src/server`, vitest), Rust launcher + common crate (`launcher`/`common`, `cross`), frontend (`src/app`).

**Spec:** `docs/specs/2026-06-11-beta61-system-service-fixes-design.md`.

---

## File structure

- `src/server/service/SystemdClient.ts` — rework the fcontext labeling in `buildSystemInstallScript` (:365), `buildMachineWideInstallScript` (:434), `buildSystemMigrationScript` (:593). One responsibility: build the privileged install/migration shell scripts.
- `src/server/service/SystemdClient.test.ts` — update the existing `buildSystemInstallScript` fcontext assertions (drop bin_t-add + chcon; add var_lib_t + restorecon-/var/opt + independence); add equivalents for the other two builders.
- `src/server/api/ServiceApi.ts` — add `--setenv=DATA_ROOT` to the system-scope teardown spawn in `handleUninstall` (:687-690).
- `src/server/__tests__/ServiceApi.test.ts` — assert the teardown spawn arg-vector carries `--setenv=DATA_ROOT=/var/opt/ws-scrcpy-web`.
- `common/src/config.rs` — add `try_data_root_from_env() -> Option<PathBuf>` (non-panicking sibling of `data_root_from_env`).
- `launcher/src/main.rs:76` — use `try_data_root_from_env()` for the best-effort `service.log` rotation.
- `src/app/...` (frontend) — uninstall-completion verification (surface a timeout failure instead of assuming "removed").

---

## Task 1: fcontext rework — `buildSystemInstallScript`

**Files:**
- Modify: `src/server/service/SystemdClient.ts:349-365` (the `steps.push( … fcontext element … )`)
- Test: `src/server/service/SystemdClient.test.ts` (the `describe('buildSystemInstallScript')` block, ~:62-73)

- [ ] **Step 1: Update the failing test.** In `SystemdClient.test.ts`, replace the body of the `it('prepares /opt, chmods the (already-staged) binary, labels bin_t, then installs the unit', …)` test (~:62) with assertions for the new behavior, and add a dedicated independence test:

```ts
it('labels /var/opt var_lib_t + restorecons both trees as independent steps (no && chain, no chcon)', () => {
    const script = buildSystemInstallScript(args);
    // var_lib_t add for the FHS state dir (the beta.60 gate that never ran)
    expect(script).toContain("semanage fcontext -a -t var_lib_t '/var/opt/ws-scrcpy-web(/.*)?'");
    // BOTH restorecons present
    expect(script).toContain('restorecon -Rv "/opt/ws-scrcpy-web"');
    expect(script).toContain('restorecon -Rv "/var/opt/ws-scrcpy-web"');
    // the redundant /opt bin_t re-add is GONE (it short-circuited the chain on this Fedora)
    expect(script).not.toContain("semanage fcontext -a -t bin_t '/opt/ws-scrcpy-web(/.*)?'");
    // the chcon fallback is GONE (it masked the failure + only touched one file)
    expect(script).not.toContain('chcon -t bin_t');
    // var_lib_t add is NOT gated behind a bin_t step via && (independence)
    expect(script).not.toMatch(/bin_t[^;]*&&[^;]*var_lib_t/);
});
```

Also update the older `it('prepares /opt … labels bin_t …')` test: remove its `expect(script).toContain("semanage fcontext -a -t bin_t '/opt/ws-scrcpy-web(/.*)?'")` and `expect(script).toContain('chcon -t bin_t "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"')` lines (those behaviors are intentionally removed); keep the `restorecon -Rv "/opt/ws-scrcpy-web"`, unit-cp, and daemon-reload assertions.

- [ ] **Step 2: Run the test, verify it FAILS.**

Run: `npm test -- SystemdClient.test.ts`
Expected: FAIL — current script still contains the bin_t add + chcon and lacks the var_lib_t-`-a`/restorecon-/var/opt independence the new test asserts.

- [ ] **Step 3: Implement.** In `SystemdClient.ts`, replace the fcontext element pushed at :365 (and its leading comment block :350-364) with:

```ts
        // 2. SELinux labels — INDEPENDENT steps (`;`-separated, whole thing `|| true`)
        //    so no single `semanage` failure can short-circuit the rest (the beta.58/60
        //    #9 2.2/2.3 gate failure: the redundant `/opt` bin_t re-add's `-a` failed
        //    "already defined" AND `-m`-to-unchanged-type also failed, breaking the old
        //    `&&` chain before the var_lib_t add + both restorecons ever ran).
        //    `/opt` is ALREADY bin_t (machine-wide-first gate created the rule + ran
        //    restorecon at install) — so we do NOT re-add it; restorecon -Rv /opt below
        //    just relabels the freshly-copied deps (cp -a preserved data_home_t) using
        //    the existing rule. No chcon fallback (it masked failures + only relabeled
        //    one file).
        `( ${semanage} fcontext -a -t var_lib_t '${SYSTEM_STATE_DIR}(/.*)?' || ${semanage} fcontext -m -t var_lib_t '${SYSTEM_STATE_DIR}(/.*)?' ; ${restorecon} -Rv "${STAGED_SYSTEM_DIR}" ; ${restorecon} -Rv "${SYSTEM_STATE_DIR}" ) || true`,
```

(The `chcon` local at :308 may now be unused in this function — if `buildSystemInstallScript` no longer references it, remove the `const chcon = binTool('chcon');` line to keep tsc/biome clean. Check: it is only used in this fcontext element.)

- [ ] **Step 4: Run the test + type-check, verify PASS.**

Run: `npm test -- SystemdClient.test.ts` → Expected: PASS
Run: `npx tsc --noEmit` → Expected: 0 errors

- [ ] **Step 5: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/service/SystemdClient.ts src/server/service/SystemdClient.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "fix(linux): var_lib_t labeling can no longer be short-circuited (system install)"
```

---

## Task 2: fcontext rework — machine-wide + migration builders

**Files:**
- Modify: `src/server/service/SystemdClient.ts:434` (`buildMachineWideInstallScript`) and `:593` (`buildSystemMigrationScript`)
- Test: `src/server/service/SystemdClient.test.ts`

- [ ] **Step 1: Write failing tests.** Add to `SystemdClient.test.ts`:

```ts
describe('fcontext independence (machine-wide + migration)', () => {
    it('buildMachineWideInstallScript: restorecon /opt runs independently, no chcon, no && chain', () => {
        const script = buildMachineWideInstallScript(
            { sourceAppImage: '/home/u/Downloads/App.AppImage', version: '0.1.30-beta.61' },
        );
        expect(script).toContain('restorecon -Rv "/opt/ws-scrcpy-web"');
        expect(script).not.toContain('chcon -t bin_t');
        expect(script).not.toMatch(/-a -t bin_t[^;]*&&[^;]*restorecon/);
    });
    it('buildSystemMigrationScript: var_lib_t add + restorecon independent, no chcon', () => {
        const script = buildSystemMigrationScript(
            { unitTmpPath: '/t', unitPath: '/u', name: 'WsScrcpyWeb', seedConfigJson: '{}' },
        );
        expect(script).toContain("semanage fcontext -a -t var_lib_t '/var/opt/ws-scrcpy-web(/.*)?'");
        expect(script).toContain('restorecon -Rv "/var/opt/ws-scrcpy-web"');
        expect(script).not.toContain('chcon -t var_lib_t');
        expect(script).not.toMatch(/var_lib_t[^;]*&&[^;]*restorecon/);
    });
});
```

(Check the exact required args for both builders by reading their signatures at the top of each function; adjust the test arg objects to match. `buildMachineWideInstallScript` takes `{ sourceAppImage, version, iconSource? }`; `buildSystemMigrationScript` takes `{ unitTmpPath, unitPath, name, seedConfigJson }`.)

- [ ] **Step 2: Run, verify FAIL.** `npm test -- SystemdClient.test.ts` → FAIL (both still use the `&&`-chain + chcon).

- [ ] **Step 3: Implement.**

In `buildMachineWideInstallScript` (:434), replace the fcontext element with (keep the bin_t add — this is the FIRST install that creates the `/opt` rule — but `;`-separate restorecon and drop chcon):

```ts
        `( ${semanage} fcontext -a -t bin_t '${STAGED_SYSTEM_DIR}(/.*)?' || ${semanage} fcontext -m -t bin_t '${STAGED_SYSTEM_DIR}(/.*)?' ; ${restorecon} -Rv "${STAGED_SYSTEM_DIR}" ) || true`,
```

In `buildSystemMigrationScript` (:593), replace the fcontext element with:

```ts
        `( ${semanage} fcontext -a -t var_lib_t '${SYSTEM_STATE_DIR}(/.*)?' || ${semanage} fcontext -m -t var_lib_t '${SYSTEM_STATE_DIR}(/.*)?' ; ${restorecon} -Rv "${SYSTEM_STATE_DIR}" ) || true`,
```

Remove any now-unused `const chcon = …` in `buildSystemMigrationScript` (:563) if it's no longer referenced.

- [ ] **Step 4: Run + type-check, verify PASS.** `npm test -- SystemdClient.test.ts` → PASS; `npx tsc --noEmit` → 0.

- [ ] **Step 5: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/service/SystemdClient.ts src/server/service/SystemdClient.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "fix(linux): same fcontext independence fix for machine-wide + migration builders"
```

---

## Task 3: teardown spawn passes `--setenv=DATA_ROOT`

**Files:**
- Modify: `src/server/api/ServiceApi.ts:687-690` (system-scope `runArgs`) + the `SYSTEM_STATE_DIR` import
- Test: `src/server/__tests__/ServiceApi.test.ts`

- [ ] **Step 1: Write the failing test.** In `ServiceApi.test.ts`, add a test that drives `handleUninstall` for a system-scope install with an injected `spawnDetached` spy + a service client whose `getInstalledScope` resolves `'system'`, running as root (`process.getuid` stubbed to return 0), and asserts the captured args:

```ts
it('system-scope uninstall teardown spawn sets DATA_ROOT (else the helper panics in data_root_for_linux)', async () => {
    const spawned: { cmd: string; args: string[] }[] = [];
    const api = new ServiceApi(
        () => ({
            supported: true,
            platform: 'linux',
            client: { getInstalledScope: async () => 'system' } as any,
        }),
        () => 'system',
        () => true,
        (cmd, args) => { spawned.push({ cmd, args }); },
    );
    const origGetuid = process.getuid;
    (process as any).getuid = () => 0;
    try {
        const { req, res } = makeReqRes('POST', '/api/service/uninstall'); // use the file's existing req/res helper
        await (api as any).handleUninstall(req, res);
    } finally {
        (process as any).getuid = origGetuid;
    }
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toContain('--setenv=DATA_ROOT=/var/opt/ws-scrcpy-web');
    // sanity: still the teardown helper invocation
    expect(spawned[0]!.args).toContain('--linux-service-teardown');
});
```

(Read the top of `ServiceApi.test.ts` for the existing request/response construction helper and the `ServiceApi` constructor signature — mirror them rather than the placeholder `makeReqRes` above.)

- [ ] **Step 2: Run, verify FAIL.** `npm test -- ServiceApi.test.ts` → FAIL — current `runArgs` has no `--setenv=DATA_ROOT`.

- [ ] **Step 3: Implement.** In `ServiceApi.ts`, ensure `SYSTEM_STATE_DIR` is imported from `../service/SystemdClient` (add to the existing import if absent). In `handleUninstall`'s system-scope branch (:687-690), change `runArgs` to insert the setenv right after `teardownUnit`:

```ts
                const optHelper = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_HELPER}`;
                const runArgs = [
                    '--system', '--collect', teardownUnit,
                    // DATA_ROOT is MANDATORY: a `systemd-run --system` transient unit has no
                    // HOME/XDG either, so without it the launcher panics in
                    // data_root_for_linux (config.rs) at startup — before running any
                    // teardown command (beta.60 #9 5.1 core-dump). Mirrors the install handoff.
                    `--setenv=DATA_ROOT=${SYSTEM_STATE_DIR}`,
                    optHelper, '--linux-service-teardown', '--scope', 'system', '--unit', WS_SCRCPY_SERVICE_NAME,
                ];
```

- [ ] **Step 4: Run + type-check, verify PASS.** `npm test -- ServiceApi.test.ts` → PASS; `npx tsc --noEmit` → 0.

- [ ] **Step 5: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/api/ServiceApi.ts src/server/__tests__/ServiceApi.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "fix(linux): system-service uninstall teardown sets DATA_ROOT (no more launcher panic)"
```

---

## Task 4: non-panicking `try_data_root_from_env`

**Files:**
- Modify: `common/src/config.rs` (add the fn + tests near `data_root_from_env` :64)

- [ ] **Step 1: Write the failing tests.** Add to the `#[cfg(test)] mod tests` in `config.rs`:

```rust
    #[test]
    fn try_data_root_from_env_is_none_when_nothing_set() {
        // Non-panicking sibling for best-effort callers (e.g. service.log rotation
        // in a teardown transient unit that has no DATA_ROOT/HOME/XDG).
        assert_eq!(try_data_root_for_linux(None, None, None), None);
    }
    #[test]
    fn try_data_root_from_env_is_some_when_data_root_set() {
        assert_eq!(try_data_root_for_linux(Some("/explicit/root"), None, None), Some(PathBuf::from("/explicit/root")));
    }
```

- [ ] **Step 2: Run, verify FAIL.** `cross test -p ws-scrcpy-web-common --target x86_64-unknown-linux-gnu try_data_root` (adjust crate name if the common crate is named differently — check `common/Cargo.toml`). Expected: FAIL — `try_data_root_for_linux` not defined.

- [ ] **Step 3: Implement.** In `config.rs`, add a pure non-panicking resolver + the env wrapper (place after `data_root_for_linux`, ~:59):

```rust
/// Non-panicking sibling of `data_root_for_linux` for BEST-EFFORT callers (e.g.
/// the service.log rotation at launcher startup, which a teardown transient unit
/// hits without any DATA_ROOT/HOME/XDG). Returns `None` instead of panicking when
/// none is set — the hard panic stays in `data_root_for_linux` for the supervisor
/// path, where a persistent data root is genuinely mandatory.
pub fn try_data_root_for_linux(
    data_root: Option<&str>,
    xdg_data_home: Option<&str>,
    home: Option<&str>,
) -> Option<PathBuf> {
    if data_root.filter(|s| !s.is_empty()).is_none()
        && xdg_data_home.filter(|s| !s.is_empty()).is_none()
        && home.filter(|s| !s.is_empty()).is_none()
    {
        return None;
    }
    Some(data_root_for_linux(data_root, xdg_data_home, home))
}

/// Non-panicking env wrapper. `Some` when a data root is resolvable, `None` when
/// nothing is set (best-effort callers skip rather than crash).
pub fn try_data_root_from_env() -> Option<PathBuf> {
    if cfg!(windows) {
        return data_root_from_env();
    }
    let data_root = std::env::var("DATA_ROOT").ok();
    let xdg = std::env::var("XDG_DATA_HOME").ok();
    let home = std::env::var("HOME").ok();
    try_data_root_for_linux(data_root.as_deref(), xdg.as_deref(), home.as_deref())
}
```

- [ ] **Step 4: Run + clippy, verify PASS.** `cross test -p <common-crate> --target x86_64-unknown-linux-gnu try_data_root` → PASS; `cross clippy -p <common-crate> --target x86_64-unknown-linux-gnu -- -D warnings` → clean.

- [ ] **Step 5: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add common/src/config.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(common): try_data_root_from_env — non-panicking resolver for best-effort callers"
```

---

## Task 5: launcher startup uses `try_data_root_from_env`

**Files:**
- Modify: `launcher/src/main.rs:75-81` (the `service.log` rotation block)

- [ ] **Step 1: Read** `launcher/src/main.rs:75-81` to confirm the exact current block (the `if let Some(data_root) = common::config::data_root_from_env() { copy_truncate_if_large(... service.log ...) }`).

- [ ] **Step 2: Implement.** Change the call from the panicking `data_root_from_env()` to the new `try_data_root_from_env()`:

```rust
    // Best-effort service.log rotation — MUST NOT panic. A teardown helper spawned
    // via `systemd-run --system` has no DATA_ROOT/HOME/XDG; the panicking
    // data_root_from_env() would abort it here (beta.60 #9 5.1) before it reached
    // the teardown dispatch below. try_ returns None → we simply skip the rotation.
    #[cfg(target_os = "linux")]
    if let Some(data_root) = common::config::try_data_root_from_env() {
        common::log::copy_truncate_if_large(
            &data_root.join("logs").join("service.log"),
            10 * 1024 * 1024,
        );
    }
```

- [ ] **Step 3: Build + clippy, verify.** `cross build -p ws-scrcpy-web-launcher --target x86_64-unknown-linux-gnu` → compiles; `cross clippy -p ws-scrcpy-web-launcher --target x86_64-unknown-linux-gnu -- -D warnings` → clean. (main() itself isn't unit-tested; the behavior is covered by Task 4's resolver test + the #9 re-smoke.)

- [ ] **Step 4: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/main.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "fix(linux): launcher startup log-rotation no longer panics without DATA_ROOT"
```

---

## Task 6: UI honesty — uninstall verifies completion

**Files:**
- Read first: the frontend service-uninstall flow + the existing install/reconnect poll. Grep `src/app` for `service/uninstall`, `shutting-down`, `classifyInstallPoll`, `reconnect`, and the Settings service-section uninstall handler.
- Modify: the frontend uninstall handler (found above) + its test.

- [ ] **Step 1: Read + map** the current flow: where the frontend POSTs `/api/service/uninstall`, what it does with the `status: 'shutting-down'` response, and the existing post-action reconnect/relaunch poll (the spec notes user-scope already shows "this page will reconnect shortly"). Identify the smallest extension point that adds a **timeout-surfacing** completion check for the system-scope case.

- [ ] **Step 2: Write the failing test** for the completion classifier — model it on the existing install-poll test. Assert: a `/api/service/status` response showing the service gone (`status` not running / `getInstalledScope` null) → resolves "done"; still-present after the timeout budget → resolves a surfaced failure (not a silent success).

- [ ] **Step 3: Run, verify FAIL.** `npm test -- <that test file>` → FAIL.

- [ ] **Step 4: Implement** the completion poll/classifier, reusing the install-poll affordance rather than duplicating it. Keep the backend `shutting-down` response as-is.

- [ ] **Step 5: Run + type-check, verify PASS.** `npm test -- <that test file>` → PASS; `npx tsc --noEmit` → 0.

- [ ] **Step 6: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/...  # the touched files
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "fix(ui): system-service uninstall verifies completion instead of assuming success"
```

---

## Task 7: full gate + CHANGELOG

- [ ] **Step 1: Full gates.**

```bash
npx tsc --noEmit                 # 0 errors
npm test                         # full vitest suite green
cross test --target x86_64-unknown-linux-gnu          # launcher + common green
cross clippy --target x86_64-unknown-linux-gnu -- -D warnings   # clean
npm run build                    # webpack clean
```

Paste each result. Do NOT proceed to push/release until all are green.

- [ ] **Step 2: CHANGELOG.** Add entries under `## [Unreleased]` in `CHANGELOG.md` (NEVER a pre-written `## [0.1.30-beta.61]` heading — `bump-version.mjs` promotes Unreleased and aborts if the version heading already exists):

```markdown
### Fixed
- Linux system-service install now reliably labels `/var/opt` `var_lib_t` — the SELinux labeling steps are independent so one `semanage` quirk can no longer short-circuit the rest (the `/opt` bin_t re-add that failed "already defined" on a pre-existing rule). Also relabels the copied dependencies `bin_t`.
- Linux system-service uninstall now actually tears the service down — the teardown helper spawn was missing `DATA_ROOT`, so it core-dumped at startup before running. The launcher's best-effort startup log-rotation no longer panics when `DATA_ROOT`/`HOME`/`XDG_DATA_HOME` are unset.
- The in-app uninstall reports success only once the service is actually gone.
```

- [ ] **Step 3: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add CHANGELOG.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs(changelog): beta.61 system-service fixes"
```

---

## After implementation

- Open a `release:beta` PR (the auto-release Mode 1 cuts the bump PR — do NOT manually bump). Squash-merge.
- **The real gate is the Fedora #9 re-smoke on the published beta.61** (exit criteria in the spec): 2.2 `var_lib_t`, 2.3 both rules, deps `bin_t`, zero AVC; 5.1 uninstall actually removes + relaunches local; 5.4 fcontext empty. Then resume the smoke past #9.
