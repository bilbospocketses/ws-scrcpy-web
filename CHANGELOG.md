# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **CodeQL §28 triage — 3 fixes + 6 dismissals to clear all 9 pre-existing alerts surfaced by the advanced-setup migration.** All 9 alerts had been visible in the Security tab during the default-setup era; the §27 migration put them back in front of us. Per user direction *"Today, EVERYTHING needs a solid security baseline"*, all 9 were triaged in this commit pair.
  - **`src/server/goog-device/Device.ts:255` — `.replace('\r', '')` → `.replaceAll('\r', '')`.** Fixes CodeQL alert #12 (`js/incomplete-sanitization`, high). Intent was to strip ALL trailing CRs from adb command output; the single `.replace` only stripped the first. Downstream is a `list.includes(parentPid)` check; impact was low (incorrect false-negative on PPID match against the `pidof init` output) but a real correctness bug.
  - **`.github/workflows/node-pty-prebuilds.yml` — added workflow-level `permissions: contents: read`.** Closes CodeQL alerts #3 (precheck job) + #5 (build job). The `publish` (line 176) and `open-issue-on-failure` (line 273) per-job overrides from the Tier 1 hardening pass are unaffected — they declare their own writes-needed scopes (contents:write / issues:write) and inherit nothing problematic from the new workflow-level default.
  - **6 alerts dismissed via API with documented rationale** (state=dismissed, dismissed_reason + dismissed_comment recorded on each):
    - **Alerts #7, #8 (`js/request-forgery`, critical, `src/app/client/ManagerClient.ts:41,58`):** dismissed as `won't fix`. The flagged `new WebSocket(url)` calls take a URL built from query parameters (`hostname`, `port`, `pathname`) that are by-design user-controlled — the entire product premise is "specify a remote ws-scrcpy-web server via URL params." Restricting these would break the product. CodeQL's `js/request-forgery` is server-side-SSRF-tuned; misfires for client-side WS-to-user-specified-URL. Rationale recorded in the alert metadata.
    - **Alerts #9, #10, #11 (`js/tainted-format-string`, high, `src/app/googDevice/client/ConfigureScrcpy.ts:272,275,340`):** dismissed as `false positive`. The flagged lines pass JS template literals to `console.log`/`console.error`; template literals are JS-native interpolation, not printf-style format strings. `console.log` does NOT `%s`-substitute the interpolated values. Alert #340's "format string" has no interpolation at all (`\`Display id from VideoSettings and DisplayInfo don't match\``). The rule is over-eager for JS.
    - **Alert #13 (`js/incomplete-url-substring-sanitization`, high, `src/server/__tests__/dependencyManager.update.test.ts:29`):** dismissed as `used in tests`. The flagged `url.includes('api.github.com')` is in a test stub for `global.fetch` that returns a mock GitHub-API response. Substring match is intentional — the stub needs to cover any URL format the dependency manager might construct for GitHub API calls. Strict host parsing would defeat the test's purpose.
  - **Net post-§28 state:** 0 open CodeQL alerts on `main`. The 3 fixed alerts closed automatically when CodeQL re-scanned after PR merge; the 6 dismissed alerts are recorded as `dismissed` with their rationale preserved in alert metadata + GitHub Security tab.

- **CodeQL — migrated from default setup to advanced setup; gain Rust coverage on both Linux and Windows.** Default setup is GitHub-managed and supports a fixed language list (`actions, c-cpp, csharp, go, java-kotlin, javascript-typescript, python, ruby, swift`) that does NOT include Rust — verified directly today (`PATCH ... languages[]=rust` returns `422 Invalid request: rust is not a possible value`). Advanced setup means we own a `.github/workflows/codeql.yml` workflow file and pick the languages + build modes + triggers + schedule explicitly; in exchange Rust analysis is available. User direction: "Today, EVERYTHING needs a solid security baseline, so not evaluating the code with the automated runners is a no-op." Migration ships in this commit. New file `.github/workflows/codeql.yml`:
  - **Languages + matrix:** `actions` + `javascript-typescript` + `rust` (×2). Rust runs on **both** `ubuntu-latest` AND `windows-latest` runners because the launcher + tray code is heavily `cfg(windows)`-gated (14 `cfg(windows)` blocks in `launcher/src` across `main.rs`, `hooks.rs`, `paths.rs`, `single_instance.rs`, `elevated_runner.rs`; the `tray` crate's `windows` dep is unconditional in the dep tree but only meaningful on Windows targets). Single-OS Rust scanning would miss the bulk of the security-relevant code.
  - **Build mode:** `none` for all four matrix entries. Empirically verified during PR #19 first push that Rust does NOT support `autobuild` in CodeQL 2.25.4 — the error is explicit: *"Rust does not support the autobuild build mode. Please try using one of the following build modes instead: none."* (Source-only extraction; CodeQL reads `.rs` files directly without invoking `cargo build`.) Faster than autobuild would have been + zero toolchain setup needed. Implication for the two-OS Rust matrix: with `build-mode: none`, both OS legs technically extract the same source files (cfg gates don't filter at source-extraction time). We keep both for now because future CodeQL versions may add per-target extraction, and extraction-only cost is small. Revisit when CodeQL ships proper Rust autobuild + target-platform support.
  - **SHA pinning:** `github/codeql-action/init@458d36d7d4f47d0dd16ca424c1d3cda0060f1360 # v3` and `analyze@458d36d7d4f47d0dd16ca424c1d3cda0060f1360 # v3`. Dependabot's `github-actions` ecosystem covers future bumps.
  - **Triggers:** `push` to `main`, `pull_request` to `main`, weekly cron Monday 09:00 ET (13:00 UTC during DST) — matches `dependabot.yml`'s cadence.
  - **Permissions:** workflow-level `contents: read`; per-job `security-events: write` (SARIF upload) + `packages: read` + `actions: read` + `contents: read`.
  - **Category labels:** `/language:actions`, `/language:javascript-typescript`, `/language:rust-linux`, `/language:rust-windows` — distinct labels for the two Rust runs so SARIF results are aggregated correctly.
  - **Default-setup disable (applied via API after merge, not in this commit):** `DELETE /repos/.../code-scanning/default-setup` to stop the old GitHub-managed scans. Brief overlap during the PR window is acceptable (just duplicate analyses, not a correctness issue).
  - **Cost accepted:** CI minutes (Rust autobuild on both platforms adds ~5-10 min per push/PR/cron run) + owning the workflow config + adopting future CodeQL features manually rather than getting them automatically via default setup. Per user direction, security posture takes precedence over CI latency.
  - **`feedback_do_that_thing.md` tweak (filed separately in `~/.claude` repo):** the "do that thing" SOP gains a new step-1 sub-bullet: in any Rust-containing repo with advanced-setup CodeQL, the SOP must verify the `codeql.yml` SHA pins are current and the most recent CodeQL run on `main` succeeded. This is the maintenance discipline the advanced-setup choice requires.

## [0.1.25-beta.6] - 2026-05-18

### Security

- **Tier 4 hardening — workflow least-privilege + Sigstore build attestations.** Audited ws-scrcpy-web's lockdown against the Control Menu repo (which today represents the canonical hardening baseline across my projects) and closed four concrete gaps in the GitHub Actions workflows:
  - **`.github/workflows/ci.yml`** — added workflow-level `permissions: contents: read`. Previously inherited the repo default; making it explicit follows the same least-privilege pattern the other workflows use and removes ambiguity for new jobs added later.
  - **`.github/workflows/release.yml`** — added per-job `permissions:` blocks to `prepare`, `build-windows`, and `build-linux` (the `publish` job already had one). `prepare` gets `contents: read`; both build jobs get `contents: read` + `id-token: write` + `attestations: write`. The id-token + attestations permissions are required for the Sigstore step in the next bullet — they live on the build jobs (not workflow-level) so other jobs in the workflow can't accidentally call attestation endpoints.
  - **`.github/workflows/release.yml`** — added `actions/attest-build-provenance@a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32 # v4.1.0` steps to both build jobs. `build-windows` attests the MSI + Portable.zip + nupkg (the three Windows release artifacts); `build-linux` attests the AppImage. Attestations link each artifact to the workflow run + commit + actor and are Sigstore-signed using a workflow OIDC token. Downstream consumers can verify via `gh attestation verify <artifact> --repo bilbospocketses/ws-scrcpy-web`. Mirrors Control Menu's identical pattern at the same SHA pin. When a code-signing path (Authenticode for Windows; the unselected Linux signer slot for AppImage) is wired in, the attestation will then cover the signed artifact rather than the unsigned one — attestation subject is the file content at step-evaluation time.
  - **Branch protection ruleset additions (applied via API after merge, not in this commit)**: `pull_request` rule added to `Protect main` ruleset (formal PR-required gate, complementing the existing `required_status_checks`-driven de-facto PR workflow); new `Protect release tags` ruleset created targeting `refs/tags/v*` with `deletion` + `non_fast_forward` rules, preventing release-tag deletion or rewrite. Both mirror Control Menu's ruleset shape.
- **CodeQL Rust coverage gap surfaced.** Investigation of today's claim that CodeQL was scanning `[actions, javascript-typescript, rust]` revealed that (a) the actual default-setup config has never included Rust (today's PATCH attempting to add it returned `422 Invalid request: rust is not a possible value`), and (b) the CodeQL default-setup supported-language list is `{actions, c-cpp, csharp, go, java-kotlin, javascript-typescript, python, ruby, swift}` — Rust is NOT in it. Adding Rust scanning would require migrating from default-setup to advanced-setup (custom `codeql.yml` workflow). The CHANGELOG entry from earlier today overstated the Rust coverage; reality is the launcher / tray Rust code (~few hundred lines each, ~mostly bindings into Node-side IPC) is unscanned by CodeQL. Clippy with `-D warnings` runs in `ci.yml` for lint-grade signal; CodeQL-grade taint analysis is the gap. Logged as a follow-up TODO; decision pending whether the surface justifies the migration cost.

## [0.1.25-beta.5] - 2026-05-18

### Changed

