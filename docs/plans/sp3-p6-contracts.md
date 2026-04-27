# SP3 P6 — Packaging + CI: Lead Contracts

**Branch:** `sp3-p6-packaging-ci` (off `main` at `b55b392`)
**Authored:** 2026-04-27
**Reads with:** `docs/specs/2026-04-26-sp3-velopack-installer.md` § Packaging & CI + § Code signing (just updated to SignPath) + § GitHub Actions workflow + § Release runbook, `docs/plans/2026-04-26-sp3-velopack-installer.md` § P6.

## Architectural decisions (locked by user 2026-04-27)

1. **Signing scope: sign all artifacts.** Inner Windows exes (`launcher`, `tray`) signed pre-pack, MSI signed post-pack, Linux AppImage detached-GPG signed post-pack. ~4 SignPath rounds per release.
2. **Linux AppImage signing: SignPath detached GPG** (not skipped, not maintainer-GPG). Produces `<appimage>.sig` alongside the AppImage. Same SignPath account, separate signing policy.
3. **Pre-SignPath workflow: unsigned v0.1.0 with prominent notice.** SignPath OSS approval is pending — they want a live download URL to test against. v0.1.0 ships unsigned + SHA256SUMS for integrity, with a "⚠️ Unsigned: SignPath approval pending" notice auto-prepended to release notes. **v0.1.1 = first signed release**, cut when secret is added.
4. **Linux AppImage in release.yml: parallel Ubuntu job.** Same GH Release as Windows MSI.
5. **SignPath credit: README Downloads + auto-prepended release notes + RELEASING.md note.**

