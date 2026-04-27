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
   Confirm the SignPath credit is at the top and the captured section reads correctly. (If the project is in unsigned mode, also try `--unsigned` to preview the warning block CI will inject.)
6. **Commit and tag.**
   ```bash
   git add package.json Cargo.toml Cargo.lock CHANGELOG.md
   git commit -m "chore(release): vX.Y.Z"
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```
7. **Watch CI.** The tag push triggers `.github/workflows/release.yml`. Both Windows and Linux jobs run in parallel; the `publish` job uploads artifacts (MSI, portable ZIP, AppImage, AppImage.sig once SignPath is live, nupkg, RELEASES, releases.stable.json, SHA256SUMS) and creates a GitHub Release with auto-generated notes.
   ```bash
   gh run watch
   ```
8. **Verify the release** on the GitHub Releases page. Smoke-test downloads on a clean machine if possible.

## Cutting a beta release

Same as stable, but the tag uses a `-beta.N` suffix and CI marks the release as a pre-release.

```bash
node scripts/bump-version.mjs X.Y.Z-beta.1
git add package.json Cargo.toml Cargo.lock CHANGELOG.md
git commit -m "chore(release): vX.Y.Z-beta.1"
git tag -a vX.Y.Z-beta.1 -m "vX.Y.Z-beta.1"
git push origin main
git push origin vX.Y.Z-beta.1
```

The release workflow detects `*-beta*` in the tag name, sets `channel=beta`, and:

- The Velopack feed file is named `releases.beta.json` (so beta and stable channels are independent).
- `softprops/action-gh-release` is invoked with `prerelease: true`, hiding the release from the default Releases-page banner.

Beta users opt in by setting `channel=beta` in Settings (writes to `config.json`).

## Rollback procedure

**Never delete a release** -- existing installs may have already pulled it. Instead, fix-forward:

1. **Mark the bad release as a pre-release** so it disappears from the default Releases banner and won't be picked up as the latest stable feed entry:
   ```bash
   gh release edit vX.Y.Z --prerelease
   ```
2. **Cut a fix-forward release.** Bump to vX.Y.(Z+1), apply the fix, and push the tag. CI publishes a new release; the auto-update flow will pick it up on the next check.
3. (Optional) Edit the bad release's body on GitHub to add a "do not use, see vX.Y.(Z+1)" notice.

Reasoning: Velopack feed entries are append-only; deleting an entry breaks any client that already saw it.

## SignPath credit -- DO NOT REMOVE

`scripts/extract-changelog.mjs` always prepends:

```
_Signed via [SignPath Foundation](https://signpath.org)._
```

Even on unsigned releases. SignPath Foundation provides free OSS code signing for this project, and credit is a program requirement. The credit should remain in:

- The CI-generated release notes (`extract-changelog.mjs` handles this automatically).
- README.md `## Downloads` section.
- This file.

If you ever fork/relicense the build away from SignPath, remove the credit at that point -- but until then, leave it.

## First-time SignPath setup checklist

When the SignPath OSS application is approved:

1. **Add the API token** as a repository secret:
   - Repo Settings → Secrets and variables → Actions → New repository secret
   - Name: `SIGNPATH_API_TOKEN`
   - Value: the token from your SignPath organization's CI Users page

2. **Add the four non-secret identifiers** as repository variables (NOT secrets -- they're visible in the workflow runs):
   - Repo Settings → Secrets and variables → Actions → Variables tab → New repository variable
   - `SIGNPATH_ORGANIZATION_ID` -- from the SignPath organization page
   - `SIGNPATH_PROJECT_SLUG` -- from the SignPath project page (e.g., `ws-scrcpy-web`)
   - `SIGNPATH_WINDOWS_POLICY_SLUG` -- the slug for the policy that signs Windows EXEs and the MSI
   - `SIGNPATH_LINUX_POLICY_SLUG` -- the slug for the policy that produces the detached GPG `.sig` for the Linux AppImage

3. **Cut v0.1.1.** This is the project's first signed release. Follow [Cutting a stable release](#cutting-a-stable-release) using `0.1.1`.

4. **Verify the release.** The `mode=signed` branch in `.github/workflows/release.yml` will fire automatically once `SIGNPATH_API_TOKEN` exists. Confirm:
   - The MSI, launcher.exe, and tray.exe are signed by SignPath Foundation (Properties → Digital Signatures on Windows).
   - `<appimage>.sig` is present alongside the AppImage in the release assets.
   - `gpg --verify ws-scrcpy-web-0.1.1.AppImage.sig ws-scrcpy-web-0.1.1.AppImage` succeeds against the SignPath public key.
   - Release notes do NOT include the unsigned warning block.

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
