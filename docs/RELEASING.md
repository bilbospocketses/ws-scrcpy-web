# Releasing ws-scrcpy-web

This is the operational runbook for cutting a release. Every step is a concrete command. If a step is unclear, fix this doc rather than guess.

## Cutting a stable release

1. **Pick the version.** Stable releases use plain semver: `vX.Y.Z` (no suffix).
2. **Update the working tree.** From a clean `main`:
   ```bash
   git checkout main
   git pull --ff-only
   ```
3. **Edit `CHANGELOG.md`.** Move pending entries from `[Unreleased]` into a real heading by running:
   ```bash
   node scripts/bump-version.mjs X.Y.Z
   ```
   This bumps `package.json`, `Cargo.toml`, and inserts the dated changelog header. The `[Unreleased]` block stays at the top, empty, ready for the next cycle.
4. **Sanity-check the working tree.**
   ```bash
   node scripts/assert-version-sync.mjs vX.Y.Z
   npm test
   cargo test --workspace
   npm run build
   ```
5. **Preview the release notes.**
   ```bash
   node scripts/extract-changelog.mjs vX.Y.Z
   ```
   Confirm the captured section reads correctly. While releases remain unsigned, also try `--unsigned` to preview the warning block CI will inject.
6. **Land the bump via a PR — the tag is created for you.** `main` is protected (PR + passing checks + signed commit required), so you can **not** `git push origin main`, and you do **not** tag by hand. The `auto-release.yml` pipeline (fires on every push to `main`) does the tagging. Two ways in:

   **(a) Label-driven (preferred).** Put a `release:beta` or `release:stable` label on the feature PR before it merges. On merge, the `Auto Release` workflow computes the next version, opens an **API-signed** bump PR (web-flow-signed so it satisfies `required_signatures`), and auto-merges it; that bump-commit merge then triggers the tag push. Nothing manual after labeling.

   **(b) Manual bump PR.** Otherwise open the bump PR yourself. The commit subject **must** start with `chore: bump to v` — `Auto Release` keys off it (mode 2):
   ```bash
   git checkout -b chore/bump-vX.Y.Z
   git add package.json Cargo.toml CHANGELOG.md   # files already edited in step 3
   git commit -m "chore: bump to vX.Y.Z"
   git push -u origin chore/bump-vX.Y.Z
   gh pr create --title "chore: bump to vX.Y.Z" --body "release vX.Y.Z"
   gh pr merge --squash --delete-branch --auto
   ```
   On merge, `Auto Release` detects the bump commit and pushes the `vX.Y.Z` tag itself, which triggers `release.yml`. **Never** run `git tag` / `git push origin vX.Y.Z` by hand — the release bot owns tagging.
7. **Watch CI.** The tag push triggers `.github/workflows/release.yml`. Both Windows and Linux jobs run in parallel; the `publish` job uploads artifacts (MSI, portable ZIP, AppImage, nupkg, releases.stable.json, SHA256SUMS) and creates a GitHub Release with auto-generated notes. (When a code-signing path is wired in, signed artifacts and detached signatures will be published alongside.)
   ```bash
   gh run watch
   ```
8. **Verify the release** on the GitHub Releases page. Smoke-test downloads on a clean machine if possible.

## Cutting a beta release

Same flow as stable (PR-based, auto-tagged), but the version carries a `-beta.N` suffix.

The fastest path is the **`release:beta` label** (step 6a): label the feature PR, merge it, and `Auto Release` cuts the next `-beta.N` for you. To cut a specific beta by hand, open a bump PR whose commit subject is `chore: bump to vX.Y.Z-beta.N` (step 6b); `Auto Release` tags it on merge:

```bash
git checkout -b chore/bump-vX.Y.Z-beta.N
node scripts/bump-version.mjs X.Y.Z-beta.N
git add package.json Cargo.toml CHANGELOG.md
git commit -m "chore: bump to vX.Y.Z-beta.N"
git push -u origin chore/bump-vX.Y.Z-beta.N
gh pr create --title "chore: bump to vX.Y.Z-beta.N" --body "release vX.Y.Z-beta.N"
gh pr merge --squash --delete-branch --auto
# Auto Release pushes the tag on merge — do NOT tag by hand.
```