- **`.github/workflows/release.yml` — `actions/setup-dotnet` v4.3.1 → v5.2.0 (SHA-pinned) + `dotnet-version` 9.x → 10.x in both `build-windows` and `build-linux` jobs.** Two motivations: (1) brings the action up to its current major (only breaking change in v5.0.0 is the action's internal Node 24 runtime, which GitHub-hosted runners already satisfy); (2) bumps the SDK from .NET 9 (STS, end-of-life Nov 2026) to .NET 10 (current LTS, end-of-life Nov 2028) — consistent with Control Menu's same upgrade landed 2026-05-09. `vpk` (Velopack 0.0.1589-ga2c5a97) is a global tool installed via `dotnet tool install -g`; it runs on the SDK's runtime support stack, and .NET 10 SDK ships runtimes for older TFMs. **Supersedes Dependabot PR #11** which only proposed the setup-dotnet bump in isolation. Validation: signed commit on a feature branch → PR with `build-and-test` green → squash-merge → fresh beta tag fires `release.yml` end-to-end exercising both Windows and Linux build legs.

### Security

- **Repo hardening — Tier 3: CodeQL, required CI on main, SSH signed commits, Dependabot triage.** Continuation of the multi-tier hardening pass.
  - **CodeQL code scanning enabled** via API default setup (`PATCH /code-scanning/default-setup`, `query_suite: default`). Auto-detected languages: actions, javascript-typescript, rust. All three Analyze jobs (`Analyze (javascript-typescript)`, `Analyze (actions)`, `Analyze (rust)`) ran on the latest main commit with conclusion `success` — first scan baseline clean. Free for public repos; no workflow file authored (default setup is GitHub-managed).
  - **`build-and-test` (from `ci.yml`) added as a required status check on `main`** via PUT `/rulesets/16554336`. The "Protect main" ruleset now has 4 rules: `deletion`, `non_fast_forward`, `required_linear_history`, `required_status_checks`. Direct pushes to main are now blocked when CI hasn't completed successfully on the head commit — effectively requires PR workflow for code changes.
  - **PR workflow adopted for ws-scrcpy-web** as a consequence of the previous bullet. Enabled `allow_auto_merge` at repo level so `gh pr merge --auto` queues PRs for merge once required checks pass. Workflow change vs. solo-no-PR default: every code change goes through a branch → PR → CI green → merge cycle. Direct push to main is still possible for admin-bypass-able emergencies but blocked by default.
  - **SSH commit signing configured locally** with a dedicated ed25519 keypair (`~/.ssh/id_ed25519_signing`, no passphrase — disk-encryption-at-rest provides equivalent protection on this single-user machine). Git globals set: `gpg.format=ssh`, `user.signingkey=<path-to-pub-key>`, `commit.gpgsign=true`, `tag.gpgsign=true`. Public key registered on GitHub as a *Signing Key* (NOT an Authentication Key — separate list under Settings → SSH and GPG keys). This commit is the first signing-flow test. `require_signatures` rule deferred until first signed commit lands successfully — added in a follow-up.
  - **Dependabot triage** of the 7 PRs that fired on Dependabot's first scheduled scan after `.github/dependabot.yml` landed:
    - **Merged via `gh pr merge --rebase --auto`**: PR #8 (ws 8.20.0→8.20.1, patch), PR #9 (jsdom 29.0.2→29.1.1, minor), PR #10 (@biomejs/biome 2.4.12→2.4.15, patch), PR #12 (actions/github-script SHA bump on the v9.0.x line — Dependabot detected upstream tag movement, exactly the SHA-pin maintenance loop working as designed), PR #13 (vitest 4.1.4→4.1.6, patch). All 5 had `build-and-test` ✓ before merge.
    - **Closed**: PR #7 (@types/node 24.12.2→25.9.0 major bump). CI failed (tsc errors expected from a major @types bump); held for separate validation when we adopt Node 25 LTS as a target.
    - **Held open with comment**: PR #11 (actions/setup-dotnet 4.3.1→5.2.0 major bump). CI passes, but `ci.yml` doesn't exercise `release.yml` (only triggers on tag push), so passing CI doesn't validate the major action bump's behavior in the actual Windows + Linux release build jobs. Will pick up at the next release tag.

### Security

- **Repo hardening — branch protection, secret scanning, SHA-pinned GitHub Actions, Dependabot version updates, per-job least-privilege `permissions:` on `node-pty-prebuilds.yml`.** Surfaced from the GitHub UI banner *"Your main branch isn't protected"*. Five-part hardening:
  - **Branch protection ruleset on `main`** (ruleset ID 16554336, "Protect main"): blocks force-push (`non_fast_forward`), branch deletion (`deletion`), and merge commits (`required_linear_history` — codifies our existing FF-only practice). No required status checks gating — kept solo workflow friction zero.
  - **Secret Scanning + Push Protection enabled** at repo level. Free for public repos. Push Protection blocks `git push` from leaving the local machine when it detects a secret pattern.
  - **GITHUB_TOKEN permissions scoped per-job in `node-pty-prebuilds.yml`.** Workflow-level `contents: write` + `issues: write` block removed; `publish` job now gets `contents: write` only (for `softprops/action-gh-release` + the state-file commit push), `open-issue-on-failure` gets `issues: write` only (for failure-issue creation), and `precheck` + `build` matrix legs inherit the repo default `read`. `release.yml` already scoped this way (publish job only); `ci.yml` is read-only.
  - **All GitHub Actions SHA-pinned** across `ci.yml` (2 refs), `release.yml` (9 refs across 6 actions), `node-pty-prebuilds.yml` (10 refs across 6 actions), `docker-publish.yml.disabled` (1 ref). Format: `actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2`. Protects against a compromised action maintainer retagging a major (e.g., `v6`) to point at malicious code — a real supply-chain attack vector for the write-permission workflows. `dtolnay/rust-toolchain@stable` deliberately left as a rolling reference (upstream maintains it as a rolling alias).
  - **`.github/dependabot.yml` added** to track both `npm` and `github-actions` ecosystems weekly. Pairs with the SHA-pin step above — Dependabot keys on the `# vX.Y.Z` trailing comment to detect upstream tag movement and auto-PRs a SHA bump, solving the SHA-pin maintenance pain.

### Changed

- **GitHub Actions Node 24 migration — bumped all deprecated-Node-20 action pins ahead of the 2026-06-02 hard deadline.** Every workflow run since at least 2026-05-15 has emitted the deprecation banner: *"Actions will be forced to run with Node.js 24 by default starting June 2nd, 2026. Node.js 20 will be removed from the runner on September 16th, 2026."* Bumped pins across all three active workflow files (and the disabled docker-publish placeholder for consistency): `actions/checkout@v4` → `@v6` (latest stable v6.0.2; Node 24 default), `actions/setup-node@v4` → `@v6` (latest stable v6.4.0; Node 24 default), `actions/upload-artifact@v4` → `@v7` (latest stable v7.0.1; v7 made Node 24 the default), `actions/download-artifact@v4` → `@v8` (latest stable v8.0.1; v7 made Node 24 the default), `actions/github-script@v7` → `@v9` (latest stable v9.0.0; verified our inline `await github.rest.issues.create(...)` usage is unaffected by v9's ESM-only + `getOctokit` factory breaking changes — those only impact scripts that `require('@actions/github')` directly or redeclare `getOctokit` as a const/let), `softprops/action-gh-release@v2` → `@v3` (latest stable v3.0.0; v3 explicitly retargets the Node 24 Actions runtime). Total: 27 active references across `ci.yml`, `release.yml`, `node-pty-prebuilds.yml` plus 1 in `docker-publish.yml.disabled`. Untouched (not in deprecation banner): `actions/setup-dotnet@v4`, `dtolnay/rust-toolchain@stable`, `docker/login-action@v3`, `docker/build-push-action@v5`. Verified via post-merge CI run.

### Security

- **fast-uri bumped to 3.1.2 via package.json `overrides` — closes two Dependabot high-severity alerts on main.** Alerts: GHSA-q3j6-qgpj-74h6 (path traversal via percent-encoded dot segments, ≤3.1.0, fix in 3.1.1) and GHSA-v39h-62p7-jpjc (host confusion via percent-encoded authority delimiters, ≤3.1.1, fix in 3.1.2). fast-uri is a deeply nested transitive devDep (`mini-css-extract-plugin → schema-utils → ajv@8.18.0 → fast-uri@3.1.0`) — no direct dep to bump. Solution: top-level `overrides: { "fast-uri": "3.1.2" }` in package.json forces the nested ajv to resolve fast-uri to the patched version. ajv's `^3.0.0` range allows it. `npm ls fast-uri --all` confirms `fast-uri@3.1.2 overridden`; `npm audit` reports 0 vulnerabilities; vitest 684/684 + tsc clean.

### Fixed

- **node-pty prebuilds CI — VS 2026 detection on Windows x64 prior-LTS leg.** This morning's scheduled run (2026-05-18 12:33 UTC, workflow run 26033714786) failed at the `build (windows-latest, x64, prior)` matrix leg with `gyp ERR! find VS could not find a version of Visual Studio 2017 or newer to use`, blocking the entire publish job (other 9 legs passed). Auto-filed issue #5. Root cause: the `windows-latest` runner image was redirected to `windows-2025-vs2026` (MS-side migration, full cutover 2026-06-15) which ships VS 2026 (internal version 18) exclusively; Node 22 LTS ships npm 10.9.8 which bundles `node-gyp@11.5.0`, which only knows VS 2017/2019/2022 by hardcoded version mapping and rejects VS 2026 as `unknown version "undefined"`. **First fix attempt** (test run 26050335489, force-pushed away) installed `node-gyp@12.3.0` globally + set `npm_config_node_gyp` — failed identically because node-pty's install script is `node scripts/prebuild.js || node-gyp rebuild`, and `prebuild.js` does `require('node-gyp')` which resolves via Node module resolution to npm's BUNDLED node-gyp at `<npm-prefix>/node_modules/npm/node_modules/node-gyp` — globally-installed packages and `npm_config_node_gyp` are both bypassed by third-party scripts. **Working fix:** upgrade npm itself to `11.14.1` on Windows non-Alpine legs before the build step; npm 11.14.1 bundles `node-gyp@12.3.0` (added VS 2026 support in 12.1.0, 2025-11-12). Upgrading npm replaces the bundled node-gyp in place, so `require('node-gyp')` in third-party install scripts picks up the new version. Gating to all four Windows legs (x64 current+prior, arm64 current+prior) future-proofs the ARM runners against the same image migration whenever MS gets to them. Linux matrix legs use gcc/g++ via PATH and are unaffected.

## [0.1.25-beta.4] - 2026-05-15

### Fixed

- **scrcpy v4.0 wire-protocol port — device mirroring works again after the v4 dep update broke it.** Symptom: every device connection accepted, scrcpy-server started on device, log showed `Session ready: <Device> 2147483648x1920` (garbage width, height = the actual width). Canvas never sized correctly, persistent black screen, repeated `ECONNREFUSED 127.0.0.1:NNNNN` from browser retries. Confirmed by user that rolling the dep panel back to scrcpy-server 3.34 instantly restored mirroring. Root cause: scrcpy v4 added a 12-byte "session packet" wrapper between the codec ID and the width/height fields in the video socket header, AND shifted the media-packet flag bits down by one to make room for a new session-packet flag at MSB (verified against `scrcpy v4.0 Streamer.java`: `PACKET_FLAG_SESSION = 1L << 63`, `PACKET_FLAG_CONFIG = 1L << 62`, `PACKET_FLAG_KEY_FRAME = 1L << 61` — was `1L << 63 / 1L << 62` in v3). Our v3-era parser read 76 bytes, treated the session-packet flag word (`0x80000000`) as width and the actual width as height — exact match for the user's symptom. Two-file fix: `ScrcpyConnection.parseMetadata` now reads 80 bytes and pulls width @72 / height @76 with a sanity check on the session-packet flag MSB; `FrameReader` shifts CONFIG to bit 62 / KEY_FRAME to bit 61 / PTS mask to bits 0–60 and skips in-stream session packets (rotate/resize events the device sends — we don't expose rotation downstream today, deferred until requested). Fix-forward per the §17 binding decision: no version-branch backcompat for scrcpy 3.x; anyone who manually rolls back via dep panel after this lands will get a clear `expected session-packet flag MSB` error from `parseMetadata` rather than silent garbage.

- **Deliberate 2000ms hold before final event-loop drain on Ctrl+C** so PowerShell's prompt-redraw doesn't interleave with the shutdown log output. Real-shutdown now finishes in 10s of ms, which is faster than `npm.cmd`'s Ctrl+C acknowledgment to PowerShell — PS would redraw its prompt mid-output. A ref'd 2000ms `setTimeout` no-op in `exit()` holds the loop alive long enough for the prompt-redraw to settle on top of completed output. No correctness cost — the 10s watchdog backstops any real hang. Per user direction.

- **All `Stopping X` log lines now reach both console AND log file on Ctrl+C — child process is no longer killed mid-shutdown.** Real root cause finally pinned: `dev-supervisor.mjs` was calling `currentChild.kill(sig)` on receiving SIGINT, and per Node docs on Windows `subprocess.kill('SIGINT')` is `TerminateProcess` — equivalent to SIGKILL, not a graceful signal. The child was being nuked mid-`exit()` body. Evidence: even `fs.appendFileSync` writes to `ws-scrcpy-web.log` (synchronous!) didn't land — the log file showed nothing after `[AdbClient] daemon pre-warmed at startup` even though the console showed `[Server] Received signal SIGINT`. Console only got that one line because PowerShell's Ctrl+C had ALREADY broadcast CTRL_C_EVENT to the entire console process group, so the child's `process.on('SIGINT')` handler started running cleanly — TerminateProcess from the parallel supervisor.kill landed during the second log call. Fix: skip `currentChild.kill(sig)` on win32 in `dev-supervisor.mjs`. The console-group propagation already reaches the child gracefully; the supervisor's kill was both redundant (signal already delivered) AND destructive (it overrode the graceful handler mid-execution). POSIX path keeps `currentChild.kill(sig)` unchanged — real POSIX signals work properly. The 10s force-kill grace timer is unchanged on both platforms as the genuine-hang backstop. Earlier diagnostic instrumentation (active-handles dump from `36be51e`) + `setBlocking(true)` defensive layer (from `ef1abfc`) both stay, but the actual bug was upstream of where I was looking.

- **Server now exits cleanly within milliseconds on Ctrl+C — the 10s exit watchdog no longer fires.** Since b0dead3 (the 4-minute hang fix) the watchdog had been firing on EVERY shutdown, forcing `process.exit(0)` at the 10-second mark even on bare `npm start` with no browser, no devices, no interaction. Diagnosed by adding `process._getActiveHandles()` + `_getActiveRequests()` dump inside the watchdog `setTimeout` (which stays as permanent self-diagnosis for any future regression): every shutdown showed exactly 3 lingering handles — `ReadStream fd=0` (stdin) plus benign WriteStreams for fd=1/2. Root cause: the win32 `readline.createInterface({ input: process.stdin, output: process.stdout })` block in `index.ts` was a legacy workaround from pre-Node-10 days when `process.on('SIGINT')` didn't fire on Windows Ctrl+C. The `readline.createInterface()` call attaches keypress event listeners to `process.stdin`, putting it in flowing mode and ref'ing the ReadStream to the event loop — which prevented natural drain on `exit()` even after every service released cleanly. Modern Node (≥10, definitely 24.x) emits `process.on('SIGINT')` natively on Windows, so the readline workaround has been both unnecessary AND harmful. Removed: the `readline` import and the entire win32 `if` block. `process.on('SIGINT'/'SIGTERM')` (already registered two lines below the deleted block) is now the sole signal handler, and Ctrl+C still produces the expected `Received signal SIGINT` log line. Net: `Stopping...` lines fire, services release, event loop drains, process exits — typically within 50-100ms post-SIGINT instead of 10s.

- **adb daemon now has a single owner across the whole server — the multi-instance race that survived the detached-spawn fix is gone.** Detached spawn solved "the daemon dies when its parent's job object closes," but smoke against a fresh `npm start` still surfaced `could not read ok from ADB Server / failed to start daemon`. Watcher capture (`C:\Temp\watch-adb.ps1`) showed TWO `adb.exe` invocations 200 ms apart — one from the background pre-warm IIFE, one from `ControlCenter.init()`'s initial `adb devices` call — both forking fork-server children that fought for port 5037 and both lost. Root cause was architectural: seven `new AdbClient(...)` instances scattered across `src/server/` (scanAdb in `index.ts`, `ControlCenter`, `DeviceProbe`, `DeviceDiscoveryApi`, `Device`, `FilePushReader`, `AdbUtils`) each independently raced the daemon spawn, and the cross-module `adbReady.ts` coordination we added a day earlier was whack-a-mole — every new code path touching adb had to remember to `await whenAdbReady()`. New `src/server/AdbDaemonManager.ts` is a per-adbPath singleton that owns the daemon's full lifecycle: idle → starting → ready → killed state machine, single-flight `ensureReady()` (10 concurrent callers = 1 spawn), per-call `{ waitMs }` opt for scan-time short-circuit, `kill()` for clean shutdown, and a transparent delegation in `AdbClient` — every public method (`devices`, `shell`, `push`, `mdnsServices`, `connect`, `disconnect`, `forward`, etc.) awaits `daemon.ensureReady()` at the top before invoking adb. `AdbClient.startServer()` and `killServer()` become one-line delegates. `adbReady.ts` deleted; `ControlCenter.init()` no longer awaits `whenAdbReady()` because `adbClient.devices()` self-coordinates; `NetworkScanner`'s scan-time pre-warm dep is wired to `manager.ensureReady({ waitMs: 5_000 })` so a cold-install scan still gets the clean 5 s short-circuit instead of blocking for the manager's full 5 min budget. Net: future code paths that touch adb get daemon coordination for free; the multi-spawn race is impossible by construction.

- **adb daemon now actually survives our start-server call (Node job-object kill-on-close was murdering the daemon).** Visible since the parity branch landed: `[AdbClient] startup pre-warm failed: ... could not read ok from ADB Server / failed to start daemon` on every `npm start`, and `ControlCenter`'s 5 s poll continuously re-spawning `adb devices` only for both the parent and its would-be daemon child to die at the same millisecond every cycle (verified via `C:\Temp\watch-adb.ps1`). Root cause: Node's promisified-execFile on Windows places the spawned process in a job object with kill-on-job-close. When the parent `adb start-server` returns (or our 5 s timeout fires), the OS terminates every descendant in the job — including the `adb fork-server server` daemon child that's *supposed* to detach and survive. Manual `adb start-server` from PowerShell works fine because PowerShell doesn't use a job object. Fix: new `AdbClient.spawnDetachedDaemon()` replaces the promisified-execFile pathway for the start-server invocation only. Uses `spawn(adb, ['start-server'], { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })`. `detached: true` on Windows applies `CREATE_NEW_PROCESS_GROUP` which excludes the spawned process from Node's job, matching the PowerShell behavior. 30 s safety timeout (configurable via opts) replaces the old 5 s. `child.unref()` after exit so the daemon's stdio pipes don't pin our event loop.

- **Clean shutdown now tears down our adb daemon.** Server's `exit()` handler (SIGINT / SIGTERM path) calls `adbClient.killServer()` before service teardown. Fire-and-forget so the kill-server hang can't extend shutdown past the watchdog. The exit-75 restart path bypasses `exit()` entirely, so supervisor-driven restarts (Velopack apply, port change, dep update) still inherit a warm daemon as designed. Net: user-initiated quit owns the daemon's full lifecycle; restart-for-update keeps the existing handoff semantics.

- **`ControlCenter`'s initial device enumeration no longer races the startup adb daemon pre-warm.** On first page load against a cold daemon, `ControlCenter.init()`'s `adb devices` call fired ~2 s before the background `adbClient.startServer()` completed. Both adb invocations tried to spawn the daemon concurrently, neither won, and the user saw an empty device list followed by `[ControlCenter] ERROR Failed to list initial devices` in logs. The next 5 s poll cycle picked up devices cleanly (daemon was up by then), so the bug was a UX glitch rather than a functional break, but the noise in logs was real. New `src/server/adbReady.ts` module exposes a `whenAdbReady()` singleton promise; `index.ts` publishes the background pre-warm's outcome to it; `ControlCenter.init()` awaits it before the first adb call. Same class of race as the Quick Scan fix earlier today — different code path that wasn't covered.

- **Shutdown completes in seconds instead of minutes, and grandchildren get reaped.** Ctrl+C on `npm start` with a browser tab open produced a 4+ minute "Stopping..." hang followed by orphan Node processes surviving even a force-exit. Four layered fixes: (1) `WebSocketServer.release()` now `terminate()`s every open client after `wss.close()` — the `ws` library has no built-in timeout on close-handshake acknowledgement, so a single live browser tab pinned the server alive indefinitely. (2) `HttpServer.release()` now calls `server.closeAllConnections()` after `server.close()` — drops HTTP keepalive sockets immediately. (3) Server `exit()` handler gained a 10 s `setTimeout` watchdog that force-calls `process.exit(0)` if anything still pins the event loop. (4) Dev supervisor's signal handler races a 10 s grace period against `currentChild.kill(sig)`; if the child hasn't exited by then, `taskkill /T /F` (Windows) or `process.kill(-pid, 'SIGKILL')` (Linux) nukes the entire process tree including any orphaned node-pty workers or scrcpy helpers. A second Ctrl+C during the grace window fast-tracks straight to the force-kill. Also fixed the long-standing "Received signal undefined" log line — readline's SIGINT event doesn't pass the signal name to the handler; the registration is now wrapped to pass it literally.

- **`.restart` marker now lands where the launcher reads it (latent restart-mechanism bug, predates Phase 1).** Server-side `DependencyManager.requestRestart` and `ConfigApi`'s port-change handler both wrote the marker to `<depsPath>/.restart`, while the launcher's supervisor (`paths.rs:70`) read from `<dataRoot>/.restart`. The two paths never matched — the marker mechanism was silently dead code in install (and dev). Today exit-code-75 alone carries the restart signal via `supervisor.rs:36-45 decide_restart`'s OR semantics, masking the bug. Latent failure mode (now fixed): a server crash that committed `.restart` mid-config-write but didn't exit cleanly with 75 — launcher would never see the marker, no restart, manual recovery only. Fix: new `Config.dataRoot` + `Config.restartMarkerPath` getters; `DependencyManager` constructor takes an optional `{ restartMarkerPath }` opts arg; production wiring in `index.ts` routes the marker write through `Config.restartMarkerPath` so server and launcher agree.

- **Dev-mode port change in Settings now actually restarts the server, matching install behavior.** Previously, `npm start` was a bare `node dist/index.js` — when the server emitted `process.exit(75)` to request a restart (port change, dependency update, etc.), Node died, the browser redirect landed on a dead port, and you had to re-run `npm start` manually. New `scripts/dev-supervisor.mjs` mirrors `launcher/src/supervisor.rs:36-45`'s `decide_restart` semantics (marker-OR-exit-75) and respawns the server child. Crash-loop protection bails on >3 respawns in 10 s. SIGINT/SIGTERM forward to the child cleanly. `npm start` now invokes the supervisor; `npm run start:no-supervisor` is an escape hatch for debugging the server directly.

- **Dev-mode Node now resolves through `<repo>/seed/node/` (sha256-pinned v24.15.0) instead of the user's system Node.** The `prestart` chain invokes `scripts/fetch-node.mjs` to guarantee `seed/node/node.exe` exists, and the new dev supervisor follows `launcher/src/spawn.rs::resolve_node_with` priority exactly: `<dataRoot>/dependencies/node/node.exe` first, `<repo>/seed/node/node.exe` second, no system-Node fallback. Closes a Local-Dependencies-Only gap in dev that was supposed to have been cleaned up earlier this year but had no enforcement; the `pre-edit-local-deps-verify` hook caught this branch's initial draft re-introducing `process.execPath` as a fallback, exactly the safety-net behavior the hook was added for.

- **adb daemon-init race on Quick Scan against a cold daemon.** Symptom: clicking Quick Scan immediately after a fresh server start spawned multiple `adb.exe` processes which then all disappeared from Task Manager, leaving errors like `protocol fault: (couldn't read status): connection reset` and `daemon not running; starting now at tcp:5037 — timeout`. Root cause: `NetworkScanner` fires `concurrency` (default 16) parallel workers, each of which immediately invokes `adb devices`. With no daemon on port 5037, all N clients race to spawn one — losers report connection-reset, winning clients' daemon children get orphaned, no daemon survives, next scan repeats the race. Race only surfaced after the 2026-05-14 dev/install layout parity work because a wiped ProgramData was the first time anyone hit Quick Scan with no warm daemon already present. Fix: new `AdbClient.startServer()` with bounded wait-for-binary; called once at server startup (5-minute budget for cold first-install autoInstall) and again as a scan-time pre-warm (5-second budget for transient races) before `NetworkScanner` dispatches workers. Pre-warm failure surfaces as a single `scan.error` with a clear "wait for first-run setup to finish" message instead of N parallel spawn failures.

- **scrcpy-server "Update available" loop — clicking Update appeared to succeed but the row flipped back to "Update available" on the next "check for updates" click, forever.** Root cause: `DependencyDefinitions.scrcpy-server.checkInstalled` returned the bundled `SERVER_VERSION` constant (`'3.3.4'`) whenever the JAR existed on disk, regardless of what version the JAR actually was. The updater download did succeed end-to-end and replaced the on-disk binary; the "Update available" UI was a version-detection lie, not a failed install. New `src/server/scrcpyServerVersion.ts` persists the installed version to `<deps>/scrcpy-server/.version` after each updater install; `checkInstalled` reads from the marker, falling back to `SERVER_VERSION` only for legacy seed installs that predate the marker. `DependencyManager.update` now re-runs `checkInstalled` after install so in-memory state is always sourced from disk — no more drift between the post-update and post-check code paths. **Recovery for users currently in the broken state:** the UI will show "Update available" once after this hotfix lands; clicking Update once more will write the marker and the loop will not return.
- **scrcpy-server wire-protocol arg now matches the actual installed version.** `DeviceProbe.ts` and `ScrcpyConnection.ts` previously passed the bundled `SERVER_VERSION` constant to `app_process / com.genymobile.scrcpy.Server <version>` on every device connection. After an updater download, the constant no longer matched the on-disk JAR, and scrcpy's device-side version check would silently reject the handshake. Both call sites now resolve the version from the same on-disk marker that drives the dep-panel display, so the host's version arg always matches the JAR pushed to the device. (Note: this exposes scrcpy v3 → v4 wire-protocol differences if any exist; we'll deal with porting work if and when device connections actually break.)
- **Shell button greyed out when running from source via `npm start`.** Dev mode (`npm run build && node dist/index.js`) skipped the seed-staging step that `scripts/stage-publish.mjs` performs in CI, so `seed/node-pty-pkg/node_modules/` never got created. `NodePtyResolver.readSeedNodePtyVersion()` returned `null`, the resolver short-circuited with `reason: 'no-seed-package'`, `/api/capabilities` reported `shell: false`, and `DeviceTracker.applyShellCapability` dimmed the link with the (misleading) "no node-pty prebuilt matches your Node version" tooltip. Packaged installs were unaffected because CI runs `stage-publish.mjs` before `vpk pack`. New `scripts/stage-seed-node-pty.mjs` idempotently copies `node_modules/{node-pty,node-addon-api}` into `seed/node-pty-pkg/node_modules/`; wired into `npm start` via a `prestart` hook so `npm start` now stages the seed before launching the server.

### Changed

- `resolveDependenciesPath` now returns `<dataRoot>/dependencies/` on Windows regardless of dev-tell, matching `launcher/src/paths.rs` and the MSI install layout. Dev mode (`npm start` from repo) now reads/writes the same ProgramData state an installed app does. Linux dev unchanged. ([design spec](docs/superpowers/specs/2026-05-14-dev-install-layout-parity-design.md))
- `prestart` chain now also stages `assets/scrcpy-server` into `seed/scrcpy-server/` so `DependencyManager.promoteSeedScrcpyServer` works identically in dev and install — no first-launch network fetch for scrcpy-server when running from repo.
- **Code-signing path: SignPath Foundation declined the application.** SignPath cited project-awareness criteria — the OSS program looks for visible community engagement (GitHub stars, Reddit mentions, and similar signals) before issuing certificates, and ws-scrcpy-web didn't clear that bar. All SignPath references have been removed from public-facing docs (`README.md`, `PRIVACY.md`, `docs/RELEASING.md`, `RELEASE_NOTES.md`), and the auto-prepended SignPath credit has been stripped from CI-generated release notes (`scripts/extract-changelog.mjs`). The dormant `signpath/github-action-submit-signing-request@v2` steps in `.github/workflows/release.yml` have been commented out and left as scaffolding for a future signer; the `prepare` job's signing-mode gate now keys on a generic `SIGNING_API_TOKEN` secret so wiring a successor in won't require renaming. Historical design docs (`docs/plans/sp3-p6-contracts.md`, `docs/specs/2026-04-26-sp3-velopack-installer.md`, `docs/superpowers/plans/2026-04-28-program-files-migration.md`) carry top-of-file retraction headers pointing readers here; their bodies are otherwise preserved as point-in-time snapshots. Existing GitHub Releases bodies (v0.1.4 → v0.1.25-beta.3) had their SignPath credit + review-pending notice replaced with the same disclosure. Release artifacts remain **unsigned** for now — an alternative code-signing path is under evaluation. Integrity continues to be verifiable via the `SHA256SUMS` file shipped with each release; the `--unsigned` warning block in release notes has been rephrased to drop the SignPath name.

### Removed

- Pre-Phase-1 orphan `<repo>/config.json` (never read on Windows since dataRoot migration).

### Repository

- **Git history rewritten on `main`** to remove `Co-Authored-By: ... <noreply@anthropic.com>` trailers from 14 commits across the v0.1.20 → v0.1.21 packaging arc. The trailers were causing GitHub to credit Anthropic's noreply account as a project contributor. All commit SHAs from `be1b4f5` (v0.1.20) forward have changed; tags v0.1.20 through v0.1.25-beta.3 inclusive were re-pointed and force-pushed. Tags v0.1.10–v0.1.19 and `node-pty-prebuilds-*` are unchanged. Existing clones must `git fetch --tags` and `git reset --hard origin/main` (or re-clone) — `git pull` will not work from any clone whose `main` is at a pre-rewrite SHA.

## [0.1.25-beta.3] - 2026-04-30

### Added

- Admin-confirmation modal before clicking Install Service / Uninstall Service in the Settings panel. Sets the expectation that a Windows UAC prompt is coming and gives a clean cancel path before the OS dialog fires.

### Fixed

- **Service uninstall no longer silently fails for non-admin users.** Previously the backend's LocalSystem context would fall through to a direct `runElevated` call after the user-session handoff failed, but PowerShell `Start-Process -Verb RunAs` from LocalSystem has no interactive desktop to show the UAC prompt — the elevation silently never happened and the frontend's "uninstalling…" button hung. Backend now returns a clear 503 + actionable error instead.
- Service-mode failure responses now carry a `reason` discriminator and the frontend maps each variant to a specific actionable message (e.g., "Couldn't reach the user session. Make sure ws-scrcpy-web is running for your user, then try again.") instead of surfacing raw error strings.
- The "uninstalling…" button on the Settings modal now swaps to "still waiting for user session…" after 5 seconds so the user can tell the long handoff path is still working, not frozen.
- Tightened the gap between the home-page top-right controls and the connected-devices section's outer top border (page-container `padding-top` 64px → 56px).

## [0.1.25-beta.2] - 2026-04-30

### Fixed

- **HKLM\Run tray migration now works on upgrade from v0.1.24** — v0.1.25-beta.1's HKLM-Run write only fired from the live "install service" UI path; the Velopack `--veloapp-updated` hook just restarted the service without touching tray registration, so v0.1.24 → v0.1.25-beta.1 upgrades left HKLM unwritten and non-admin users got no tray icon at logon. The launcher now self-heals HKLM idempotently on every service start (LocalSystem context, no UAC), so the first service restart after upgrade completes the migration automatically.
- **No more duplicate tray icons in admin's session post-migration** — added a per-session single-instance mutex (`Local\WsScrcpyWebTray-SingleInstance`) to the standalone tray helper. The mutex winner also best-effort deletes the stale HKCU\Run\WsScrcpyWebTray value left over from v0.1.24, so subsequent logons spawn exactly one tray.

### Changed

- `scripts/bump-version.mjs` now correctly relocates `[Unreleased]` body content into the new `[<version>] - DATE` section (instead of leaving it under `[Unreleased]` with an empty new-version header), and strips leading blank lines to avoid a doubled blank between the heading and the first body line.
- `launcher` registry-cleanup helpers (`unregister_tray_run_key`, `cleanup_stale_hkcu_tray_run_key`) now use `reg.exe` exit-code parsing (locale-stable) instead of English-only stderr substring matching. Non-English Windows installs no longer silently fail the cleanup path.
- Home-page top padding (`64px`) so the fixed-position controls cluster (settings/theme/update) doesn't visually crowd the connected-devices section.

### Removed

- Dead `ARGS_STRING` export from `src/common/Constants.ts` (no callers since SP2 scrcpy-server v3 rewrite). `SERVER_PORT` retained — still used as a sentinel by `DeviceTracker` and `StreamClientScrcpy`.

## [0.1.25-beta.1] - 2026-04-30

### Fixed

- **Service-mode tray helper now registers under `HKLM\...\Run` instead of `HKCU\...\Run`**, so every user logging into the machine receives a tray icon at logon — not only the installing admin. Upgrades from v0.1.24 also clean up the stale HKCU value for the installing admin to avoid a one-time double-spawn at next admin logon.

## [0.1.24] - 2026-04-30

First stable v0.1.24 cut, rolling up the eight-beta investigation. Headline fix: **Theory D** — the service-uninstall flow no longer fails with `ERROR_ACCESS_DENIED`. After three layered Win32 attempts (privilege flips, session enumeration, primary-token forcing) all failed across betas 1–3, beta.8 dropped the cross-session WTS spawn entirely in favor of file-marker IPC: the LocalSystem service-Node writes a JSON marker under `<dataRoot>/control/`, and a polling thread inside the user-session tray helper detects it and natively spawns the launcher in its own session. Both v0.1.23 known-issues bug 1 (failed handoff) and bug B (Path B no-tray-after-fallback) are closed by this architectural change, end-to-end VM-verified. Also closed: the tray-icon-click went to a stale port after mode swaps — the tray now re-reads `config.json::webPort` on every click via a closure-injected URL provider.

Other v0.1.24 work folded into this stable: Settings modal layout overhaul (fixed-width 20rem labels + 16rem controls tracks, no reflow on dynamic content), four shorter user-facing strings to fit the new tracks, iframe theme bridge (`window.WsScrcpy.*` postMessage API for embedding hosts), MutationObserver-based theme toggle button visual sync, logs consolidation round 2 (`ws-scrcpy-web.log` and `service.log` joined `launcher.log` + `server.log` under `<dataRoot>/logs/`).

**Migration:** v0.1.23 stable users and v0.1.24-beta.{1..8} users can in-app update to v0.1.24 normally — no fresh-install required. The Theory D handoff path activates automatically on the first service uninstall attempt after upgrading. Old `<dataRoot>/dependencies/service.log` and `<dataRoot>/ws-scrcpy-web.log` files (pre-beta.7 paths) may linger; safe to delete by hand.

### Known issues (carried into v0.1.25)

- **Multi-user port drift in service mode (§1c bug 2).** User A flips to service on port 8004, logs out, User B logs in → tray-click opens a dead port because the actual service moved to 8005 and `config.json` wasn't re-persisted. Still deferred — needs a focused multi-user-VM diagnostic session with `handle.exe` / Procmon to answer "why does the service-Node restart on User B login at all?" Static code reading can't reach the root cause.
- **Theory D fallback retains the v0.1.23 broken-uninstall UX in the no-tray-helper edge case.** If the user has explicitly killed the standalone tray helper (or it never started), the marker write succeeds but no consumer picks it up; ServiceApi falls through to direct uninstall after the 30s discover timeout, browser sees "couldn't reach server." Same UX as v0.1.23, just much rarer to hit. Not tracked separately.
- **Cosmetic node-pty `AttachConsole failed` errors in server.log when opening shell sessions.** Functionally harmless — actual shell I/O works; these come from node-pty's internal `conpty_console_list_agent.js` helper failing to attach to our hidden-subsystem parent process. Tracked as todo §9a for a future seed-patch or upstream fix.

## [0.1.24-beta.8] - 2026-04-30

### Fixed

- **Service uninstall handoff — file-marker IPC replaces the broken cross-session WTS spawn (Theory D).** v0.1.24-beta.{1,2,3} attempted three layered fixes for the WTS handoff (privilege flips, session enumeration, primary-token forcing) and all failed with `ERROR_ACCESS_DENIED` when invoking `CreateProcessAsUserW` from the LocalSystem service-Node. Theory D drops the cross-session spawn entirely. The service-Node now writes a JSON marker at `<dataRoot>/control/uninstall-handoff.json`; a polling thread inside the user-session tray helper detects it and natively spawns the launcher in its own session — no `WTSQueryUserToken`, no `CreateProcessAsUserW`, no privilege hunting. End-to-end VM-verified on 2026-04-30: install → uninstall → install → uninstall completes smoothly with the correct tray icon at every step.
- **Tray icon URL no longer goes stale across mode swaps.** Pre-fix, the tray helper read `config.json::webPort` once at startup and cached the resulting URL; clicking the tray after a service-uninstall handoff opened the dead service port instead of the new local port. The tray now re-reads `config.json` on every click via a closure-injected URL provider, so `localhost:<port>` always points at whichever launcher is currently bound. Same fix in the launcher's in-process tray (local mode) and the standalone tray helper (service mode).

### Changed

- **Settings modal layout — fixed-width tracks so dynamic content never reflows the controls column.** Modal width restored to the original 640px cap. Labels track is now a fixed 20rem (down from 1fr greedy) and the controls track is widened to 16rem (up from 200px) so the longest steady-state button text ("not installed — install?") fits without wrapping. Column gap is 1rem with a small whitespace track on the right of the controls — the controls column now sits a touch left of the modal's right edge instead of hugging it. Result: changing button states (install ↔ uninstall, status messages, version strings) no longer shift the column horizontally.
- **Settings modal — shortened a handful of long strings** that were overflowing the new fixed-width tracks: the post-port-change save status `server restarting on new port. redirecting in a moment…` is now `restarting → redirecting…`; the apply-update button drops the redundant word ("apply update vX.Y.Z" → "apply vX.Y.Z"); the install/uninstall transition states adopt a parens style ("switching to service mode…" → "→ service mode (install)…", same shape for the user-mode-uninstall variant).

## [0.1.24-beta.7] - 2026-04-29

### Changed

- **Logs consolidation, round 2 — `ws-scrcpy-web.log` and `service.log` join the others under `<dataRoot>/logs/`.** v0.1.24-beta.3 moved `launcher.log` and `server.log` to `<dataRoot>/logs/` but missed two more log files: the Node app Logger's output (`ws-scrcpy-web.log`, formerly at `<dataRoot>/`) and Servy's service-mode stdio capture (`service.log`, formerly at `<dataRoot>/dependencies/`). Both now live in `<dataRoot>/logs/` alongside the others. `Logger.ts::resolveLogFilePath` updated to return `<dataRoot>/logs/ws-scrcpy-web.log`; `ServiceApi.ts` builds `<dataRoot>/logs/service.log` and `mkdirSync`s the directory before passing the path to Servy. Single source of truth for "where do logs live": `C:\ProgramData\WsScrcpyWeb\logs\`. Existing installs may have stale files at the old paths — safe to delete by hand.
- **Settings modal controls column trimmed 260px → 200px.** Visual feedback on v0.1.24-beta.3 showed ~60px of unused space at the right edge of the controls column. The widest button ("running — uninstall?", ~190px) now sits ~10–20px from the right edge with comfortable slack for future text growth, while the labels column gains the freed pixels for less wrapping.

## [0.1.24-beta.6] - 2026-04-29

### Fixed

- The in-app theme toggle button's icon and tooltip now stay in sync
  with the current theme regardless of how it changed. Previously the
  button only updated its own visual state when clicked directly, so
  it went stale when the theme was set via the iframe theme bridge or
  via `WsScrcpy.setTheme(...)`. Implemented via a `MutationObserver`
  on `<html data-theme>` with self-disconnect when the button is
  removed from the DOM (e.g., modal close).

## [0.1.24-beta.5] - 2026-04-29

> v0.1.24-beta.4 was a failed re-cut (release CI rejected the tag because
> `Cargo.toml` wasn't bumped alongside `package.json`). v0.1.24-beta.5 is
> the actual release of this content.

### Added

- **Iframe theme bridge** — public theme-embed API on `window.WsScrcpy.*`:
  `getTheme`, `setTheme`, `installThemeEmbedListener`, `notifyThemeReady`,
  `notifyThemeChanged`. Lets a host page embedding ws-scrcpy-web in an iframe
  sync dark/light theme via origin-validated `postMessage` (namespaced
  `ws-scrcpy-web:`). Auto-installed on page load; standalone usage is a no-op.
- README: new *Embedding: theme bridge* section documenting the protocol,
  host integration, race-condition mitigations, and `allowedOrigins` security.

### Changed

- `ThemeToggle` now uses the shared theme-embed helpers (single source of
  truth) and posts `theme-changed` to the parent on click. Standalone
  behavior unchanged.
- **Logs consolidated under `<dataRoot>/logs/`.** Both `launcher.log` and `server.log` now live in `C:\ProgramData\WsScrcpyWeb\logs\`. Pre-beta.3, `launcher.log` lived directly in dataRoot (`<dataRoot>\ws-scrcpy-web-launcher.log`) and `server.log` was tucked under `<dataRoot>\dependencies\server.log` — annoying for navigation and unintuitive. The launcher now creates `<dataRoot>\logs\` as needed and writes both files there. `spawn::spawn_server` signature gained a `data_root` parameter so it can resolve the new server.log path. Old log files at the legacy paths can be deleted by hand on existing installs; they're not auto-migrated. Velopack's own update logs continue to land where Velopack puts them (install root) — `vpk` doesn't expose a redirect.
- **Settings modal copy tightened.** Four label rewrites to fit cleanly in the v0.1.24-beta.1 widened label column without redundant words: "installs/uninstalls the server as an always-on service" → "installs/uninstalls server service"; "saving will restart the server and redirect to the new port" → "save restarts & redirects to new port"; "last checked Nm ago — up to date (vX.Y.Z)" → "up to date: vX.Y.Z" (drops the relative-timestamp prefix and parenthesized version); "vX.Y.Z ready to apply" → "update: vX.Y.Z". Removed the now-unused `formatRelative` helper.
- **Update-status text turns green when an update is ready.** New `.settings-status-ready` CSS class (#4caf50, mirrors the `.settings-btn-ready` button outline color) toggled on the status `<p>` when `s.status === 'ready'`. Pairs the description text color with the action button — green "update: vX.Y.Z" beside green "apply update" button, default muted "up to date: vX.Y.Z" beside blue "check for updates now". Mirrors how `.settings-status-error` already toggles red.

### Fixed

- **Service uninstall — `CreateProcessAsUserW` privileges + window station (§1c bug 1, layer 3).** v0.1.24-beta.2 fixed the session lookup (`WTSEnumerateSessions` correctly resolved testdude → session 1) and `WTSQueryUserToken` then succeeded, but `CreateProcessAsUserW` failed with `ERROR_ACCESS_DENIED` (HRESULT 0x80070005). Two root causes: (a) `CreateProcessAsUserW` requires `SE_ASSIGNPRIMARYTOKEN_NAME` and `SE_INCREASE_QUOTA_NAME` to be ENABLED on the caller's token (LocalSystem holds both but Servy hosts them disabled, same pattern as `SE_TCB_NAME` in beta.1); (b) the spawned process needs an explicit `lpDesktop = "winsta0\\default"` in `STARTUPINFOW`, otherwise it inherits the service's session-0 window station which the user's token has no access to. Refactored the privilege-enable code into a generic `enable_privilege` helper + `enable_cross_session_spawn_privileges` that flips all three privileges in one shot. Added the `lpDesktop` assignment.
- **Service uninstall WTS handoff — Hyper-V Enhanced Session / RDP regression (§1c bug 1, layer 2).** v0.1.24-beta.1 added `SE_TCB_NAME` enable-before-`WTSQueryUserToken` thinking the privilege was the issue. VM smoke test on v0.1.24-beta.1 proved otherwise: privilege flip succeeded but `WTSQueryUserToken` still failed with `ERROR_NO_TOKEN` (HRESULT 0x800703F0). Root cause: `WTSGetActiveConsoleSessionId()` returns the **physical console** session, not the user's interactive session. On Hyper-V Enhanced Session Mode (RDP-like VM access), real RDP, or any VDI scenario, the physical console is empty (`Conn` state, no logged-on user) while the user is in a different session. `qwinsta` on the VM confirmed: testdude was in session 1 but `WTSGetActiveConsoleSessionId` returned 3 (the empty console). Fix: replaced `WTSGetActiveConsoleSessionId` with a `WTSEnumerateSessionsW` walk that filters by `State == WTSActive` AND non-empty `WTSUserName`, returning the first matching session. Falls back to `WTSGetActiveConsoleSessionId` only if enumeration finds nothing (preserves existing behavior on bare-metal single-user installs). The SE_TCB_NAME enable from beta.1 is kept — still required, just not sufficient.

## [0.1.24-beta.3] - 2026-04-29

## [0.1.24-beta.2] - 2026-04-29

## [0.1.24-beta.1] - 2026-04-29

### Fixed

- **Service uninstall WTS handoff (§1c bug 1, first attempt — superseded by [Unreleased] / beta.2).** `spawn_in_active_user_session` now explicitly enables `SE_TCB_NAME` ("Act as part of the operating system") on the launcher's process token via `AdjustTokenPrivileges` before calling `WTSQueryUserToken`. Hypothesis was that Servy's service token had the privilege present-but-disabled. **The privilege flip succeeded on the VM but the WTS call still failed** — the actual root cause was different (see [Unreleased] / beta.2). The privilege enable is still kept since it's required for Servy hardening, just not sufficient on its own.

### Changed

- **Settings modal label column widened.** Grid layout changed from `[labels] 40% [controls] 1fr` to `[labels] 1fr [controls] 260px`. The 260px controls column reserves space for the widest button ("not installed — install?", ~210px) plus ~50px of slack for future button-text growth. Frees up ~90px for the labels column at the modal's max width, reducing description wrapping. All other modals untouched.

## [0.1.23] - 2026-04-29

First stable v0.1.23 cut, rolling up everything from the 26-beta investigation. Eight architectural fixes in the in-app updater chain (install-root ACL via UAC, Job Object kill-on-close release, Rust SDK auto-apply disable, adb pre-apply hygiene + cwd anchoring, node-pty Local-Dependencies-Only restructure with `process.getBuiltinModule` runtime require, Logger to dataRoot, UI uninstall-flow modal race code path), Settings modal redesign (label-control grid layout, dual-purpose apply-update button), CI prerelease flag drop, and migration documentation. See per-beta entries below for the diagnosis chain.

**Migration:** users on v0.1.21 / v0.1.22 / v0.1.23-beta.{1..6} must fresh-install the v0.1.23 MSI — the in-app updater on those builds is broken at varying severity and won't reach v0.1.23 by clicking apply. v0.1.23-beta.7+ users can in-app update normally. See `docs/PROGRAMDATA-MIGRATION.md` for the per-bug fix-version table.

### Known issues (carried into v0.1.24)

- **Service uninstall flow doesn't redirect cleanly back to local mode.** Clicking "uninstall service" from the service-mode Settings UI shows "couldn't reach server" with a retry button rather than redirecting to the local launcher. The service WILL still uninstall correctly. Root cause traced to the WTS handoff (`spawn_user_launcher_command`) failing with exit code 4 in ~1ms — likely `WTSQueryUserToken` returning `ERROR_PRIVILEGE_NOT_HELD` because Servy hosts the service without `SE_TCB_NAME` explicitly enabled in the process token. Fix direction: `AdjustTokenPrivileges` before `WTSQueryUserToken` in `launcher/src/user_session_spawn.rs`.
- **Local tray doesn't restore after a service uninstall.** Even after the service is fully uninstalled (via the Settings → "stopped — uninstall?" button after a failed first attempt), the local-mode tray icon doesn't appear. Workaround: close `ws-scrcpy-web-launcher.exe` from Task Manager and relaunch via the Start menu shortcut. Root cause: launcher's `is_service_mode` decision is made once at startup; the in-launcher tray thread doesn't spawn dynamically when `installMode` flips post-uninstall.
- **Multi-user port drift in service mode (§1c bug 2).** User A flips to service on port 8004, logs out, User B logs in → tray-click opens a dead port because the actual service moved to 8005 and `config.json` wasn't re-persisted. Needs a focused multi-user-VM diagnostic session with `handle.exe` / Procmon to root-cause the unexpected service restart at User B login. Hypothesis: launcher's port-collision auto-shift fires during a User-B-login-time service restart, `Config.reconcileWebPort` updates in-memory but doesn't persist.
- **Cosmetic node-pty `AttachConsole failed` errors in server.log when opening shell sessions.** Functionally harmless — actual shell I/O works; these come from node-pty's internal `conpty_console_list_agent.js` helper failing to attach to our hidden-subsystem parent process. Tracked as todo §9a for a future seed-patch or upstream fix.

## [0.1.23-beta.26] - 2026-04-29

### Fixed

- **Service uninstall flow no longer leaves user stranded with the wrong modal + no tray (item 6 §1c bug 1).** Three sub-fixes:
  - **(1.a)** `maybeShowWelcomeModal` early-returns when `?resume=uninstall-service` is in the URL. Pre-fix it raced against the in-flight uninstall, fetching `/api/config` while installMode still showed the OUTGOING service mode, mounting `ServiceFirstRunModal`, native `<dialog>` stacking covered the uninstall progress overlay.
  - **(1.b)** `maybeResumeUninstall` reloads the page on success rather than just removing the overlay. The reload re-runs `maybeShowWelcomeModal` cleanly against the now-canonical `installMode='user'` and picks the right modal.
  - **(1.c)** `ServiceApi.handoffUninstallToUserSession` passes `['--local-takeover']` to the WTS-spawned user-session launcher. `main.rs` detects the flag and forces `is_service_mode=false` even though `config.json` still reads `'user-service'` at spawn time (the resume flow flips it AFTER the uninstall completes). New launcher boots with local tray as expected — pre-fix the user was left with no tray + an orphan browser tab they didn't click into.

### Notes

- **Item 6 §1c bug 3 (HKCU vs HKLM Run-key) resolved as no-code-change.** Audit confirmed `HKCU\...\Run\WsScrcpyWebTray` is the only Run-key write site and HKLM was never wired in any layer (no MSI customization, no Velopack hook, no Servy autostart). Per-user HKCU is the correct design — User A installed the service for themselves; their tray represents their UI affordance. Other users who launch via the Public desktop shortcut (Velopack default) get their own tray spawned for their session.
- **Item 6 §1c bug 2 (multi-user port drift) deferred to a future multi-user-VM diagnostic session.** Root cause requires live observation with `handle.exe` / Procmon at User B login time. Static code reading can't answer "why does the service-Node restart on User B login at all?" — fixing without that risks treating a symptom (port drift) without addressing the cause.

## [0.1.23-beta.25] - 2026-04-29

### Fixed

- **`ws-scrcpy-web.log` now lives at `<dataRoot>/ws-scrcpy-web.log` instead of `<installRoot>/current/ws-scrcpy-web.log`.** The previous location was inside the Velopack-swappable image, so every in-app update wiped accumulated logs (and made post-update troubleshooting harder). Path now resolves via `path.dirname(DEPS_PATH)` — the launcher already sets `DEPS_PATH=<dataRoot>/dependencies/`, so dataRoot derivation is consistent with everything else. Logger also adds an idempotent `mkdirSync` for the log directory so first-launch races don't lose lines.

### Known issues

- **Cosmetic node-pty AttachConsole errors in server.log when opening a shell session.** Originate from node-pty's internal `conpty_console_list_agent.js` helper which `fork()`s a Node child to enumerate processes attached to the conpty session and fails because our parent Node process runs without a console window (Windows hidden subsystem launcher). The error dumps to the agent's stderr which bubbles into server.log. **Functionally harmless** — actual shell I/O goes through a different node-pty path that works fine; commands like `dumpsys` execute correctly. Fixing requires either a node-pty patch or stripping the agent from the seed; deferred until we either expose a "list processes" feature or upstream fixes it.

## [0.1.23-beta.24] - 2026-04-29

No code changes. In-app update target for beta.23 — verifies node-pty actually loads from the dataRoot package across the upgrade boundary, not just at fresh install. Shell button on connected devices should be functional in both beta.23 and beta.24 (was disabled in beta.19–beta.22 due to the `(void 0)` resolver bug).

## [0.1.23-beta.23] - 2026-04-29

### Fixed

- **node-pty resolver actually loads (item 5 fix).** beta.19's Local-Dependencies-Only restructure shipped with a webpack-mangled require call: `import { createRequire } from 'module'` got tree-shaken to `void 0` and the bundled output had `(void 0)('node-pty')`. Resolver always failed with `(void 0) is not a function`, the shell button stayed disabled across a clean install + upgrade. Switched to `process.getBuiltinModule('module').createRequire(marker)('node-pty')` — webpack does not analyze `process.*` expressions, so the chain survives bundling untouched. `process.getBuiltinModule` is Node 22+, available in our shipped Node 24. Bare `require(absolutePath)` was also tried but webpack rewrote it into `__webpack_require__(<id>)` for a context-bundle and returned the wrong module; the process.getBuiltinModule path is the only escape that stays clean.

## [0.1.23-beta.22] - 2026-04-29

No code changes. In-app update target for beta.21 so the round-3 Settings modal layout (label-control rows everywhere, no centered footers) can be exercised via the in-app updater.

## [0.1.23-beta.21] - 2026-04-29

### Changed

- **Settings modal — every section unified as label-control rows.** Per UX feedback round 3: dropped the centered-footer pattern (buttons drifted to a different x-axis than the inputs above them). Every setting is now one row: description on the left (wraps as needed), control on the right (left-aligned in the right column). Updates section's status text rides along as the action row's label; Server section's redirect-explainer is the save-row label; Service section restored the informational blurb "installs/uninstalls the server as an always-on service" as label with the state-aware action button as control. Service install button now uses the green `.settings-btn-ready` styling to mirror the apply-update affordance; uninstall stays red.

## [0.1.23-beta.20] - 2026-04-29

No code changes. In-app update target for beta.19 — verifies the new node-pty Local-Dependencies-Only flow holds across an in-app upgrade: beta.19's runtime should already be loading from `<dataRoot>/dependencies/node-pty/`; applying beta.20 should leave that dataRoot package untouched (Velopack swaps `current/` only) and node-pty should continue to load cleanly post-upgrade.

## [0.1.23-beta.19] - 2026-04-29

### Changed

- **node-pty now loaded from `<dataRoot>/dependencies/node-pty/` exclusively (item 5 / Approach C).** Architectural compliance with Local-Dependencies-Only: the bundled image no longer ships node-pty in `<installRoot>/current/node_modules/`. At build time, `stage-publish.mjs` relocates node-pty + node-addon-api from `publish/node_modules/` to `publish/seed/node-pty-pkg/node_modules/`. At runtime, `NodePtyResolver.copySeedToDataRoot()` stages the seed to `<dataRoot>/dependencies/node-pty/v<version>-<host>/` on first launch, and all loads go through `createRequire(<dataRoot>/.../_marker)('node-pty')` — bypassing Node's default resolution that would otherwise look at the install image. Cache-miss path (Node ABI changes after auto-update) downloads the matching prebuilt tarball and overlays `pty.node` into the existing dataRoot package without writing to the install root. Pre-Approach-C, beta.7's icacls grant masked the architectural violation (the runtime copy could succeed by writing to install root); now the install root is genuinely read-only at runtime.

## [0.1.23-beta.18] - 2026-04-29

No code changes. In-app update target for beta.17 so the redesigned Settings → Updates UI can exercise its "apply update" button end-to-end with the green-when-ready state.

## [0.1.23-beta.17] - 2026-04-29

### Changed

- **Settings modal polish round 2.** Section reorder (Updates → Server → Service → App), equal row heights across all sections (fixes the squeezed channel row in the Updates list), section footers switched from right-aligned to a centered vertical stack so status text can wrap above the action button without forcing the modal wide. New inline footer variant (Server: `[save]` + always-visible note "saving will restart the server and redirect to the new port"). Service section absorbed status into the action button text — single centered button reads "not installed — install?" or "<status> — uninstall?" instead of a 2-row status + footer pairing. Updates section's action button gets green outline + text when status === 'ready', mirroring the home-page UpdateButton chip.

## [0.1.23-beta.16] - 2026-04-29

No code changes. Cut as an in-app update target so v0.1.23-beta.15 fresh installs can exercise the redesigned Settings modal's "apply update" button end-to-end via the in-app updater (gear icon → Updates section → "apply update v0.1.23-beta.16").

## [0.1.23-beta.15] - 2026-04-29

### Changed

- **Settings modal redesigned to a clean two-column grid (description left, control right).** Every section — Server, Updates, Service, App — now uses the same `.settings-section-body` CSS grid (`[labels] 40% [controls] 1fr`) so labels and controls align vertically across rows AND across sections. Inputs are no longer nested inside their labels (the previous pattern made input X-position drift with label-text length). Action buttons (save / install / uninstall / check-for-updates / apply-update) moved to dedicated `.settings-section-footer` rows that span both columns and right-align. Mirrors the ConfigureScrcpy modal aesthetic. Files: `src/app/client/SettingsModal.ts` (~530 lines rewritten), `src/style/modal.css` (settings-modal block).
- **Settings → Updates "apply update" path.** The action button is now dual-purpose: it shows "check for updates now" when there's nothing to apply, and flips to "apply update v0.1.X" (with an apply-and-reload click handler) when status === 'ready'. Same UX as the home-page chip but accessible from anywhere via the gear icon. Status text live-updates through "applying update… → server restarting to apply update — page will reload…" during the apply window.
- **CI: dropped `prerelease: true` flag from beta tag releases.** GitHub's `/releases/latest` API endpoint excludes prereleases, and Velopack's GithubSource queries that endpoint to find the latest release in the configured channel — flagging beta tags as prereleases broke in-app updater discovery for beta-channel users. Channel separation is already handled by Velopack's per-channel `releases.<channel>.json` feed file, so the prerelease flag was redundant gating that broke discovery. Live workaround was applied 7 times during the v0.1.23-beta.{2..14} test cycle (`gh release edit --prerelease=false`); now permanent. File: `.github/workflows/release.yml`.

## [0.1.23-beta.14] - 2026-04-29

No code changes. Cut as an in-app update target so v0.1.23-beta.13 fresh installs can exercise the post-hygiene swap path. Pairs with the beta.9 Job Object kill-on-close release fix (Update.exe survives launcher exit), beta.11 Rust auto-apply disable (no post-apply Update.exe loop), and beta.13 pre-apply hygiene (adb daemon doesn't lock install root). This should be the first end-to-end-clean apply: Update.exe spawns, parent exits, daemon is killed, swap renames `current\` successfully, hooks fire, beta.14 launcher boots automatically with no manual intervention required.

## [0.1.23-beta.13] - 2026-04-29

### Fixed

- **In-app updater can now actually swap `current\` (adb daemon CWD-lock fix).** v0.1.23-beta.11 → beta.12 VM testing surfaced the third in-app-updater failure mode: Velopack downloaded the package, ran `--veloapp-obsolete` cleanly, then failed to rename `current\` to a backup folder with "The process cannot access the file because it is being used by another process," retried 10×1s, and gave up with `Apply error: Unable to start the update, because one or more running processes prevented it.` Sysinternals `handle.exe` showed `adb.exe` (the long-lived `adb start-server` daemon) holding `C:\Program Files\WsScrcpyWeb\current` as a file handle across multiple apply attempts. Daemon inherited cwd from Node, which inherited from the launcher running from `current\`. Two fixes:
  - **Pre-apply hygiene** in `UpdateService.applyUpdate` (now async): runs `adb kill-server` via the bundled adb client, then Windows-only `taskkill /F /IM adb.exe /T` belt-and-braces, then a 250ms settle delay before `waitExitThenApplyUpdate`. All steps failure-tolerant — apply still proceeds if hygiene partially fails. `UpdatesApi.handleApply` now `await`s `applyUpdate` so the deferred `process.exit` timer doesn't fire before Velopack actually has Update.exe spawned.
  - **Architectural cwd fix** in `AdbClient`: spawned adb processes now use `path.dirname(adbPath)` as their cwd (which lives at `<dataRoot>\dependencies\adb\` per Local-Dependencies-Only) instead of inheriting the launcher's working directory. Even if `kill-server` fails or the daemon respawns, its cwd-lock no longer falls inside the install root and can't block a future swap. Applied to all three adb spawn paths: `exec` wrapper, `shell`, and `shellSpawn`.

## [0.1.23-beta.12] - 2026-04-29

No code changes. Cut as an in-app update target so v0.1.23-beta.11 fresh installs can exercise the post-apply auto-relaunch path now that the Rust-SDK auto-apply default is disabled. Pairs with the beta.9 Job Object kill-on-close release fix as the second half of the in-app updater story: beta.9 lets `Update.exe` survive launcher exit; beta.11 stops the post-swap launcher from re-firing `Update.exe` in a loop.

## [0.1.23-beta.11] - 2026-04-29

### Fixed

- **Update.exe loop after successful apply (Gotcha 1 redux on the Rust SDK).** v0.1.23-beta.9 → beta.10 VM testing surfaced this: clicking Apply ran Update.exe, swap completed, launcher relaunched as beta.10 — and then the SAME pending package re-fired Update.exe, looping. Root cause: v0.1.23-beta.3 disabled `setAutoApplyOnStartup` on the Node-side Velopack SDK (`src/server/index.ts`) but the parallel Rust `VelopackApp` (velopack crate 0.0.1298) defaults `auto_apply: true` and does the exact same `manager.get_update_pending_restart()` → auto-fire-Update.exe check from `launcher/src/main.rs:114`. Fix: explicit `.set_auto_apply_on_startup(false)` on the Rust SDK call too. Apply now fires ONLY on explicit user click via `UpdateService.applyUpdate`. Stuck users on beta.9/beta.10 can recover by deleting the staged `.nupkg` from `C:\Program Files\WsScrcpyWeb\packages\WsScrcpyWeb-*-beta-full.nupkg` before next launch (or fresh-installing beta.11 over the loop).

## [0.1.23-beta.10] - 2026-04-29

No code changes. Cut as an in-app update target so v0.1.23-beta.9 fresh installs can exercise the auto-relaunch path now that the Job Object kill-on-close release is in place. This is the first release that should let `Update.exe` survive past launcher exit and complete the swap + relaunch automatically — no manual relaunch required.

## [0.1.23-beta.9] - 2026-04-29

### Fixed

- **In-app updater no longer killed mid-extract by our own Job Object.** v0.1.23-beta.7 → beta.8 VM testing showed the auto-relaunch failing — clicking "apply update" shut down the app cleanly but never relaunched the new version; only a manual relaunch completed the swap. Velopack log cut off mid-line at `Extracting 393 app files...`, the classic `TerminateProcess` signature. Root cause: the v0.1.22 Job Object (`KILL_ON_JOB_CLOSE`) added to clean up Node + `node-pty` descendants on launcher exit was inheriting `Update.exe` (a grandchild via Node) into the same job. When the launcher exited gracefully after `applyUpdate()`, our last handle to the job closed and the kernel terminated `Update.exe` mid-extract, leaving the install in a half-state. Fix: `launcher/src/job_object.rs::release()` clears the kill-on-close flag before the launcher's last handle drops, so the job dissolves quietly without killing remaining members. Hard-kill paths (Servy stop, Task Manager, crash) bypass this cleanup, so the v0.1.22 safety net still fires on abnormal termination as intended.
- **`Update.exe`'s "Failed to wait for process … (Access is denied)"** still appears in `velopack_WsScrcpyWeb.log` because of an integrity-level mismatch on `OpenProcess` from the post-UAC launcher chain. Velopack continues anyway via its `Continuing...` fallback, and with the Job Object fix above the apply now completes successfully. The warning is cosmetic at this point but tracked separately.

## [0.1.23-beta.8] - 2026-04-29

No code changes. Cut as an in-app update target so v0.1.23-beta.7 fresh installs can exercise the fully-automatic update path: UAC prompt for icacls at first launch (one-time), subsequent updates apply silently with no further UAC.

## [0.1.23-beta.7] - 2026-04-29

### Fixed

- **Install-root ACL grant now survives MSI install (Fix 2 follow-up).** The `--veloapp-install` hook's `icacls` grant on `C:\Program Files\WsScrcpyWeb\` was getting stripped by MSI's component-permission step (~3 seconds after our hook ran). v0.1.23-beta.7 adds a deferred grant: at first non-hook launcher start, if the install root isn't user-writable, `ShellExecuteExW(verb="runas")` invokes `icacls.exe` elevated to apply the grant — single one-time UAC prompt per install. Once granted, all subsequent launches find the install root writable and skip the elevation entirely. Also fixes migrations from v0.1.21 / v0.1.22 / v0.1.23-beta.{1..6} → beta.7+ (those installs lack the grant; first launch under beta.7 catches them). UAC dismissal is logged and swallowed — the app keeps running with degraded auto-update; user can manually retry by relaunching.
- **`--veloapp-obsolete` promoted to a proper handler.** v0.1.23-beta.5 → beta.6 VM testing surfaced this previously-unknown velopack lifecycle flag, which beta.1's catch-all caught and exited cleanly. beta.7 now recognizes it as `HookKind::Obsolete` with a named handler so it stops appearing as `[ERROR] hook: unknown velopack flag` in the launcher log; the runtime behavior is unchanged (log + exit 0 to allow Update.exe to swap `current\`).

### Notes

- v0.1.23-beta.7 is the first build with the fully-automatic in-app updater path. Fresh-install via the MSI; on first launch, accept the UAC prompt for icacls; subsequent updates apply silently with no further UAC prompts.
- Migrations from v0.1.21 / v0.1.22 / v0.1.23-beta.{1..6}: the in-app updater on those builds is broken at varying levels. To get to beta.7, uninstall via Add/Remove Programs and fresh-install the v0.1.23-beta.7 MSI. From beta.7 forward, the updater is fully automatic.

## [0.1.23-beta.6] - 2026-04-28

No code changes. Cut as an in-app update target so v0.1.23-beta.5 fresh installs can exercise the explicit-Apply path now that the install root is user-writable. Tests whether Velopack's swap actually completes when no elevation step is required.

## [0.1.23-beta.5] - 2026-04-28

### Fixed

- **In-app updater swap actually completes (Fix 2 of v0.1.22 yank investigation).** The `--veloapp-install` hook now grants `Authenticated Users:Modify (OI)(CI)` on the install root (`C:\Program Files\WsScrcpyWeb\`), in addition to the existing grant on the data root (`C:\ProgramData\WsScrcpyWeb\`). Velopack's writability self-test on the install root now passes for the running user, which short-circuits the elevated-`Update.exe` re-launch pathway that was silently failing in v0.1.23-beta.3 → beta.4 testing ("Re-launching as administrator" log line followed by zero further log entries from the elevated process). The swap becomes a regular file rename the running user can do directly — no UAC prompt during update apply, no LocalAppData fallback. Trade-off: any logged-in user can modify the binaries at `C:\Program Files\WsScrcpyWeb\`. For a personal-tooling app this is acceptable; multi-tenant deployments may want to revisit (the deferred Phase 6 ACL-tightening item is the natural lever).

### Notes

- v0.1.21 / v0.1.22 / v0.1.23-beta.{1..4} → v0.1.23-beta.5 in-app update is still subject to the older Velopack architecture and will likely fail (their existing Update.exe doesn't have the new ACL). To get to beta.5: uninstall via Add/Remove Programs and fresh-install the v0.1.23-beta.5 MSI. From beta.5 forward, the in-app updater should be functional.

## [0.1.23-beta.4] - 2026-04-28

No code changes. Cut as an in-app update target so v0.1.23-beta.3 fresh installs can exercise the explicit-Apply path now that autoApply is disabled. Tests whether the underlying Update.exe swap actually completes when the user explicitly clicks Apply (vs the loop-on-startup behavior beta.1 → beta.2 surfaced).

## [0.1.23-beta.3] - 2026-04-28

### Fixed

- **In-app updater spawn-loop after failed apply (root cause of v0.1.22 yank).** The Velopack JS SDK's `VelopackApp` defaults `_autoApply = true`, so every Node startup auto-detected a previously-staged nupkg in `<localappdata>\WsScrcpyWeb\packages\` and auto-fired `Update.exe apply`, then exited the Node process. After any failed apply (lock contention, UAC dismissed, or other Update.exe failure), the staged package stayed, and every subsequent app launch re-fired the loop — visible as "UAC prompt for updater that closes silently with the app never coming back." Fix: `VelopackApp.build().setAutoApplyOnStartup(false).run()` in `src/server/index.ts`. Apply now fires ONLY on explicit `UpdateService.applyUpdate` user click. Users with a stuck staged package can recover by closing the app instead of being trapped.

### Notes

- Updating from v0.1.23-beta.1 to this beta is still subject to the underlying Update.exe swap failure (separate root-cause investigation). Use a fresh MSI install of beta.3 instead. To clear a stuck staged package without uninstall, delete `%LocalAppData%\WsScrcpyWeb\packages\*.nupkg`.

## [0.1.23-beta.2] - 2026-04-28

No code changes. Cut as an in-app update target so v0.1.23-beta.1 fresh installs can exercise the in-app updater path under the new argv-logging diagnostic + unknown-flag catch-all from beta.1. The launcher.log entry for the post-Update.exe respawn will reveal which velopack lifecycle flag was tripping `VelopackApp::build().run()` to silent-exit, which feeds the proper handler in v0.1.23 (final).

## [0.1.23-beta.1] - 2026-04-28

Diagnostic-only beta cut. Targets the v0.1.22 in-app updater spawn-loop investigation. Fresh-install only — the in-app updater from v0.1.21 / v0.1.22 to this beta is the same broken Update.exe and will hang/loop the same way.

### Added

- **Argv logging in launcher startup.** `launcher/src/main.rs` now logs `argv: [...]` immediately after collecting args, on every launcher invocation. v0.1.22's Update.exe spawn-loop bug couldn't be diagnosed because we had no record of which velopack lifecycle flag Update.exe was passing on respawn. With this in place, the next failed update flow leaves a per-spawn argv trace in `<dataRoot>\ws-scrcpy-web-launcher.log`.
- **Catch-all handler for unknown `--veloapp-*` flags.** `launcher/src/hooks.rs` now matches any `--veloapp-*` flag not in our explicit `{install, updated, uninstall}` set, logs it via `log::error` (so it stands out), and exits 0. Without this, `VelopackApp::build().run()` silently consumed the unknown flag and exited the process before our supervisor branch fired, which `Update.exe` interpreted as launcher failure and retried indefinitely. The catch-all converts the infinite respawn loop into a single clean exit, so `Update.exe` either completes the swap or surfaces a definitive error instead of hanging.

## [0.1.22] - 2026-04-28 [YANKED]

**This release was yanked on 2026-04-28** after VM testing showed the in-app updater never completes the v0.1.21 → v0.1.22 swap. The fresh-MSI install of v0.1.22 itself works correctly; only the auto-update path is broken across the v0.1.21 → v0.1.22 boundary.

### Known issues (why this was yanked)

- **In-app updater hangs (service mode) or silently fails (local mode).** velopack.log confirms the JS SDK downloads the v0.1.22 nupkg into `<installRoot>\packages\` correctly and hands off to `Update.exe apply --waitPid <pid> --silent --root <installRoot>`. `Update.exe` then enters a retry loop respawning the launcher every ~13 s, and the launcher exits silently without reaching its supervisor, so `current\` is never swapped. Service mode shows `Update.exe` running indefinitely with the service stopped; local mode appears to "succeed" but the post-update launcher reports `v0.1.21` again. Root cause is being investigated in v0.1.23 — likely an unhandled velopack lifecycle flag the launcher exits silently on.
- **To upgrade from v0.1.21 to a future v0.1.23+:** uninstall ws-scrcpy-web via Add/Remove Programs and fresh-install the new MSI. The in-app updater will not work across this version boundary; the v0.1.21 binary's `Update.exe` is the same broken `Update.exe` shipped in v0.1.22, so only a clean reinstall escapes it.

### Added

- **Job Object on Node spawn (Windows).** The launcher adopts the supervised Node child into a process-wide kill-on-close Windows Job Object. When the launcher exits — graceful, killed by Servy stop, or torn down by MSI uninstall — the OS automatically terminates Node and every descendant (node-pty, scrcpy.exe, etc.). Fixes orphaned `node.exe` after service uninstall, and the cosmetic `pty.node` MSI-rename-to-`.rbf` residual observed in v0.1.21 (the running Node held the `.node` loaded; killing it on launcher exit means the file is no longer locked when the MSI scheduler runs). No-op on non-Windows. Failure to create or assign the job is logged and swallowed — the launcher continues with v0.1.21 behavior.

### Removed

- **Setup.exe artifact.** The PerMachine MSI is the only Windows install path from v0.1.22 forward. Setup.exe was kept through v0.1.21 as a per-user fallback during the migration window; the multi-user / service-mode / Velopack-under-SYSTEM trade-offs make it no longer worth shipping. CI release workflow drops the Setup.exe sign + upload steps and the windows-final + GitHub-Release artifact patterns. README, RELEASING.md, and PROGRAMDATA-MIGRATION.md updated.
- **v0.1.20 service-install env-var passthrough.** `ServiceApi.handleInstall` no longer freezes the installing user's `LOCALAPPDATA`/`APPDATA`/`USERPROFILE` into the service-Node's env block. The Phase-2 `VelopackLocatorConfig` override (v0.1.21) makes the service-Node's `UpdateManager` work under SYSTEM at root cause; the env-var workaround was kept only as belt-and-braces during the migration window.
- **v0.1.20→v0.1.21 legacy-config migration shim** (`launcher/src/migrate.rs`). The one-shot copy from `%LocalAppData%\WsScrcpyWeb\config.json` to `<dataRoot>\config.json` was only meaningful during the in-place upgrade window. v0.1.22+ ships exclusively as a fresh PerMachine MSI install, so the shim is dead code on every install path.

### Fixed

- Pre-existing clippy regressions surfaced by the rust-clippy 1.95 toolchain bump (doc list overindent in `common/src/tray.rs`, field-reassign-with-default in `launcher/src/user_session_spawn.rs`) so `cargo clippy --workspace -- -D warnings` stays green.

## [0.1.21] - 2026-04-28

### Changed

- **Install layout migrated to per-machine** (Windows). Binaries now live at `C:\Program Files\WsScrcpyWeb\` (Velopack-managed); writable runtime state (`config.json`, `dependencies\`, logs) lives at `C:\ProgramData\WsScrcpyWeb\` with `Authenticated Users:Modify (OI)(CI)` granted at MSI install time. **Existing v0.1.x users must uninstall + reinstall** — Velopack auto-update cannot migrate across install locations. Detailed upgrade instructions in `docs/PROGRAMDATA-MIGRATION.md`. The Setup.exe artifact still ships through v0.1.21 as a fallback for users who prefer per-user installs without UAC on every update; v0.1.22 will drop Setup.exe.
- **Service-mode + multi-user state is now coherent.** All users (and the Local System service-Node) share `C:\ProgramData\WsScrcpyWeb\config.json` and the downloaded `dependencies\` tree. Settings changed in any context are visible to all others. Bob's first login after Alice installs the service automatically picks up the existing service URL via the shared config — no second WelcomeModal, no orphaned per-user instances.
- **Updates require UAC every apply** (consequence of per-machine install). Velopack's `Update.exe` writes to Program Files which non-admin users cannot modify. The signed Update.exe triggers a single UAC prompt per update. Documented in PROGRAMDATA-MIGRATION.md.
- **Tray menu** — left-click now opens the app in the default browser (the most common action becomes the cheapest gesture). Right-click shows a popup menu with "Open ws-scrcpy-web" + "Exit". Pre-v0.1.21 left-click was the exit-confirm dialog only; that path moved to the right-click menu's "Exit" item. Both the user-mode launcher tray and the standalone service-mode tray helper share the new menu.

### Added

- **Two-root path resolution** under the hood. `installRoot` (binaries, Velopack-managed) and `dataRoot` (writable state) are now distinct concepts in both the TS server (`resolveDataRoot` + `Config.dataRoot`) and the Rust launcher (`Paths::data_root`). `dataRoot` defaults to `%PROGRAMDATA%\WsScrcpyWeb` on Windows and collapses to `installRoot` on non-Windows hosts (Linux AppImage layout unchanged).
- **VelopackLocator runtime override.** `UpdateService.init()` builds a `VelopackLocatorConfig` from `installRoot` and passes it to `new UpdateManager(...)`. Velopack no longer relies on `%LOCALAPPDATA%`-walking auto-locate, fixing the v0.1.20 service-mode failure ("Could not auto-locate app manifest. Treating as dev mode.") at root cause. The v0.1.20 `LOCALAPPDATA`/`APPDATA`/`USERPROFILE` env-var passthrough in `ServiceApi.handleInstall` remains in place as belt-and-braces; v0.1.22 will remove it.
- **One-shot legacy-config migration shim** (`launcher/src/migrate.rs`). When v0.1.21+ runs over a v0.1.20 install (i.e. Setup.exe → MSI upgrade where the user retained `%LocalAppData%\WsScrcpyWeb\config.json`), the launcher copies the legacy config to `<dataRoot>` on first start so settings carry over. Idempotent; no-op once `<dataRoot>\config.json` exists.
- `docs/PROGRAMDATA-MIGRATION.md` — full upgrade guide for existing v0.1.x users.

### Fixed

- **Service-mode auto-update silently bailed.** Per-machine install resolves Velopack auto-locate cleanly without env-var hackery; the service-Node (Local System) and user-mode launcher both see the same install root via the explicit `VelopackLocatorConfig`. UI Settings → Updates now reports the live version + channel in service mode instead of dev-mode copy.
- **Settings → Updates section blanked out on every PATCH** (toggling `autoUpdate`, changing `githubOwner` / channel / interval). The frontend's response-shape "tolerate either flat or wrapped" type-narrowing was always-true because `UpdatesStatusResponse` itself has a `status: UpdateState` string field, so the response was unwrapped to the literal status string and `syncControlsToStatus` painted every control with `undefined`. Pre-existing bug across the entire v0.1.x line; surfaced during v0.1.21 manual validation. Drop the wrapping check; read the flat shape directly.
- **MSI uninstall left the Windows service registered.** The Velopack `on_uninstall` hook invoked `servy-cli stop WsScrcpyWeb` and `servy-cli uninstall WsScrcpyWeb` with positional args; Servy 8.2's CLI requires `--name <NAME>` for service-targeting commands. The v0.1.5 Servy-8.2 flag migration updated `elevated_runner.rs` (in-app "uninstall service" button) but missed `hooks.rs::run_servy`. Result: servy-cli ran but the SCM entry survived MSI uninstall + reboot. Three call sites fixed (stop / uninstall / restart).
- **MSI uninstall left the tray helper resident + HKCU Run key behind.** After the Servy fix removed the SCM entry cleanly, the standalone `ws-scrcpy-web-tray.exe` helper kept running (its on-disk exe MSI-renamed to `C:\Config.Msi\<id>.rbf` and scheduled for delete-on-reboot). The `HKCU\...\Run\WsScrcpyWebTray` entry pointed at the deleted path. Both cleanups exist in `elevated_runner::uninstall_service` (the in-app "uninstall service" path) but were absent from the Velopack `on_uninstall` hook. Mirrors the in-app uninstall: `taskkill /F /IM ws-scrcpy-web-tray.exe` + `unregister_tray_run_key`.

## [0.1.20] - 2026-04-28

### Fixed

- **First-run dependency UI didn't auto-refresh.** The `FirstRunBanner` (top-of-page "missing dependency" warning) and `DependencyPanel` (Settings dependency table) were both one-shot — they only refreshed on user action (Retry click / "check for updates" button). When the background dep manager finished installing Node/ADB/scrcpy-server, the UI kept showing stale "Not installed / Unknown" until a full page reload. Both now poll `/api/dependencies` every 15 s. The banner stops polling and hides itself once `pendingDeps.length === 0`. The panel skips a poll tick while the user's own check/update/restart action is in flight (a `busy` flag) so an in-progress "Updating…" button never gets clobbered mid-action.
- **Service install redirect landed on Welcome modal instead of Service first-run modal.** `ServiceApi.handleInstall` persisted `installMode = '*-service'` to `config.json` *after* Servy had already started the service. The new service-Node loaded `Config.getInstance()` synchronously at startup, before the local instance had committed the new mode to disk, and served `/api/config` from its stale in-memory copy showing the old `installMode`. The post-redirect page then routed to `WelcomeModal` instead of `ServiceFirstRunModal` because `installMode` didn't match `'user-service' | 'system-service'`. `installMode` now writes to disk *before* the Servy install fires; install failures revert it.

### Added

- **Service-mode Velopack support (experimental).** When the service-Node runs as Local System, Velopack's `UpdateManager` constructor previously failed with "Could not auto-locate app manifest" because `%LOCALAPPDATA%`, `%APPDATA%`, and `%USERPROFILE%` resolve to the system profile (`C:\Windows\system32\config\systemprofile\…`) where no Velopack state exists, and the Settings → Updates section showed dev-mode copy. `ServiceApi.handleInstall` now freezes the installing user's `LOCALAPPDATA`/`APPDATA`/`USERPROFILE` into the service's env block via Servy's `--envVars`. Both the service-launcher (Velopack init in Rust) and the supervised Node (UpdateService init) see real user paths instead of the system profile. **Risk:** if Velopack stages an update from service mode, files staged into the user's `LOCALAPPDATA` will be SYSTEM-owned; a later user-mode launcher may trip on ACLs. Watch during real update tests.

## [0.1.19] - 2026-04-28

### Notes

- Updater validation — no code changes. Cut to give v0.1.18 a target to detect on a fresh install (local + service mode end-to-end).

## [0.1.18] - 2026-04-28

### Fixed

- **Updater "check failed: 404" against GitHub Releases.** `buildFeedUrl` returned `https://github.com/<owner>/<repo>/releases/latest/download/` — that's GitHub's browser-friendly redirect alias for asset URLs. Velopack doesn't recognize it as a GitHub source, so it fell through to its static-URL HTTP client which can't navigate the 302→302→`release-assets.githubusercontent.com` chain GitHub serves and surfaced "404." Now returns the bare repo URL (`https://github.com/<owner>/<repo>`); Velopack detects it as a GitHub source and queries `api.github.com/repos/<owner>/<repo>/releases` directly — no redirect chain.

## [0.1.17] - 2026-04-28

### Fixed

- **In-app updater detection used the wrong marker file.** v0.1.0–v0.1.16 looked for `sq.version` (Squirrel.Windows naming, Velopack's predecessor) at the install root. Velopack actually drops `Update.exe` there. Combined with the v0.1.15 `installRoot` fix, this was the second of two stacked wrong assumptions keeping the updater in permanent dev mode. Now checks `Update.exe` on Windows; Linux AppImage continues to be treated as dev mode.
- **`server.log` had no timestamps.** `Logger` already wrote ISO timestamps to its own `ws-scrcpy-web.log` file, but the `console.log/warn/error` output that the launcher captures into `server.log` was bare `[tag] message`. `console.*` calls now include the timestamp prefix too, so `server.log` and `launcher.log` align side-by-side.

### Added

- **Current app version surfaced in Settings → Updates section.** Both production and dev mode now show `current: vX.Y.Z` at the top of the Updates panel — makes it obvious what build is on disk even when the updater can't run. New `getAppVersion()` helper reads `package.json` directly (replaces the `npm_package_version` env-var path which only worked under `npm start`).
- **First-run dependency-warning note in `WelcomeModal`.** Amber callout warning users that the dep manager fetches Node, ADB, and scrcpy-server in the background on first launch — up to ~3 minutes on slower networks — and that any "missing dependency" warnings during that window clear themselves automatically. Stops users from clicking around assuming something's wrong.

## [0.1.16] - 2026-04-28

### Notes

- Update-flow validation — no code changes. Cut to exercise the in-app updater end-to-end against a v0.1.15 install (local instance + service instance).

## [0.1.15] - 2026-04-28

### Fixed

- **In-app updater never noticed new releases.** `UpdateService` derived its install root from `path.dirname(process.execPath)`, which under our launcher resolves to `<base>\seed\node\` or `<base>\dependencies\node\` — neither contains the Velopack `sq.version` marker, which lives at `<base>\` alongside `current/`. The service silently fell into "dev mode" on every startup and skipped its check. Anchoring at `__dirname` (the webpack bundle's location, always `<base>\current\dist\`) and walking two levels up reliably hits the install root. Same pattern as the v0.1.10 scrcpy-server seed-path fix.

## [0.1.14] - 2026-04-28

### Fixed

- **Welcome modal didn't redisplay after dismiss-without-checkbox.** Pre-v0.1.14 the gate ANDed `firstRunComplete === false` with `!welcomeDismissed`. Clicking "no, run on demand" without the checkbox PATCHed `firstRunComplete=true` server-side but left `welcomeDismissed` unset, so the gate evaluated `false && true = false` and the welcome modal stayed silent on refresh — `PortChangeModal` fired instead. Gate now uses the localStorage flag alone; modal redisplays until the user explicitly checks "don't show again," matching the original spec.
- **Port modal could redundantly fire on first-run pages.** Both `WelcomeModal` and `ServiceFirstRunModal` already include bookmark-hint copy in their callouts, so the port modal would have been duplicate noise. Constructors now eagerly set `bookmarkDismissedForPort = currentPort` — state-level enforcement of "first-run overrides port modal," not just code-path order in `index.ts`. Later port changes still re-trigger `PortChangeModal` correctly because the saved port mismatches the new one.

## [0.1.13] - 2026-04-28

### Notes

- Upgrade test — no code changes. Cut to exercise the in-app update notification flow against a v0.1.12 install.

## [0.1.12] - 2026-04-28

### Fixed

- **Shell modal "File not found:" on clean VM.** `RemoteShell.createTerminal` was passing bare `'adb.exe'` to `pty.spawn`, which falls back to system `PATH` — a clean Win11 VM has no adb on PATH, so the spawn ENOENT'd silently and the xterm went black. Same family of bug as the v0.1.4 `AdbClient` bare-`'adb'` issue and the v0.1.9 `scrcpy-server dist/assets/` issue. Now resolves via `Config.getInstance().adbPath` (`<deps>/adb/adb.exe`) per the Local Dependencies Only rule.

### Added

- **Settings → "Reset welcome prompts" button.** Clears the three v0.1.10 localStorage gates (`welcomeDismissed`, `serviceFirstRunDismissed`, `bookmarkDismissedForPort`) and reloads the page so the appropriate modals re-fire. Two-step UX with explanatory copy on confirm; only touches first-run gates, not audio prefs / theme / scan history. Uninstall does not (and cannot reliably) clear browser localStorage; this gives users a clean reset path that doesn't require clearing their entire browser cache.

## [0.1.11] - 2026-04-28

### Fixed

- **Redundant `PortChangeModal` after first-run dismiss.** v0.1.10's `WelcomeModal` and `ServiceFirstRunModal` both contain bookmark copy in their info-callouts, but dismissing them with "don't show again" only set the per-modal flag — `bookmarkDismissedForPort` was untouched, so `PortChangeModal` fired on the very next page load asking the user to bookmark a port they had just acknowledged. Both modals now also save the current port to `bookmarkDismissedForPort` when dismissed with the checkbox; later port changes still re-trigger `PortChangeModal` correctly because the saved port mismatches the new one.

## [0.1.10] - 2026-04-28

### Fixed

- **scrcpy-server missing on clean-VM installs.** v0.1.9's `checkInstalled` for scrcpy-server returned `SERVER_VERSION` unconditionally without checking the filesystem, so `autoInstallMissing` skipped both the seed-promote and the network-download paths. The seed-promote path itself was also pointed one directory too high (`<installRoot>/seed/...` vs the actual `<installRoot>/current/seed/...`). Both fixed; `dependencies/scrcpy-server/` now populates on first run.
- **node-pty unavailable on clean VM (false-positive v0.1.8 fix).** `NodePtyResolver` always fetched the prebuilt manifest from GitHub before doing anything else, so a clean VM with restrictive networking returned `available: false` even with a perfectly good `pty.node` already shipped in the installer. v0.1.10 tries the bundled `import('node-pty')` first and only falls back to the manifest+download path if that import fails (e.g., ABI mismatch after a Node auto-update).
- **First-run modal re-fired after service uninstall + reinstall.** Pre-v0.1.10 gating used server-side `firstRunComplete` / `serviceFirstRunSeen` flags, which got reset across uninstall/reinstall cycles. Modal gating now runs entirely off localStorage flags that survive mode flips and are only set when the user explicitly checks "don't show again."

### Added

- **"Don't show again" checkboxes on `WelcomeModal` and `ServiceFirstRunModal`.** Dismissal only persists when the box is checked; otherwise the modal returns on the next page load. Resets only via browser cache clear (no in-app reset by design).
- **`PortChangeModal`** — bookmark reminder shown on every page load when the saved `bookmarkDismissedForPort` ≠ current port. Same "don't show again" pattern; changing ports later auto-clears the effective dismissal because the saved port no longer matches.
- **`firstRunGate.ts`** — typed wrapper around the three new localStorage keys (`wsScrcpy.welcomeDismissed`, `wsScrcpy.serviceFirstRunDismissed`, `wsScrcpy.bookmarkDismissedForPort`) with private-mode-safe getters/setters.

## [0.1.9] - 2026-04-28

### Fixed

- **scrcpy-server architectural fix.** The runtime path for the JAR (read by `DeviceProbe.ts` and `ScrcpyConnection.ts`) used to be `<install>/current/dist/assets/scrcpy-server` — the build-bundled copy. Meanwhile `DependencyManager` registered scrcpy-server in the dep updater and downloaded user-clicked-update versions to `<deps>/scrcpy-server/scrcpy-server`. So the dep updater was *load-bearing but invisible*: the path it wrote to was never read by runtime code, and a Velopack app update would silently overwrite the bundled `dist/assets/scrcpy-server` with whatever the build pipeline shipped — possibly older than what the user's dep updater had pulled. Same family of bug as the v0.1.4 bare-`'adb'` and v0.1.6 `process.execPath` issues: runtime code resolving to the wrong location.
  - Removed `import '../../assets/scrcpy-server';` from `DeviceProbe.ts` and `ScrcpyConnection.ts` (those imports tell webpack to copy the asset into `dist/`).
  - Replaced `path.join(__dirname, 'assets', 'scrcpy-server')` with a `serverFile()` getter that returns `path.join(Config.getInstance().dependenciesPath, 'scrcpy-server', 'scrcpy-server')`. Same architectural pattern as `Config.adbPath` from v0.1.4.
  - `DependencyManager.autoInstallMissing` now seed-promotes `<install>/seed/scrcpy-server/scrcpy-server` → `<deps>/scrcpy-server/scrcpy-server` on first run (idempotent — no-op if dest exists). Offline-capable: a fresh install on a network-restricted host still has a working scrcpy-server; the dep updater overwrites the seed-promoted copy with the latest from Genymobile when run.
  - `scripts/stage-publish.mjs` stages `assets/scrcpy-server` → `publish/seed/scrcpy-server/scrcpy-server` so Velopack ships the seed alongside `seed/node/`.
- **Uninstall-handoff failure when the user-session launcher inherited Local System's environment.** v0.1.8's `user_session_spawn.rs` called `CreateProcessAsUserW(.. lpEnvironment = None)`, which means the spawned child inherits the **caller's** environment — and the caller is a Local System process, not the user. So the new launcher started up with `%APPDATA%`, `%LOCALAPPDATA%`, `%USERPROFILE%`, `%TEMP%` all pointing at `C:\Windows\system32\config\systemprofile\…`. Velopack init reads `%APPDATA%` for its update cache, various launcher startup paths break, and the spawned launcher exited before reaching its supervisor's HTTP listen — `discoverServicePort` would then time out, the handoff would return false, and the fallback direct uninstall would kill the service from session 0. Result: service uninstalled, but the user's tab said "can't reach server" and no local instance came up.
  - Fix: build the user's actual environment block via `CreateEnvironmentBlock(env_ptr, user_token, FALSE)` and pass `env_ptr` as `lpEnvironment`. Add `CREATE_UNICODE_ENVIRONMENT` to `dwCreationFlags` (mandatory when `lpEnvironment` came from `CreateEnvironmentBlock`, which always returns UTF-16). Call `DestroyEnvironmentBlock` after spawn returns. Adds `Win32_System_Environment` feature to the windows-rs crate.
- **`SettingsModal.onUninstallService` now honors `data.redirectTo`.** v0.1.8 added the redirect handling to the install path but missed the uninstall path. When the service-instance API successfully spawned a user-session local launcher and returned 200 with `redirectTo` + `resumeToken`, the frontend ignored both fields and called `refreshService()` instead. UI showed "service still running" because the local instance hadn't fired the actual uninstall yet, button reset, user thought nothing happened. Now the frontend navigates to `redirectTo` (carrying the resume token in URL params) so the local instance can pick up the work in its own UAC context.
- **WelcomeModal no longer shows on service-mode instances regardless of `firstRunComplete`.** v0.1.8 service install would auto-redirect the user to the new service instance, which then re-showed the welcome modal because its in-memory `firstRunComplete` was still false (Config was loaded before the local instance flipped the flag on disk). Gating the modal trigger on `installMode !== 'user-service' && installMode !== 'system-service'` makes the bug structurally impossible — service instances by definition don't need an install-mode prompt.

### Added

- **Auto-open browser on first run (user mode only).** When a fresh local user instance starts (`firstRunComplete === false` AND `installMode` is not service-mode), the server invokes `cmd /c start "" <url>` (Windows) / `xdg-open <url>` (Linux) / `open <url>` (macOS) so the user's default browser lands directly on the welcome modal instead of requiring them to remember the URL. Best-effort, detached + ignored stdio. New `src/server/openBrowser.ts` module.
- **Bookmark hint paragraph in WelcomeModal.** Tells the user to wait until after picking install mode before bookmarking, because picking "yes install service" shifts the server to a new port. Styled as an info callout.
- **`ServiceFirstRunModal`** (modal, not banner). Shows once when a service-mode instance loads for the first time — informational, says "the service will start at boot, this URL stays valid across reboots, bookmark it now." Single dismiss button. Persists `serviceFirstRunSeen: true` via PATCH `/api/config` so it never re-fires.
- **`serviceFirstRunSeen` flag in `AppConfig`.** Separate from `firstRunComplete` to keep the two flows independent. Validated via `validateField('serviceFirstRunSeen', ...)` and persisted to `config.json`.
- **Post-uninstall bookmark reminder.** Resume overlay text on the local instance after a service uninstall now reads "service uninstalled. ws-scrcpy-web is running in user mode now (port {LOCAL_PORT}). if you bookmarked the service-mode page, update it to this URL." Visible for 5s instead of 2s.

### Audit notes

- **node-pty path-dependency audit closed.** User confirmed in v0.1.8 testing that node-pty resolution is working correctly on both the local host and the test VM. The audit conclusion from v0.1.8 (resolver chain is local-deps-correct) holds. The earlier-reported "node-pty issue on test box" appears to have been a transient first-run download artifact, not a path-resolution bug.

## [0.1.8] - 2026-04-28

### Fixed

- **Install modal stuck on "installing…" forever after a successful service install.** v0.1.7's `elevatedRunner.ts` used PowerShell's `Start-Process -Wait -PassThru` to wait for the elevated child, but `-Wait` is unreliable for `-Verb RunAs` because the elevated process runs in a different logon session and `-Wait` cannot always track cross-session children. Service install would actually succeed (binary registered, port bound) but the Node `fetch` call never resolved, leaving the welcome modal indefinitely greyed out with the "installing…" label. v0.1.8 replaces the wait pattern with **result-file polling**: PowerShell kicks off `Start-Process -Verb RunAs` and exits immediately; Node polls `fs.existsSync(resultPath)` at 200ms intervals up to a 5-minute timeout (UAC dialog can legitimately stay up that long). Bulletproof against cross-session quirks. Frontend resolves cleanly whether the user accepts UAC, declines it, or walks away from the keyboard.
- **Port-change "restart and open new tab" actually does that now.** Settings → port change → Apply previously updated `config.json` and showed "server will restart on the new port. browser will redirect." but no restart fired and no redirect happened. v0.1.8 wires `PATCH /api/config`'s `restartRequired: true` path to (a) write `<deps>/.restart` to trigger the supervisor's restart loop, (b) `process.exit(75)` 1s after responding so the supervisor restarts Node on the new port, and (c) include `redirectTo` in the response so the frontend redirects to the new port 4s later. Settings UI status text and timing aligned with reality.

### Added

- **Install-flow auto-redirect (Windows).** When the user clicks "yes install service" on the local app, the elevated helper installs and starts the service, then the local instance polls `localhost:8000..8099/api/whoami` (new endpoint, exposes `pid`/`installMode`/`version`) for an instance that is not us. The discovered URL is returned as `redirectTo` in the install response. Frontend writes "service mode active. switching you over…" and navigates 500ms later. The local instance schedules its own `process.exit(0)` 5s after responding so the user doesn't end up with two app instances and two tray icons. Result: one click, one UAC prompt, one seamless mode switch — no port confusion, no manual cleanup.
- **Uninstall-flow Path A handoff.** When the user clicks "uninstall service" while connected to the service-instance UI, the service-Node process detects it is running as Local System (via `os.userInfo().username === 'SYSTEM'`) and routes through a new cross-session spawn helper instead of attempting to uninstall itself (which would terminate the user's own browser tab mid-request). The helper uses Windows Terminal Services APIs (`WTSGetActiveConsoleSessionId`, `WTSQueryUserToken`, `CreateProcessAsUserW` — all in a new `launcher/src/user_session_spawn.rs` module) to spawn a fresh user-session local launcher. Once the new launcher's HTTP server is reachable, the service-Node issues a single-use **resume token** and returns it with `redirectTo`. The user's browser navigates to the local instance with `?resume=uninstall-service&token=…`. The local-instance frontend reads the URL params, posts to `/api/service/uninstall` with an `X-Resume-Token` header, and the local-instance API consumes the token and runs the uninstall in its own UAC context. Result: zero manual user steps. Service uninstall feels like a single-click action even though it spans two app instances.
  - **Single-use, time-bounded, action-bound resume tokens** — 16-byte hex strings stored at `<install>/.resume-tokens/<token>.json` with a 10-minute TTL. Validated, deleted-on-success in one operation. Won't replay (single-use), won't fire on a stale URL bookmarked yesterday (expiry), won't authorize the wrong action (action binding). Defense scope: accidental replay and confused-deputy attacks; not against an attacker with filesystem read access (acceptable threat for a local tray app managing a local service).
  - **Tray helper cleanup on uninstall.** v0.1.6/0.1.7 unregistered the HKCU Run-key on uninstall but didn't kill the running tray icon, leaving it pointing at a service that no longer exists. v0.1.8's elevated uninstall handler also runs `taskkill /F /IM ws-scrcpy-web-tray.exe` so the tray icon disappears immediately.
- **Single-instance launcher mutex now allows one elevated + one non-elevated instance to coexist.** v0.1.7 already namespaced by integrity level (`-User` vs `-Admin` mutex names). v0.1.8 extends the design to handle the v0.1.8 uninstall handoff case — the service-spawned local launcher in user session and any pre-existing user-session launcher get the same `-User` mutex; the launcher exits cleanly if it's the second one, leaving the existing one to handle the resume token. (The mechanism was already in place; this is an explicit acknowledgment that the design composes correctly with the new flow.)
- **`launcher.log` timestamps + `<deps>/server.log` plumbing** were added in v0.1.7 but invaluable for v0.1.8 testing — the install-modal-hang root-cause analysis took minutes instead of hours because the launcher.log made the cross-session timing visible.
- **`/api/whoami` endpoint** exposes `{ pid, installMode, version }` for cross-instance identification during install-flow port discovery. Deliberately minimal — no privileged data.
- **`shellReason` surfaced in `/api/capabilities`** when node-pty resolution fails. Previously the shell modal was silently hidden when the resolver returned `available: false`; now the frontend can render an actionable error (which the user can paste into a bug report).

### Audit notes

- **node-pty path-dependency audit completed.** The resolver chain (`src/server/NodePtyResolver.ts`) is verified local-deps-correct: downloads from our own GitHub releases (`bilbospocketses/ws-scrcpy-web/releases/.../node-pty-prebuilds-v<version>/<key>.tar.gz`) → caches at `<deps>/node-pty/v<version>/<platform>-<arch>` → copies the prebuilt to `<install>/current/node_modules/node-pty/build/Release/`. No system PATH lookups, no env-var resolution, no ambient state assumptions. The reported test-box failure is more likely a missing-prebuilt-for-host-ABI case than a path-resolution bug; the new `shellReason` surfacing should make that diagnosable from a screenshot in future reports.

## [0.1.7] - 2026-04-27

### Fixed

- **Service install no longer requires the user to manually launch as Administrator.** v0.1.6 returned 503 with "service install requires running ws-scrcpy-web as Administrator" because Velopack installs ws-scrcpy-web per-user under `%LocalAppData%` without elevation, and Servy's CLI needs admin to register services with SCM. The v0.1.6 guard correctly identified the problem but pushed the burden onto the user (right-click → Run as administrator on every launch). v0.1.7 elevates *only when needed*: clicking "yes install service" or Uninstall now spawns the launcher binary with a new `--elevate-and-run` argv mode via PowerShell's `Start-Process -Verb RunAs`, which fires the UAC prompt for that single operation. The main app continues to run unelevated. Implementation:
  - **`launcher/src/elevated_runner.rs` (new)** — Rust handler that reads a JSON args file, runs `servy-cli` + `reg.exe` (HKCU Run-key for tray) + tray spawn directly in the elevated process, and writes a structured result JSON for the parent to read.
  - **`src/server/service/elevatedRunner.ts` (new)** — Node-side counterpart. Writes args to a temp file, spawns the launcher with `Start-Process -Verb RunAs -Wait -PassThru`, reads the result. UAC denial is detected (PowerShell exits non-zero, no result file) and surfaced as a structured `{ ok: false, errorMessage: 'user declined elevation' }` payload.
  - **`src/server/service/ServyClient.ts`** — `install()` and `uninstall()` route through `runElevated`. `status()` switches from `servy-cli status` (which would also need admin) to `sc.exe query <name>` (read-only SCM access, no admin needed) so routine status polling never prompts UAC. `start()` / `stop()` / `restart()` throw "not yet wired through elevation helper" — no current UI calls them, and adding them needs the spawn-local-and-redirect flow planned for v0.1.8.
  - **New `ServiceInstallError` class** carries the elevated helper's structured result so callers can detect UAC denial via `err.isUacDeclined()`. `ServiceApi` maps that case to **HTTP 403** so the frontend can render UAC-aware retry instead of a generic 500.
  - The v0.1.6 admin guard (`isWindowsAdmin()` + `ServiceApi` 503) is removed entirely; elevation is handled at the operation site, not at the API boundary. `src/server/isWindowsAdmin.ts` is deleted.

### Added

- **Timestamps on every `launcher.log` line.** Format: `YYYY-MM-DD HH:MM:SS.fff` UTC. The v0.1.6 service-mode debugging tonight was slower than it needed to be because adjacent log entries had no time information — multiple "supervisor: server started (pid X)" lines could have been seconds or hours apart. Implementation in `launcher/src/log.rs` is dependency-free (closed-form Unix-epoch-to-civil-date math, no chrono/time crate) so the launcher binary stays tiny.
- **Server stdout/stderr captured to `<install>/dependencies/server.log`.** Without this, a Node child crash during boot (port-bind failure, native module load error, unhandled rejection) was completely invisible — release-build launchers detach from the console, and we never redirected stdio. The v0.1.6 "service runs but app unreachable" + "no port bound, no idea why" debugging required manually running Node from PowerShell to see the actual error. Now the same information lands in `server.log` automatically.
- **Single-instance launcher guard with integrity-level namespacing.** Windows named mutex (`Local\WsScrcpyWeb-SingleInstance-User` for medium-integrity, `Local\WsScrcpyWeb-SingleInstance-Admin` for high-integrity) prevents accidental duplicate launches while *intentionally* allowing one non-elevated and one elevated instance to coexist. The legitimate use case: a user has the normal app running in their tray, then needs to do a service install/uninstall — they can right-click → Run as administrator to get a parallel admin instance, do the operation, and exit it. Same-integrity duplicates (two non-elevated, two elevated) are still blocked. Implementation in `launcher/src/single_instance.rs`. Velopack hooks and elevate-and-run helpers skip the guard because they legitimately race with a running instance.

### Known issues queued for v0.1.8

- **Port-change "restart and open new tab" does nothing.** Settings → port change → Apply: server doesn't restart, no new tab opens, page stays as-is. Needs a repro pass on the client/server contract.
- **Uninstalling from a service-running session kills the user's browser tab.** When the user is interacting with the service-hosted web UI (browser pointed at the service's port) and clicks Uninstall, the elevated helper stops + deletes the service, which terminates the running web server, which kills the user's tab. v0.1.7 workaround: stop the service via `services.msc` first, OR launch a separate non-service local instance (now possible thanks to the integrity-namespaced single-instance guard) and uninstall from there. v0.1.8 will detect service-mode-self-uninstall and spawn-local-and-redirect automatically.
- **node-pty path-dependency audit.** Earlier user report: node-pty resolution may be looking for a system install rather than the local `dependencies/node-pty/`. Same family of bug as the v0.1.4 bare-`'adb'` and v0.1.6 `process.execPath` issues. Audit deferred to v0.1.8 to keep v0.1.7 shippable.

## [0.1.6] - 2026-04-27

### Fixed

- **Windows service mode now actually runs the app.** v0.1.5 fixed Servy's install flag names so the wizard stopped erroring out, but service install was still broken in three deeper ways that only surfaced once you clicked through the install:
  - **`binPath` was wrong.** `ServiceApi.ts` passed `process.execPath` — the currently-running Node binary — as the executable Servy should launch. Servy then ran `node.exe` with no script argument, Node sat idle in REPL mode, port 8000 never bound, the wrapper reported RUNNING to SCM but the app was unreachable. Same architectural failure pattern as the v0.1.4 bare-`'adb'` bug: trusting an ambient resolution (`process.execPath` resolves through PATH in dev) instead of an explicit local-deps path. v0.1.6 binds `binPath` to `<install>/ws-scrcpy-web-launcher.exe`, the packaged launcher, which already knows how to spawn Node + supervise + manage the lifecycle. Existence-check before passing to Servy so dev/from-source runs return a clear 500 rather than installing a broken service.
  - **`startupDir` was never set.** Servy logs showed `Working directory fallback applied: C:\nvm4w\nodejs` — Servy fell back to the directory of the (wrong) `binPath`, and the launcher's relative resolution of `seed/`, `dependencies/`, `dist/` silently broke. v0.1.6 adds `startupDir` to `ServiceInstallOptions` and pins it to the install root on Windows. SystemdClient on Linux now emits a `WorkingDirectory=` directive from the same field.
  - **Service didn't auto-start after install.** Servy's `install` subcommand only registers the service; it doesn't start it. With `--startupType Automatic`, Windows would have started it at next boot, but the welcome modal's "yes install service" UX leads users to expect the service to come up live. v0.1.6 calls `servy-cli start --name <name>` immediately after `install`. Wrapped in try/catch so a start failure surfaces as a warning + a "stopped" status, not a failed install.
- **Service status was always "not installed."** v0.1.5 used `servy-cli list` to derive status, but **Servy 8.2 has no `list` subcommand at all** — invoking `list` fell through to Servy's help text, which our `parseServyListStatus` parsed and never matched. UI showed "not installed" even when the service was registered and running. v0.1.6 replaces the list-parser with `parseServyStatus` that calls `servy-cli status --name <name>` and matches Servy 8.2's actual output (`Service status for '<name>': <State>`). Servy returns non-zero with a "service not found" message when the service is absent; we map that one specific case to `'not-installed'` and rethrow other errors so genuine failures (binary missing, permission denied) surface to the API layer.
- **Admin elevation was unguarded.** Servy CLI requires Administrator to register services with SCM, but Velopack installs ws-scrcpy-web per-user under `%LocalAppData%` without elevation by default. An unelevated user clicking "yes install service" would either hit a UAC prompt that hung `execFileSync` (browser sees "couldn't reach server") or get a confusing 500. v0.1.6 adds `isWindowsAdmin()` (probes via `net session`) and `ServiceApi` returns `503` with an actionable "service install requires running ws-scrcpy-web as Administrator" message before invoking Servy when the process isn't elevated.
- Added `--recoveryAction RestartProcess` to install argv. v0.1.5 omitted `--recoveryAction` and Servy logs showed `recoveryAction: None`, so a child crash had no recovery — the wrapper would just stop. RestartProcess works for every supported account (including Local Service / Network Service if we ever switch off Local System).

### Migration note for users on v0.1.4 / v0.1.5

If you installed the Windows service via the welcome modal on v0.1.4 or v0.1.5, the service is registered with a broken configuration that points at Node-with-no-script. Clean up before reinstalling:

```
servy-cli.exe stop -n WsScrcpyWeb
servy-cli.exe uninstall -n WsScrcpyWeb
```

Then run ws-scrcpy-web v0.1.6 as Administrator and re-enable service mode from Settings → Service.

## [0.1.5] - 2026-04-27

### Fixed

- **Service install wizard hard-failed with "Option 'binPath' is unknown."** The Windows ServyClient was passing `--binPath`, `--account`, `--startType`, and `--logPath` — none of which are valid Servy 8.2 CLI flags (those names look like NSSM, which Servy was originally inspired by but does not match). Servy 8.2 uses `--path`, `--startupType`, `--stdout`, `--stderr`, and `--user` (the latter omitted entirely now). The bug was hidden during v0.1.4 fresh-VM smoke because that smoke stopped at "Setup runs, app launches, page reachable" — nobody clicked "yes install service" on the welcome modal. Fixed by:
  - Rewriting the install args in `src/server/service/ServyClient.ts` to use Servy 8.2's actual flag names: `--path` (not `--binPath`), `--startupType` (not `--startType`), and `--stdout` + `--stderr` (not `--logPath`, both pointed at the same file for a unified service log).
  - Dropping `--account` entirely. The Windows service now runs as Local System (Servy's default when `--user` is omitted), which side-steps password capture in the welcome modal and is the standard for tray-app service installs.
  - Removing the `account: ServiceAccount` field from the cross-platform `ServiceInstallOptions` interface, dropping the `ServiceAccount` type from `src/server/service/ServiceClient.ts`, and stripping the corresponding plumbing from `src/server/api/ServiceApi.ts`. SystemdClient on Linux had never actually consumed `account` (it derives behavior from `scope`), so the field was dead weight there too.
  - Updating `src/server/__tests__/ServyClient.test.ts` to assert the correct Servy 8.2 argv shape *and* explicitly assert that the v0.1.4-broken flag names (`--binPath`, `--account`, `--startType`, `--logPath`, `--user`) are NOT present in argv — regression guard against a future revert.

## [0.1.4] - 2026-04-27

**v0.1.0, v0.1.1, v0.1.2, AND v0.1.3 all shipped broken and have been withdrawn.** That's four broken releases in a row. If you installed any of them: apologies for the wasted time. v0.1.4 is the FIFTH attempt and the first one where every previously-deferred packaging-path bug has been closed instead of "noted for later."

The honest accounting of how we got here:

- **v0.1.0** — Setup.exe crashed on a clean Win11 install with `VCRUNTIME140.dll was not found`. The Rust launcher and tray binaries were dynamically linked against the Visual C++ Redistributable, which a clean Win11 doesn't ship. Fixed in v0.1.1 by statically linking the MSVC C runtime.
- **v0.1.1** — Setup.exe completed, but the launcher silent-failed at first run because no Node binary could be found at `<install>/current/seed/node/`. The SP3 spec called for shipping a bootstrap Node binary at that path, but the script that populates `seed/` was deferred during P6 packaging and never landed. Fixed in v0.1.2 with a `scripts/fetch-node.mjs` that downloads + SHA256-verifies Node v24.15.0 LTS during CI.
- **v0.1.2** — `seed/node/node.exe` shipped correctly, but the launcher STILL silent-failed because the supervisor was unconditionally setting `DEPS_PATH` on its own process env before calling `resolve_node`, making `resolve_node` enforce strict mode and refuse the seed fallback. Fixed in v0.1.3 by passing `DEPS_PATH` to the Node child env directly instead of the launcher's own env.
- **v0.1.3** — Setup.exe finally installed and the app launched, but the network scan (full + quick) and device discovery hung indefinitely on every click — chip never moved, cancel did nothing, only a page refresh reset the UI. Root cause: the server invoked bare `'adb'` (PATH lookup), and on a clean machine that hit ENOENT, while on a machine with a system adb already installed it triggered a version-mismatch hang. The chip-freeze symptom was made worse by `NetworkScanner.start()` having no `catch` block — any exception got silently swallowed by `ScanMw`'s `.catch(() => {})` and the WebSocket waited forever for a message that never came. **This bug was foreseeable.** A 2026-04-15 cross-platform audit had explicitly noticed that all `new AdbClient()` calls used the default `'adb'` PATH lookup AND that `Config.adbPath` itself didn't auto-resolve to the bundled binary — and filed both as "low priority — works when ADB is in the dependencies folder or on PATH." That self-granted deferral, made by the AI assistant doing the audit, was the actual cause of v0.1.3 shipping broken; the deferred items were the bug. v0.1.4 is the fix, plus a new architectural rule (in CLAUDE.md) that bans this category of deferral on installer-shipping projects.

### Fixed (v0.1.4)

- **Network scan + device discovery work again.** `Config.adbPath` now resolves *exclusively* to the local `<install>/dependencies/adb/adb[.exe]` path (or to a user-explicit `config.json` `adbPath` override). There is no system-PATH fallback. There is no `ADB_PATH` env-var resolution. If the bundled binary isn't there yet on first run, `DependencyManager.autoInstallMissing` fetches it; until it's present, adb-dependent operations throw `AdbExecError('spawn', ...)` and surface as a `scan.error` message in the UI rather than freezing the chip.
- **`AdbClient` constructor now requires an explicit `adbPath` argument** (compile-time guardrail). The previous `'adb'` default had silently masked the bug. All 6 production call sites (`DeviceProbe`, `AdbUtils`, `Device`, `FilePushReader`, `ControlCenter`, `ScrcpyConnection`) updated to pass `Config.getInstance().adbPath`.
- **Hard timeouts on adb control-plane calls.** `AdbClient.exec` now sets `timeout` + `killSignal: 'SIGKILL'` on `devices` (5s), `mdns services` (8s), `connect` (8s), `disconnect`/forward ops (5s). Long-running commands (`shell`, `push`, `pull`) remain unbounded by design.
- **Typed `AdbExecError`** carries `kind` (`timeout` | `spawn` | `exit` | `unknown`), the resolved `adbPath`, and the `args` so the failure message is debuggable from logs alone.
- **`NetworkScanner.start()` has a `catch` block** that emits `scan.error` with the exception message before `finally` resets state. Any future scanner-side failure surfaces visibly instead of hanging the UI.
- **`AdbClient.mdnsServices` no longer swallows errors** and returns `[]` — that behavior was the original sin masking the v0.1.3 hang. It now throws and lets the caller decide on degradation.

### Installation

- **Windows installer (`Setup.exe`)** — installs per-user under `%LocalAppData%`, no admin required. Best for most users. Velopack-managed auto-updates from the in-app **Settings** panel or the header **Update Available** button.
- **Linux AppImage** — single executable; `chmod +x` and run, on any glibc 2.31+ or musl-libc distro. Velopack-managed auto-updates.
- **Windows portable ZIP** — unzip and run; no install required, no auto-updates. Air-gapped friendly.
- Stable and beta release channels, switchable in Settings without reinstall.
- Manual install path still works: clone the repo, `npm install`, `npm start`.

### Service mode

- Optional Windows service (managed by [Servy](https://github.com/aelassas/servy)) so `ws-scrcpy-web` runs at login or boot. Pick from the first-run welcome modal or Settings → Service.
- Optional Linux systemd unit. User scope (no sudo) writes to `~/.config/systemd/user/`; system scope (requires sudo) writes to `/etc/systemd/system/`. Welcome modal asks per-platform; `loginctl enable-linger` keeps user-scope services alive after logout.
- A small system-tray icon on Windows shows a single confirm-and-exit dialog. (Linux skips the tray entirely; use the web UI Stop Server button.)

### Streaming features

- **Multi-codec video** (H.264, H.265, AV1) and **multi-codec audio** (Opus, AAC, FLAC, raw PCM), all decoded via WebCodecs in the browser. No WASM fallbacks.
- **Audio capture** is SDK-aware with three sources (output / playback / mic), per-device persisted preferences, and graceful gating for older Android. Playback mode keeps device audio audible during capture (Android 13+).
- **D-pad / Touch input modes** with a toolbar toggle for leanback TV apps. UHID keyboard and mouse with hardware-level input via USB HID. Scroll wheel and Shift+scroll forwarding tuned for high-latency streams.
- **Programmatic stream API**: load `ws-scrcpy.umd.js` or `ws-scrcpy.esm.js` and call `WsScrcpy.startStream(container, deviceId, options)` to embed a stream into any DOM element. Bundled TypeScript types. Thin `embed.html?device=<udid>` shim for iframe consumers.

### Device discovery

- **Network scan** combining mDNS (modern devices) with a TCP-port-5555 sweep (older devices that do not advertise). Auto-detects gateway subnet; accepts additional subnets as CIDR, bare IP, or IP range. mDNS and TCP hits dedupe automatically.
- **Quick Scan** button on the home page for fast mDNS-only discovery.
- **Device labels** persist across sessions, keyed by both serial and MAC, so devices keep their names whether they show up via mDNS or TCP.
- **Sleep / wake toggle** on each device card with server-polled state, kept in sync over WebSocket so buttons stay accurate when the device sleeps via timer or remote.

### UI

- **First-run welcome modal** that shows the chosen port (with auto-shift if 8000 is busy) and the service-install prompt.
- **Settings panel** (gear icon, top-right) for web port, auto-update preferences, channel selection, GitHub owner override, and service install/uninstall. Dev-mode banner when running from source.
- **Dark / light theme toggle** persisted in localStorage.
- File browser with breadcrumbs, sortable columns, drag-and-drop upload, download with progress, bulk delete.
- Remote ADB shell terminal with xterm.js.
- Browser tab title is now static ("Android Power Tools") on every page.

### Self-contained dependencies

- Bundled Node.js 24.15.0 LTS (ships in the installer payload, no first-run download needed). ADB platform-tools and `scrcpy-server` v3.3.4 download on first run with SHA256 verification.
- Native `node-pty` prebuilds for Windows (x64, arm64) and Linux glibc (x64, arm64), built weekly via GitHub Actions matrix. Falls back to source-compile on unsupported targets.
- **In-app dependency updater** in the Settings panel: check and update Node.js, ADB, and `scrcpy-server` from the home page with one click.

### Linux portability

- Launcher built for `x86_64-unknown-linux-musl` — zero glibc dependency on the launcher itself. The bundled Node 24 binary still requires glibc 2.31+, which is the actual minimum-glibc for the full app.
- AppImage runtime stub swapped post-`vpk pack` with the upstream static-fuse runtime from [AppImage/type2-runtime](https://github.com/AppImage/type2-runtime). The .AppImage no longer needs `libfuse2` or `libfuse3` installed on the host.

### Privacy and code signing

- `PRIVACY.md` documents outbound traffic (update checks, optional dep installs from `nodejs.org`, `dl.google.com`, `github.com`). No telemetry. No analytics. No project-operated server.
- ~~Code signing via [SignPath Foundation](https://signpath.org)'s free OSS program — application is in review. Once approved, the next release will be the first signed release. Until then, integrity is verifiable via the `SHA256SUMS` file shipped with each release.~~ *(Retracted 2026-05-07: SignPath Foundation declined the application — see [Unreleased].)*

## [0.1.3] - 2026-04-27 [YANKED]

**Withdrawn.** Setup.exe installed and the app launched, but the network scan (full + quick) and device discovery hung on every click — chip frozen at 0/N, cancel button non-functional, only a page refresh reset the UI. Root cause was bare `'adb'` PATH lookup combined with a missing `catch` block in the scanner's main try. See [0.1.4] above for the full root-cause writeup and fix. The GitHub Release page was deleted. Tag retained for archaeology.

## [0.1.2] - 2026-04-27 [YANKED]

**First actually-installable release.** v0.1.0 (initial tag) and v0.1.1 (VCRUNTIME fix + branded icons) both shipped with broken installers — v0.1.0 crashed on a clean Win11 install with `VCRUNTIME140.dll was not found`, and v0.1.1 fixed that crash but exposed a separate gap where the post-install app launch silent-failed because the bundled Node bootstrap binary was missing from the installer payload. Both have been withdrawn from the Releases page; this is the first version that actually installs and runs end-to-end on a clean machine. See § Install-blocker fixes below for the full chain.

### Install-blocker fixes (the v0.1.0 → v0.1.2 journey)

- **v0.1.1 fix → still in v0.1.2:** the Rust launcher and tray binaries now statically link the MSVC C runtime (`-C target-feature=+crt-static`), so they have no runtime DLL dependency on the Visual C++ Redistributable. v0.1.0 crashed with `VCRUNTIME140.dll was not found` on any Windows install missing VCRedist (true of fresh Win11). Verified with `dumpbin /dependents`: only Windows-native DLLs remain.
- **v0.1.2 fix:** `Setup.exe` now actually launches the installed app. v0.1.1 fixed the VCRUNTIME crash but the launcher then silent-failed at first run because no Node binary could be found at `<install>/current/seed/node/`. Process lifetime was under 200 ms — invisible in Task Manager. The SP3 spec called for shipping a bootstrap Node binary at that path, but the script that populates `seed/` was deferred during P6 packaging and never landed. New `scripts/fetch-node.mjs` downloads + SHA256-verifies Node v24.15.0 LTS from `nodejs.org/dist/`, stages the binary into `seed/node/`, and is invoked from `release.yml` before `stage-publish.mjs` on both Windows and Linux jobs.
- **v0.1.1 fix → still in v0.1.2:** branded app icon now appears in Explorer, taskbar, Start Menu, Add/Remove Programs, and the Setup.exe installer itself. Setup.exe gets it via `vpk pack --icon`; launcher and tray binaries embed it via `winresource`-driven `build.rs` files.
- **v0.1.1 change → still in v0.1.2:** the broken Velopack `--msiDeploymentTool` MSI artifact was withdrawn from the release pipeline. It was an SCCM/Intune deployment-tool harness, not a user-clickable installer. Setup.exe (per-user, wizardful) and Portable.zip remain the supported Windows install paths. A real user-facing WiX MSI is logged as a future enhancement.
- **v0.1.2 change:** Linux AppImage is now truly portable — `chmod +x` and run on any Linux from the last 18 years. Two changes land together: (i) the Rust launcher is built for `x86_64-unknown-linux-musl`, so the binary itself has zero glibc dependency (`ldd` on the shipped ELF reports `not a dynamic executable`); (ii) the AppImage runtime stub is swapped post-`vpk pack` with the upstream static-fuse runtime from [AppImage/type2-runtime](https://github.com/AppImage/type2-runtime), so the .AppImage no longer needs `libfuse2` (or `libfuse3`) installed on the host. Net minimum-glibc is still 2.31+ (set by the bundled Node 24), but the launcher itself runs on anything including musl-libc distros like Alpine.

### Installation

- **Windows installer (`Setup.exe`)** — installs per-user under `%LocalAppData%`, no admin required. Best for most users. Velopack-managed auto-updates from the in-app **Settings** panel or the header **Update Available** button.
- **Linux AppImage** — single executable; `chmod +x` and run, on any glibc 2.31+ or musl-libc distro. Velopack-managed auto-updates.
- **Windows portable ZIP** — unzip and run; no install required, no auto-updates. Air-gapped friendly.
- Stable and beta release channels, switchable in Settings without reinstall.
- Manual install path still works: clone the repo, `npm install`, `npm start`.

### Service mode

- Optional Windows service (managed by [Servy](https://github.com/aelassas/servy)) so `ws-scrcpy-web` runs at login or boot. Pick from the first-run welcome modal or Settings → Service.
- Optional Linux systemd unit. User scope (no sudo) writes to `~/.config/systemd/user/`; system scope (requires sudo) writes to `/etc/systemd/system/`. Welcome modal asks per-platform; `loginctl enable-linger` keeps user-scope services alive after logout.
- A small system-tray icon on Windows shows a single confirm-and-exit dialog. (Linux skips the tray entirely; use the web UI Stop Server button.)

### Streaming features

- **Multi-codec video** (H.264, H.265, AV1) and **multi-codec audio** (Opus, AAC, FLAC, raw PCM), all decoded via WebCodecs in the browser. No WASM fallbacks.
- **Audio capture** is SDK-aware with three sources (output / playback / mic), per-device persisted preferences, and graceful gating for older Android. Playback mode keeps device audio audible during capture (Android 13+).
- **D-pad / Touch input modes** with a toolbar toggle for leanback TV apps. UHID keyboard and mouse with hardware-level input via USB HID. Scroll wheel and Shift+scroll forwarding tuned for high-latency streams.
- **Programmatic stream API**: load `ws-scrcpy.umd.js` or `ws-scrcpy.esm.js` and call `WsScrcpy.startStream(container, deviceId, options)` to embed a stream into any DOM element. Bundled TypeScript types. Thin `embed.html?device=<udid>` shim for iframe consumers.

### Device discovery

- **Network scan** combining mDNS (modern devices) with a TCP-port-5555 sweep (older devices that do not advertise). Auto-detects gateway subnet; accepts additional subnets as CIDR, bare IP, or IP range. mDNS and TCP hits dedupe automatically.
- **Quick Scan** button on the home page for fast mDNS-only discovery.
- **Device labels** persist across sessions, keyed by both serial and MAC, so devices keep their names whether they show up via mDNS or TCP.
- **Sleep / wake toggle** on each device card with server-polled state, kept in sync over WebSocket so buttons stay accurate when the device sleeps via timer or remote.

### UI

- **First-run welcome modal** that shows the chosen port (with auto-shift if 8000 is busy) and the service-install prompt.
- **Settings panel** (gear icon, top-right) for web port, auto-update preferences, channel selection, GitHub owner override, and service install/uninstall. Dev-mode banner when running from source.
- **Dark / light theme toggle** persisted in localStorage.
- File browser with breadcrumbs, sortable columns, drag-and-drop upload, download with progress, bulk delete.
- Remote ADB shell terminal with xterm.js.
- Browser tab title is now static ("Android Power Tools") on every page.

### Self-contained dependencies

- Bundled Node.js 24.15.0 LTS, ADB platform-tools, and `scrcpy-server` v3.3.4. The app downloads ADB and `scrcpy-server` on first run if missing, with SHA256 verification. Node ships in the installer payload itself (the v0.1.2 fix above) so first-run works offline.
- Native `node-pty` prebuilds for Windows (x64, arm64) and Linux glibc (x64, arm64), built weekly via GitHub Actions matrix. Falls back to source-compile on unsupported targets.
- **In-app dependency updater** in the Settings panel: check and update Node.js, ADB, and `scrcpy-server` from the home page with one click.

### Privacy and code signing

- `PRIVACY.md` documents outbound traffic (update checks, optional dep installs from `nodejs.org`, `dl.google.com`, `github.com`). No telemetry. No analytics. No project-operated server.
- ~~Code signing via [SignPath Foundation](https://signpath.org)'s free OSS program — application is in review. Once approved, the next release will be the first signed release. Until then, integrity is verifiable via the `SHA256SUMS` file shipped with each release.~~ *(Retracted 2026-05-07: SignPath Foundation declined the application — see [Unreleased].)*

## [0.1.1] - 2026-04-27 [YANKED]

### Fixed

- **Setup.exe now installs successfully on clean Windows boxes.** v0.1.0 failed with `VCRUNTIME140.dll was not found` → `application install hook failed` on any machine missing the Visual C++ Redistributable (true of a fresh Win11 install). The Rust launcher and tray binaries now statically link the MSVC C runtime (`-C target-feature=+crt-static`), so they have no runtime DLL dependency on VCRedist. Verified with `dumpbin /dependents`: only Windows-native DLLs remain. *(Setup.exe install completes; app launch is still broken in v0.1.1 — see v0.1.2.)*
- Internal: `libcDetect.test.ts` mock typing widened from `string` to `fs.PathLike`, and `detectInstallScope` now uses `path.win32.dirname` for execPath splitting on POSIX CI hosts. CI-only fixes; no runtime behavior change.

### Changed

- **Branded app icon** now appears in Explorer, taskbar, Start Menu, Add/Remove Programs, and the Setup.exe installer itself. Previously all three displayed the default Rust toolchain / Velopack generic icon. Setup.exe gets it via `vpk pack --icon`; the launcher and tray binaries embed it via new `build.rs` files using the `winresource` crate.

### Removed

- **Windows MSI artifact withdrawn.** The MSI we shipped in v0.1.0 was Velopack's `--msiDeploymentTool` output — designed for SCCM / Intune mass deployment, not user-clickable (it silently registered as a "Deployment Tool" in Add/Remove Programs without installing the actual app). Setup.exe (per-user, wizardful) and Portable.zip remain the supported Windows install paths. A real user-facing WiX MSI is logged as a future enhancement.

## [0.1.0] - 2026-04-27 [YANKED]

First public release.

### Installation

- **Windows installer (`Setup.exe`)** — installs per-user under `%LocalAppData%`, no admin required. Best for most users. Velopack-managed auto-updates from the in-app **Settings** panel or the header **Update Available** button.
- **Windows MSI** — installs system-wide under `Program Files` (requires admin). For corporate / SCCM / Group Policy deployment scenarios. Same auto-update behavior as Setup.exe.
- **Linux AppImage** — single executable; `chmod +x` and run. Velopack-managed auto-updates.
- **Windows portable ZIP** — unzip and run; no install required, no auto-updates. Air-gapped friendly.
- Stable and beta release channels, switchable in Settings without reinstall.
- Manual install path still works: clone the repo, `npm install`, `npm start`.

### Service mode

- Optional Windows service (managed by [Servy](https://github.com/aelassas/servy)) so `ws-scrcpy-web` runs at login or boot. Pick from the first-run welcome modal or Settings → Service.
- Optional Linux systemd unit. User scope (no sudo) writes to `~/.config/systemd/user/`; system scope (requires sudo) writes to `/etc/systemd/system/`. Welcome modal asks per-platform; `loginctl enable-linger` keeps user-scope services alive after logout.
- A small system-tray icon on Windows shows a single confirm-and-exit dialog. (Linux skips the tray entirely; use the web UI Stop Server button.)

### Streaming features

- **Multi-codec video** (H.264, H.265, AV1) and **multi-codec audio** (Opus, AAC, FLAC, raw PCM), all decoded via WebCodecs in the browser. No WASM fallbacks.
- **Audio capture** is SDK-aware with three sources (output / playback / mic), per-device persisted preferences, and graceful gating for older Android. Playback mode keeps device audio audible during capture (Android 13+).
- **D-pad / Touch input modes** with a toolbar toggle for leanback TV apps. UHID keyboard and mouse with hardware-level input via USB HID. Scroll wheel and Shift+scroll forwarding tuned for high-latency streams.
- **Programmatic stream API**: load `ws-scrcpy.umd.js` or `ws-scrcpy.esm.js` and call `WsScrcpy.startStream(container, deviceId, options)` to embed a stream into any DOM element. Bundled TypeScript types. Thin `embed.html?device=<udid>` shim for iframe consumers.

### Device discovery

- **Network scan** combining mDNS (modern devices) with a TCP-port-5555 sweep (older devices that do not advertise). Auto-detects gateway subnet; accepts additional subnets as CIDR, bare IP, or IP range. mDNS and TCP hits dedupe automatically.
- **Quick Scan** button on the home page for fast mDNS-only discovery.
- **Device labels** persist across sessions, keyed by both serial and MAC, so devices keep their names whether they show up via mDNS or TCP.
- **Sleep / wake toggle** on each device card with server-polled state, kept in sync over WebSocket so buttons stay accurate when the device sleeps via timer or remote.

### UI

- New **first-run welcome modal** that shows the chosen port (with auto-shift if 8000 is busy) and the service-install prompt.
- **Settings panel** (gear icon, top-right) for web port, auto-update preferences, channel selection, GitHub owner override, and service install/uninstall. Dev-mode banner when running from source.
- **Dark / light theme toggle** persisted in localStorage.
- File browser with breadcrumbs, sortable columns, drag-and-drop upload, download with progress, bulk delete.
- Remote ADB shell terminal with xterm.js.
- Browser tab title is now static ("Android Power Tools") on every page.

### Self-contained dependencies

- Bundled Node.js, ADB platform-tools, and `scrcpy-server` v3.3.4. The app downloads these on first run if missing, with SHA256 verification.
- Native `node-pty` prebuilds for Windows (x64, arm64) and Linux glibc (x64, arm64), built weekly via GitHub Actions matrix. Falls back to source-compile on unsupported targets.
- **In-app dependency updater** in the Settings panel: check and update Node.js, ADB, and `scrcpy-server` from the home page with one click.

### Privacy and code signing

- New `PRIVACY.md` documenting outbound traffic (update checks, optional dep installs from nodejs.org / dl.google.com / github.com). No telemetry. No analytics. No project-operated server.
- ~~Code signing via [SignPath Foundation](https://signpath.org)'s free OSS program — application is in review at v0.1.0 release. Once approved, **v0.1.1** will be the first signed release. Until then, integrity is verifiable via the `SHA256SUMS` file shipped with the release.~~ *(Retracted 2026-05-07: SignPath Foundation declined the application — see [Unreleased].)*

### Notes

- See `docs/RELEASING.md` for the release runbook.
- `docs/TECHNICAL_GUIDE.md` covers architecture and module-level details.

## [1.0.0] - 2026-04-17

First public release. Browser-based Android screen mirroring rebuilt from the ground up on vanilla scrcpy v3.x with a modernized Node.js + TypeScript stack.

### Added

**Stream API + embed mode** (this release's headline)
- Public `WsScrcpy.startStream(container, deviceId, options)` library shipped as UMD (`ws-scrcpy.umd.js`) and ES module (`ws-scrcpy.esm.js`) with bundled TypeScript types (`ws-scrcpy.d.ts`)
- `/embed.html?device=<udid>` thin wrapper for iframe consumers; transparent background, auto-connect, full toolbar
- `StreamHandle` with idempotent `stop()`, `isConnected`, `deviceId`
- `onConnect` / `onDisconnect` / `onError` lifecycle callbacks with typed payloads
- Full URL parameter surface (`host`, `port`, `secure`, `pathname`, `codec`, `encoder`, `bitrate`, `maxFps`, `maxSize`, `audio`, `keyboard`)

**Modal system**
- Native HTML `<dialog>` base class (`Modal`) with glassmorphism styling, `@starting-style` transitions, and `addHeaderButton()` helper
- `ConfigureScrcpy`, `ShellModal`, `ConnectModal`, `ListFilesModal` all extend the base class
- Device labels displayed in modal headers

**File browser** (`ListFilesModal`)
- Sticky header, reserved actions column, SVG hover icons that scale with size picker, sortable columns, breadcrumb navigation, bulk selection, drag-and-drop upload, download with progress, client-side filter

**Input**
- UHID keyboard + mouse via USB HID report descriptors (pointer lock)
- D-pad / Touch input mode toggle (D-pad default for TV apps, fire-then-debounce for scroll wheel)
- Scroll wheel with i16fp encoding (`sc_float_to_i16fp`) and latent-stream-tuned normalization
- Clipboard toolbar buttons (GET device→host, SET host→device) — modernized from legacy MoreBox textarea flow

**Codecs**
- Multi-codec video: H.264, H.265 (HEVC), AV1 with smart auto-selection (H.265 preferred, falls back to H.264 for Firefox)
- Multi-codec audio: Opus, AAC, FLAC, raw PCM via WebCodecs `AudioDecoder` + `AudioWorklet`
- HEVC SPS parser with RBSP stripping, AV1 config record parser
- Edge H.265 rendering fix: 8-arg `drawImage` using full coded rect as source (Edge reports display dims ≠ coded dims)

**Device management**
- Connected-devices card grid with live WebSocket updates
- Network scan via `adb mdns services` with one-click connect
- Device labels persisted to `device-labels.json`, keyed by `ro.serialno`
- Per-card sleep/wake toggle with server-side polling (`dumpsys power`, 5s loop, `Promise.all` concurrency)
- Disconnect button for network-connected devices

**Deployment**
- Self-contained folder layout: `dependencies/node/`, `dependencies/adb/`, `start.cmd` / `start.sh` launcher scripts
- In-app updater for Node.js + node-pty (paired), ADB platform-tools, scrcpy-server
- Windows file-locking workaround: rename running `node.exe`, write `.restart` marker, launcher relaunches
- Dark/light theme toggle with localStorage persistence

**Server**
- Tagged logger (`Logger.for('Tag')`) replaces all raw `console.log`; tees to `ws-scrcpy-web.log` with ISO timestamps, 5MB rotation
- `uncaughtException` + `unhandledRejection` handlers log to file before exit
- Crash-safe WebSocket close (readyState guard, 123-byte reason truncation)
- Vanilla scrcpy-server v3.3.4 binary; no Java patching

**API endpoints**
- `GET /api/dependencies/*` — updater status and operations
- `GET /api/devices/labels` / `PUT /api/devices/labels`
- `POST /api/devices/scan` — mDNS discovery
- `POST /api/devices/connect` / `POST /api/devices/disconnect`
- `POST /api/devices/files/*` — file browser operations including delete

**Quality stats overlay**
- Top-left HUD shows resolution, video codec, encoder name, bitrate, FPS counters; font scales with canvas resolution
- Toolbar bar-chart button toggles stats visibility
- Server echoes encoder in session metadata

**Tests**
- Vitest suite for control messages, binary readers/writers, multiplexer, codec configs, device labels
- 87 tests passing across the final release

### Changed

- Dependencies overhaul: Node 24 LTS, TypeScript 6, Biome 2, webpack 5, node-pty 1.1.0, xterm 6.x
- Runtime dependencies reduced to 2 total: `ws`, `node-pty`
- Control message protocol: `ScrollControlMessage` now 20-byte int16 (not 25-byte int32); `TouchControlMessage` payload corrected to 31 bytes
- Default keyboard: ON at stream start
- Default FPS: 15 (tuned for latent network streams)
- Default encoder: auto-selects hardware HEVC (`c2.mtk.hevc.encoder`, Qualcomm or Exynos equivalents)
- Home page centered at max-width 1800px (5 cards on 4K)
- Toolbar icons centered via SVG sizing; vertical spacing increased

### Removed

- iOS support, Chrome DevTools proxy, WASM decoder fallbacks, vendor decoder shims (~6,500 lines deleted)
- `adbkit`, Express, YAML, ESLint, path-browserify (replaced by own implementations)
- `GoogMoreBox` (383 lines) — clipboard flow replaced by toolbar buttons
- `#!action=stream` URL hash routing
- `?embed=true` URL parameter and all `body.embed` CSS rules
- Patched `scrcpy-server.jar` — project now uses unmodified Genymobile binaries

### Fixed

- Edge WebCodecs H.265 displayWidth/codedWidth mismatch causing blurry or clipped frames
- Firefox `VideoDecoder.isConfigSupported` falsely rejecting `avc1.42E01E` — H.264 now skips the check
- Mouse click freeze after stream-quality refresh (race: old demuxer's async `onclose` fired after `isRefreshing` reset)
- Stale device cards persisting across disconnects (ControlCenter + client-side `updateDescriptor` both now remove disconnected devices)
- Scan Network missed plain `_adb._tcp` services (filter was restricted to `_adb-tls-connect`)
- `RemoteShell` crash from `ws.send()` on closed socket (readyState guard)
- `AdbUtils.ts` and `RemoteShell.ts` cross-platform fixes (hardcoded `'adb'` → `Config.adbPath`, `env.PWD` → `process.cwd()`)

### Security

- WebSocket close reason truncated to 123-byte spec limit with try/catch — offline devices no longer crash the Node process