Plus **privacy policy as P6 deliverable** — `PRIVACY.md` covering app outbound traffic to nodejs.org, dl.google.com, github.com (Genymobile/scrcpy + our own repo's prebuilts + Velopack update feed).

## SignPath integration shape

Confirmed via https://docs.signpath.io/build-system-integration/github + https://docs.signpath.io/crypto-providers/gpg (read 2026-04-27).

**Canonical Action:** `signpath/github-action-submit-signing-request@v2` with `wait-for-completion: true`. Single secret `SIGNPATH_API_TOKEN`. Three non-secret identifiers (organization-id, project-slug, signing-policy-slug) — kept as workflow-level vars (NOT secrets).

**Signing flow per release** (Windows job):
1. Build launcher.exe + tray.exe via `cargo build --release`
2. Upload as artifact `unsigned-windows-exes`
3. Submit to SignPath Windows policy → wait → download to `publish/`
4. Run `vpk pack` on signed exes → produces unsigned MSI in `Releases/`
5. Upload unsigned MSI as artifact `unsigned-windows-msi`
6. Submit to SignPath Windows policy → wait → download to `Releases/signed/`
7. Generate SHA256SUMS for the signed MSI + portable zip + nupkg
8. Upload to GH Release

Signing flow per release (Linux job, parallel):
1. Build launcher binary via `cargo build --release --target x86_64-unknown-linux-gnu` (CI runs Ubuntu, no cross needed)
2. Run `scripts/package-linux.mjs` → produces unsigned `.AppImage` in `Releases/`
3. Upload as artifact `unsigned-linux-appimage`
4. Submit to SignPath Linux policy → wait → download `<appimage>.sig` to `Releases/`
5. Add to SHA256SUMS
6. Upload to GH Release

**Conditional signing (decision 3):**

```yaml
- name: Determine signing mode
  id: signing
  run: |
    if [ -n "${{ secrets.SIGNPATH_API_TOKEN }}" ]; then
      echo "mode=signed" >> "$GITHUB_OUTPUT"
    else
      echo "mode=unsigned" >> "$GITHUB_OUTPUT"
    fi
```

All signing steps gated on `if: steps.signing.outputs.mode == 'signed'`. The unsigned path skips them and proceeds straight to SHA256SUMS + release notes auto-prepend + GH Release publish.

Release notes auto-prepend (in `scripts/extract-changelog.mjs`):
- **Always:** `_Signed via [SignPath Foundation](https://signpath.org)._` (the SignPath OSS program credit — required even on unsigned releases since the credit is about *intent to sign with SignPath when approved*, not "this specific release is signed")
- **When unsigned mode:** additionally prepends:
  ```
  > ⚠️ **This release is unsigned.** [SignPath Foundation](https://signpath.org) is reviewing our application for free OSS code-signing. Once approved, we'll cut a signed v0.1.1. Until then, you may see Windows SmartScreen warnings — verify integrity via the `SHA256SUMS` file in this release.
  ```
- **When signed mode:** the warning notice is omitted; the SignPath credit remains.

`scripts/extract-changelog.mjs` takes optional `--unsigned` flag passed by the workflow when in unsigned mode.

## Files to deliver

| File | Action | Owner |
|---|---|---|
| `.github/workflows/release.yml` | NEW | Workflow agent |
| `.github/workflows/ci.yml` | MODIFY | Workflow agent |
| `scripts/extract-changelog.mjs` | NEW | Scripts agent |
| `scripts/__tests__/extract-changelog.test.mjs` | NEW | Scripts agent |
| `scripts/test-update-flow.ps1` | NEW | Scripts agent |
| `docs/RELEASING.md` | NEW | Scripts agent |
| `RELEASE_NOTES.md` | NEW (template) | Scripts agent |
| `PRIVACY.md` | NEW | Scripts agent |
| `README.md` | MODIFY (add Downloads section + privacy link + SignPath credit) | Scripts agent |
| `package.json` | MODIFY (add `package:pack`, `test:update-flow`, `release-notes` scripts) | Scripts agent |

**Decision: 2 agents.** Workflow agent owns the YAML files. Scripts agent owns everything else (Node script + PowerShell + Markdown). Clean ownership matrix; minimal overlap.

## ci.yml extension

Current `ci.yml` is minimal (Node 18, biome, webpack on Ubuntu). Extend to:
- **Bump Node to 24** (matches our runtime)
- **Add Rust toolchain** + `cargo test --workspace` + `cargo clippy --workspace --all-targets -- -D warnings`
- **Add tsc + vitest** (replaces / supplements biome)
- **Add `node scripts/assert-version-sync.mjs`** when on a tag ref (skip on branch/PR)
- Keep `npm run build` smoke

Single Ubuntu job with all the steps. `cross check` for Linux target is NOT needed in CI because the Ubuntu runner builds natively for Linux.

```yaml
# .github/workflows/ci.yml (rewritten)
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24.x
          cache: npm
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm test            # vitest 501+ tests
      - run: cargo test --workspace
      - run: cargo clippy --workspace --all-targets -- -D warnings
      - run: npm run build       # webpack
      - name: Version sync (on tags only)
        if: startsWith(github.ref, 'refs/tags/v')
        run: node scripts/assert-version-sync.mjs ${{ github.ref_name }}
```

## release.yml shape

Two jobs: `build-windows` (windows-latest runner) and `build-linux` (ubuntu-latest runner). Both parallel after a shared `prepare` job that asserts version sync. After both complete, a `publish` job assembles all artifacts + uploads to GH Release.

```yaml
name: Release

on:
  push:
    tags: ['v*']

jobs:
  prepare:
    runs-on: ubuntu-latest
    outputs:
      channel: ${{ steps.channel.outputs.channel }}
      signing_mode: ${{ steps.signing.outputs.mode }}
      version: ${{ steps.version.outputs.version }}
    steps:
      - uses: actions/checkout@v4
      - id: version
        run: echo "version=${GITHUB_REF_NAME#v}" >> "$GITHUB_OUTPUT"
      - id: channel
        run: |
          if [[ "${GITHUB_REF_NAME}" == *-beta* ]]; then
            echo "channel=beta" >> "$GITHUB_OUTPUT"
          else
            echo "channel=stable" >> "$GITHUB_OUTPUT"
          fi
      - id: signing
        run: |
          if [ -n "${{ secrets.SIGNPATH_API_TOKEN }}" ]; then
            echo "mode=signed" >> "$GITHUB_OUTPUT"
          else
            echo "mode=unsigned" >> "$GITHUB_OUTPUT"
          fi
      - uses: actions/setup-node@v4
        with: { node-version: 24.x }
      - run: node scripts/assert-version-sync.mjs ${{ github.ref_name }}

  build-windows:
    needs: prepare
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24.x, cache: npm }
      - uses: actions/setup-dotnet@v4
        with: { dotnet-version: 9.x }
      - uses: dtolnay/rust-toolchain@stable
      - run: dotnet tool install -g vpk
      - run: npm ci --omit=dev
      - run: npm run build
      - run: cargo build --release --workspace
      - run: node scripts/fetch-servy.mjs
      - run: node scripts/stage-publish.mjs

      # ---- Sign inner exes (only in signed mode) ----
      - if: needs.prepare.outputs.signing_mode == 'signed'
        uses: actions/upload-artifact@v4
        id: upload-unsigned-exes
        with:
          name: unsigned-windows-exes
          path: |
            publish/ws-scrcpy-web-launcher.exe
            publish/ws-scrcpy-web-tray.exe
      - if: needs.prepare.outputs.signing_mode == 'signed'
        uses: signpath/github-action-submit-signing-request@v2
        with:
          api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
          organization-id: ${{ vars.SIGNPATH_ORGANIZATION_ID }}
          project-slug: ${{ vars.SIGNPATH_PROJECT_SLUG }}
          signing-policy-slug: ${{ vars.SIGNPATH_WINDOWS_POLICY_SLUG }}
          github-artifact-id: ${{ steps.upload-unsigned-exes.outputs.artifact-id }}
          wait-for-completion: true
          output-artifact-directory: publish/

      # ---- Pack MSI ----
      - run: |
          vpk pack `
            --packId WsScrcpyWeb `
            --packVersion ${{ needs.prepare.outputs.version }} `
            --packDir publish `
            --mainExe ws-scrcpy-web-launcher.exe `
            --packTitle "ws-scrcpy-web" `
            --packAuthors "ws-scrcpy-web contributors" `
            --msi `
            --instLocation Either `
            --channel ${{ needs.prepare.outputs.channel }} `
            -o Releases

      # ---- Sign MSI (only in signed mode) ----
      - if: needs.prepare.outputs.signing_mode == 'signed'
        uses: actions/upload-artifact@v4
        id: upload-unsigned-msi
        with:
          name: unsigned-windows-msi
          path: Releases/*.msi
      - if: needs.prepare.outputs.signing_mode == 'signed'
        uses: signpath/github-action-submit-signing-request@v2
        with:
          api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
          organization-id: ${{ vars.SIGNPATH_ORGANIZATION_ID }}
          project-slug: ${{ vars.SIGNPATH_PROJECT_SLUG }}
          signing-policy-slug: ${{ vars.SIGNPATH_WINDOWS_POLICY_SLUG }}
          github-artifact-id: ${{ steps.upload-unsigned-msi.outputs.artifact-id }}
          wait-for-completion: true
          output-artifact-directory: Releases/

      - run: Remove-Item Releases/*-Setup.exe -Force -ErrorAction SilentlyContinue

      - uses: actions/upload-artifact@v4
        with:
          name: windows-final
          path: |
            Releases/*.msi
            Releases/*-Portable.zip
            Releases/*.nupkg
            Releases/RELEASES
            Releases/releases.${{ needs.prepare.outputs.channel }}.json

  build-linux:
    needs: prepare
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24.x, cache: npm }
      - uses: actions/setup-dotnet@v4
        with: { dotnet-version: 9.x }
      - uses: dtolnay/rust-toolchain@stable
      - run: dotnet tool install -g vpk
      - run: npm ci --omit=dev
      - run: npm run build
      - run: cargo build --release --workspace
      - run: node scripts/stage-publish.mjs    # may need a Linux branch; check P5 implementation
      - run: node scripts/package-linux.mjs    # produces AppImage in Releases/

      # ---- Sign AppImage (only in signed mode) ----
      - if: needs.prepare.outputs.signing_mode == 'signed'
        uses: actions/upload-artifact@v4
        id: upload-unsigned-appimage
        with:
          name: unsigned-linux-appimage
          path: Releases/*.AppImage
      - if: needs.prepare.outputs.signing_mode == 'signed'
        uses: signpath/github-action-submit-signing-request@v2
        with:
          api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
          organization-id: ${{ vars.SIGNPATH_ORGANIZATION_ID }}
          project-slug: ${{ vars.SIGNPATH_PROJECT_SLUG }}
          signing-policy-slug: ${{ vars.SIGNPATH_LINUX_POLICY_SLUG }}
          github-artifact-id: ${{ steps.upload-unsigned-appimage.outputs.artifact-id }}
          wait-for-completion: true
          output-artifact-directory: Releases/    # produces .AppImage.sig alongside

      - uses: actions/upload-artifact@v4
        with:
          name: linux-final
          path: |
            Releases/*.AppImage
            Releases/*.AppImage.sig

  publish:
    needs: [prepare, build-windows, build-linux]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24.x }
      - uses: actions/download-artifact@v4
        with:
          path: artifacts/

      - name: Generate SHA256SUMS
        run: |
          cd artifacts
          find . -type f \( -name '*.msi' -o -name '*.AppImage' -o -name '*.AppImage.sig' -o -name '*-Portable.zip' -o -name '*.nupkg' \) -exec sha256sum {} \; > ../SHA256SUMS
          cd ..
          cat SHA256SUMS

      - name: Generate release notes
        run: |
          UNSIGNED_FLAG=""
          if [ "${{ needs.prepare.outputs.signing_mode }}" = "unsigned" ]; then
            UNSIGNED_FLAG="--unsigned"
          fi
          node scripts/extract-changelog.mjs ${{ github.ref_name }} $UNSIGNED_FLAG > release-notes.md

      - uses: softprops/action-gh-release@v2
        with:
          prerelease: ${{ needs.prepare.outputs.channel == 'beta' }}
          body_path: release-notes.md
          files: |
            artifacts/windows-final/*.msi
            artifacts/windows-final/*-Portable.zip
            artifacts/windows-final/*.nupkg
            artifacts/windows-final/RELEASES
            artifacts/windows-final/releases.${{ needs.prepare.outputs.channel }}.json
            artifacts/linux-final/*.AppImage
            artifacts/linux-final/*.AppImage.sig
            SHA256SUMS
```

**Note on `package-linux.mjs`:** P4b created it but presumed local invocation. May need a small adjustment for CI context (e.g., absolute paths, no PowerShell). Workflow agent verifies by inspection.

## scripts/extract-changelog.mjs

Argv: `<version> [--out <path>] [--unsigned]`. Default output is stdout.

Behavior:
- Parses `CHANGELOG.md`. Looks for `## [<version>]` header (e.g., `## [0.1.0]` or `## [Unreleased]` if version is "Unreleased").
- Strips the leading `v` from the version arg if present (`v0.1.0` → `0.1.0`).
- Captures content from after that header through the next `## [` header or EOF.
- **Always prepends:** `_Signed via [SignPath Foundation](https://signpath.org)._\n\n`
- **If `--unsigned` flag:** additionally prepends the warning block (text in contracts above), placed after the SignPath credit but before the changelog content.
- Throws if version section not found (CI fails the release).

Tests (`scripts/__tests__/extract-changelog.test.mjs`):
- Extracts a known section
- Strips leading `v`
- Throws on missing version
- Stops at next version header
- `--unsigned` flag prepends warning
- Both prepend lines present even without `--unsigned`

## scripts/test-update-flow.ps1

PowerShell script for local v1→v2 update flow validation per spec § Testing & validation. Runs on Windows only (skip cleanly on Linux). Steps:

1. Build current branch as `v0.1.0` to a sandbox dir
2. Bump version to `v0.1.1`, build, place output in a local feed dir
3. Set `$env:VELOPACK_FEED_URL = "file:///<feed>"`
4. Launch sandboxed app; user manually clicks "Check now" in browser; verifies update applies
5. Final assertion: `<install-root>/sq.version` reads `0.1.1`

Marked manual (interactive) — not a CI gate. RELEASING.md references it.

## docs/RELEASING.md

Three sections:
1. **Cutting a stable release** (step-by-step: bump version, update CHANGELOG, commit, tag `vX.Y.Z`, push tag, watch CI)
2. **Cutting a beta release** (same but tag `vX.Y.Z-beta.N`)
3. **Rollback procedure** (mark release as Pre-release via `gh release edit`, cut a fix-forward release immediately — never delete)

Plus:
4. **SignPath credit reminder** — never remove the auto-prepended credit; SignPath OSS program requirement
5. **First-time SignPath setup checklist** — once approval comes in: add `SIGNPATH_API_TOKEN` secret; add `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_WINDOWS_POLICY_SLUG`, `SIGNPATH_LINUX_POLICY_SLUG` repository variables; cut v0.1.1
6. **Manual update flow test** — link + invocation for `scripts/test-update-flow.ps1`

## RELEASE_NOTES.md (template)

A skeleton file at the repo root that contributors can populate per release. Mostly a pointer:

```markdown
# Release Notes

Release notes are generated automatically from `CHANGELOG.md` via `scripts/extract-changelog.mjs` when the workflow runs.

To preview the notes for the next release:

    node scripts/extract-changelog.mjs v0.1.0

This file exists as a discoverable entry point; see `CHANGELOG.md` for actual release content and `docs/RELEASING.md` for the release procedure.
```

## PRIVACY.md

Lives at repo root. Linked from README's new "Privacy" section. Sections per the brainstorm in conversation:

1. **TL;DR** — single line: "We don't collect anything. The app runs entirely on your machine."
2. **What stays local** — ADB connections, scrcpy stream data, mDNS scans, web UI in your browser, local-storage theme preference. Nothing leaves the local machine for any of these.
3. **What leaves your machine** — three categories per the inventory above:
   - **Update checks**: configurable URL, default `https://github.com/<your-githubOwner>/ws-scrcpy-web/releases/latest/download/releases.<channel>.json`. User can disable via Settings autoUpdate toggle.
   - **Dependency installation** (first run + retry-install): nodejs.org/dist, dl.google.com/android/repository, github.com/Genymobile/scrcpy/releases, github.com/bilbospocketses/ws-scrcpy-web/releases. Standard HTTPS — IP + User-Agent visible to operators.
   - **Code signing verification** (post-install, by your OS): SignPath revocation list at signpath.io. OS behavior, not the app.
4. **What we don't do** — no telemetry, no analytics, no crash reporting, no project-operated server, no cookies in web UI.
5. **Third-party operators** — table with links to privacy policies:
   - GitHub — https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement
   - Google (for adb) — https://policies.google.com/privacy
   - Node.js Foundation — https://nodejs.org/en/about/privacy
   - SignPath Foundation — https://signpath.org (note: only handles build-time signing; doesn't process user runtime data)
   - Velopack — https://velopack.io
   - Genymobile (scrcpy) — referenced via GitHub
6. **Web UI cookies / localStorage** — `localStorage`-only theme preference. No tracking, no cookies, no third-party scripts.
7. **Children's privacy** — dev tooling, not directed at children; we don't collect anything regardless. (COPPA flag.)
8. **Changes to this policy** — maintained directly with proper versioning. Major changes get a new "Effective: YYYY-MM-DD" stamp at the top.
9. **Contact** — [GitHub Issues](https://github.com/bilbospocketses/ws-scrcpy-web/issues).

Effective date: 2026-04-27.

## README.md updates

Add (or modify if exists) sections:

**Downloads**

```markdown
## Downloads

Get the latest release from the [Releases page](https://github.com/bilbospocketses/ws-scrcpy-web/releases/latest):

- **Windows (MSI):** `ws-scrcpy-web-<version>-Setup.msi`
- **Windows (Portable ZIP):** `ws-scrcpy-web-<version>-Portable.zip` — no install
- **Linux (AppImage):** `ws-scrcpy-web-<version>.AppImage` — `chmod +x` and run

This project uses [SignPath Foundation](https://signpath.org) for free code signing of its release artifacts.

For data-handling details, see our [Privacy Policy](PRIVACY.md).
```

**Linux install** — already present from P4b; add a sentence pointing at the AppImage `.sig` for verification:

```markdown
Verify the AppImage signature with:

    gpg --verify ws-scrcpy-web-<version>.AppImage.sig ws-scrcpy-web-<version>.AppImage

(The public key for SignPath Foundation's Linux signing is published at https://signpath.org/keys.)
```

## package.json scripts

Add:
- `"package:pack"`: shells out to `vpk pack ...` for local-build dry runs (Windows only). On non-Windows, prints "package:pack is Windows-only; use package:linux for AppImage" and exits cleanly.
- `"test:update-flow"`: invokes `pwsh scripts/test-update-flow.ps1` on Windows.
- `"release-notes"`: convenience for `node scripts/extract-changelog.mjs $npm_package_version`.

## File ownership matrix

**Workflow agent owns:**
- `.github/workflows/release.yml` (NEW)
- `.github/workflows/ci.yml` (REWRITE)

**Scripts agent owns:**
- `scripts/extract-changelog.mjs` (NEW)
- `scripts/__tests__/extract-changelog.test.mjs` (NEW)
- `scripts/test-update-flow.ps1` (NEW)
- `docs/RELEASING.md` (NEW)
- `RELEASE_NOTES.md` (NEW)
- `PRIVACY.md` (NEW)
- `README.md` (MODIFY — add Downloads + Privacy + sig verification)
- `package.json` (MODIFY — add 3 scripts)

**No-touch list:**
- Anything under `src/`, `launcher/`, `tray/`, `common/`, `assets/` — P6 doesn't change application code
- Existing scripts (`bump-version.mjs`, `assert-version-sync.mjs`, `fetch-servy.mjs`, `stage-publish.mjs`, `package-linux.mjs`, etc.) — used by CI, not modified
- The CHANGELOG itself (workflow uses it; doesn't write to it)

## Validation gates (lead)

1. `cargo check --workspace` — clean (no Rust changes expected)
2. `cross check --workspace --target x86_64-unknown-linux-gnu` — clean (no Rust changes expected)
3. `cargo test --workspace` — 46 tests still green
4. `cargo clippy --workspace --all-targets -- -D warnings` — clean
5. `npx tsc --noEmit` — clean (libcDetect pre-existing OK)
6. `npm test` — 501+N tests green where N is `extract-changelog` test count
7. `npm run build` — webpack green
8. `node scripts/extract-changelog.mjs Unreleased` — emits sensible output for the Unreleased section
9. `node scripts/extract-changelog.mjs Unreleased --unsigned` — emits the unsigned warning + SignPath credit + section
10. **YAML lint:** `gh workflow view release.yml` and `gh workflow view ci.yml` should parse without errors after pushing the branch (or use `actionlint` locally if available — Docker has actionlint images via `rhysd/actionlint`)
11. `pwsh -NoProfile -Command "Invoke-Expression (Get-Content scripts/test-update-flow.ps1 -Raw)"` — syntax-check the PowerShell script (don't execute, just `Get-Command -Syntax` style check)
12. **No live tag-push smoke** — releasing v0.1.0 happens manually after this branch merges. Lead does NOT push a real tag during P6 validation.

## Coordination notes

- Both agents read this contracts doc before any source edits
- No cross-file dependencies between the two agents (workflow YAML doesn't share files with scripts/markdown)
- Neither agent commits. Lead reviews diffs, validates, commits as one unit.
- If agents find drifts, append "## Agent drift notes" to bottom of this contracts doc.

## Risk register for SP3-close

- **`vpk pack` exact CLI shape on Windows** — spec doc shows `--azureTrustedSignFile` removed (we removed it). Confirm vpk's actual CLI matches the spec's args during a local dry-run before tag push.
- **`SignPath` Linux GPG signing flow** — the action returns `.sig` to the output dir. Confirm the file naming matches `<appimage>.sig` (vs `<appimage>.AppImage.sig` or another convention) at first signed-mode run.
- **`stage-publish.mjs` on Linux** — if the script has Windows-isms (path separators, `.exe` suffixes), the Linux job fails. Workflow agent should glance at it and flag drift.
- **First tag push (`v0.1.0`)** — will run unsigned (per decision 3). CI publishes a release with the warning. Watch the run; verify the SHA256SUMS file is generated correctly.
- **`SIGNPATH_*` non-secret vars** — until SignPath approval, these don't exist in GH repo settings. Workflow's signing branches won't fire, but the workflow YAML must still parse cleanly without them. `vars.SIGNPATH_ORGANIZATION_ID` evaluates to empty string, gated by `if: signing_mode == 'signed'`. Verify the unsigned path doesn't even reference them.

## Agent drift notes

### Workflow agent — 2026-04-26

**Hard blocker for build-linux: `stage-publish.mjs` is Windows-only as written.** Read confirms:

- Line 68–69: hard-requires `target/release/ws-scrcpy-web-launcher.exe` and `ws-scrcpy-web-tray.exe` (with `.exe` suffix). On Linux, cargo emits `ws-scrcpy-web-launcher` / `ws-scrcpy-web-tray` (no extension). `requirePath` will throw immediately.
- Line 73, 80, 115: `start.cmd` is required and copied unconditionally — but `start.cmd` is a Windows batch file with no Linux equivalent.
- Line 92: copies `tray.exe` to publish/ — there is no Linux tray binary in the current build.
- Lines 38–46 / 107–112 / 130–141 already have Windows/non-Windows branches for npm and Servy, so the file's authors anticipated cross-platform — but the binaries + start.cmd predates that work.

**Impact:** As contracts-spec'd (`build-linux` runs `node scripts/stage-publish.mjs`), the Linux job fails on step 1. `package-linux.mjs` then can't run because publish/ws-scrcpy-web-launcher is missing.

**Recommended fix (lead/Scripts agent decision — out of scope for workflow agent):**
- Option A: Teach `stage-publish.mjs` a Linux branch — different binary names (no `.exe`), skip `start.cmd` and `tray` on non-Windows, skip Servy (already does), keep dist/ + node_modules / package.json.
- Option B: Split into `stage-publish-windows.mjs` + `stage-publish-linux.mjs` and have release.yml call the right one per OS. Cleaner separation but two scripts to keep in sync.
- Option C: Keep stage-publish Windows-only; bake the Linux staging into `package-linux.mjs` directly. Aligns with existing P4b shape but bloats package-linux.

The contracts doc § Risk register already flagged this risk; this drift note is to confirm the risk landed and the fix is needed before first Linux release.

**Workflow YAML written as contracts-spec'd** (calls `stage-publish.mjs` from build-linux per § release.yml shape line 262). The YAML will need to be re-pointed at whatever script the lead picks for Linux staging. Single-line edit either way.

**Other notes (not blockers):**
- Used explicit `env:` block in prepare's signing step rather than direct `${{ secrets.SIGNPATH_API_TOKEN }}` interpolation in `run:` — same effect, but defaults the var to empty string when the secret is unset and avoids any shell-quoting weirdness with empty interpolations.
- Added `shell: pwsh` to the Windows `vpk pack` step to make the backtick line continuations explicit (PowerShell is default on windows-latest, but explicit is safer if GitHub ever changes the default).
- `wait-for-completion: true` is the v2 SignPath action default per their docs as of 2026; left explicit for clarity.