The release workflow detects `*-beta*` in the tag name, sets `channel=beta`, and uses a separate Velopack feed file (`releases.beta.json`) so beta and stable channels are independent.

**Note (post-v0.1.23):** `softprops/action-gh-release` is NOT invoked with `prerelease: true`. GitHub's `/releases/latest` API endpoint excludes prereleases, and Velopack's GithubSource queries that endpoint to find the latest release in the configured channel — flagging beta tags as prereleases broke in-app updater discovery for beta-channel users. Channel separation is handled by the per-channel feed file alone. See `feedback_velopack_permachine_lessons.md` Gotcha 5 for the full diagnosis.

Beta users opt in by setting `channel=beta` in Settings (writes to `config.json`).

**Note on no-op companion releases:** earlier in the v0.1.23-beta.{1..18} chain, every fix beta was paired with a no-op target beta (e.g., beta.13 fix + beta.14 no-op) so we could test the in-app updater itself. Once the updater stabilized at beta.23, that practice was retired — fix betas now ship solo and are tested by upgrading from any earlier installed beta. See `todo_ws_scrcpy_web.md` "Release-cycle convention" for context.

## Rollback procedure

**Never delete a release** -- existing installs may have already pulled it. Instead, fix-forward:

1. **Mark the bad release as a pre-release** so it disappears from the default Releases banner and won't be picked up as the latest stable feed entry:
   ```bash
   gh release edit vX.Y.Z --prerelease
   ```
2. **Cut a fix-forward release.** Bump to vX.Y.(Z+1), apply the fix, and push the tag. CI publishes a new release; the auto-update flow will pick it up on the next check.
3. (Optional) Edit the bad release's body on GitHub to add a "do not use, see vX.Y.(Z+1)" notice.

Reasoning: Velopack feed entries are append-only; deleting an entry breaks any client that already saw it.

## Future signer setup (placeholder)

Release artifacts are currently unsigned. SignPath Foundation declined the OSS application on 2026-05-07. Code-signing is under evaluation; when a signer is selected, this section will document:

- The CI secret(s) and repository variable(s) needed to enable the signed-mode branch in `.github/workflows/release.yml`.
- The first signed release version + cut procedure.
- Verification steps (Windows: Properties → Digital Signatures; Linux: GPG `--verify` of the detached signature, if applicable).

Until then, the `prepare` job in `release.yml` always resolves `signing_mode=unsigned` (gated on a generic `SIGNING_API_TOKEN` secret that doesn't exist yet) and the dormant signer steps in `build-windows` / `build-linux` are commented out as scaffolding. The `--unsigned` warning block is auto-prepended to release notes by `scripts/extract-changelog.mjs`.

## Manual update-flow test

Before any major release, run the local v1 -> v2 update flow test on Windows to catch packaging regressions that CI can't see:

```pwsh
pwsh scripts/test-update-flow.ps1
```

The script is interactive -- it builds v0.1.0 + v0.1.1 in a sandbox, walks you through installing v0.1.0, sets `VELOPACK_FEED_URL` to a local feed, and asserts `<install-root>\sq.version` reads `0.1.1` after you click "Check now" + "Apply" in the browser.

This is intentionally NOT a CI gate -- it requires a real install, a real browser, and a real user. It's a release-time smoke test, not a regression test.

## See also

- `docs/specs/2026-04-26-sp3-velopack-installer.md` -- design rationale for the packaging stack.
- `docs/plans/2026-04-26-sp3-velopack-installer.md` -- the SP3 phasing plan.
- `docs/plans/sp3-p6-contracts.md` -- the agent contracts that produced this runbook.
- `PRIVACY.md` -- what the app does and doesn't send over the network.
