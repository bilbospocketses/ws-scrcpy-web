# Auto-Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate the full release pipeline so labeled PR merges produce published GitHub Releases with zero manual intervention.

**Architecture:** New `auto-release.yml` workflow fires on push to main, detects release labels on merged PRs, creates a version bump PR via GitHub App token, then tags on bump-merge to trigger the existing `release.yml`.

**Tech Stack:** GitHub Actions, GitHub Apps, `actions/create-github-app-token`, bash, existing `npm run version:bump` script.

**Spec:** `docs/superpowers/specs/2026-05-27-auto-release-pipeline-design.md`

---

### Task 1: Create the GitHub App (manual — not automatable)

**Files:** None (GitHub web UI)

This task CANNOT be done by an agent. The user must complete it manually.

- [ ] **Step 1: Create the GitHub App**

Go to https://github.com/settings/apps/new and create an app with:
- Name: `ws-scrcpy-web-release-bot`
- Homepage URL: `https://github.com/bilbospocketses/ws-scrcpy-web`
- Uncheck "Webhook > Active" (no webhook needed)
- Permissions > Repository permissions:
  - Contents: Read and write
  - Pull requests: Read and write
  - Metadata: Read-only (auto-granted)
- Where can this app be installed: Only on this account

Click "Create GitHub App". Note the **App ID** shown on the app's settings page.

- [ ] **Step 2: Generate a private key**

On the app settings page, scroll to "Private keys" and click "Generate a private key". Save the downloaded `.pem` file.

- [ ] **Step 3: Install the app on the repo**

On the app settings page, click "Install App" in the left sidebar. Install on `bilbospocketses/ws-scrcpy-web` (select "Only select repositories" and pick ws-scrcpy-web).

- [ ] **Step 4: Add repo secrets**

Go to https://github.com/bilbospocketses/ws-scrcpy-web/settings/secrets/actions and add:
- `RELEASE_APP_ID`: The App ID from Step 1
- `RELEASE_APP_PRIVATE_KEY`: The full contents of the `.pem` file from Step 2

- [ ] **Step 5: Verify**

Confirm both secrets appear in the repo's Actions secrets list. Delete the local `.pem` file.

---

### Task 2: Write the auto-release workflow

**Files:**
- Create: `.github/workflows/auto-release.yml`

- [ ] **Step 1: Create the workflow file**

Write `.github/workflows/auto-release.yml` with the following content:

```yaml
# Automated release pipeline. Fires on every push to main.
#
# Mode 1 (labeled-PR merge): Detects release:beta or release:stable
# label on the merged PR, computes the next version, creates a bump PR.
#
# Mode 2 (bump-commit merge): Detects the bump PR's squash-merge
# commit, pushes the version tag to trigger release.yml.
#
# Mode 3 (neither): Exits. No release for unlabeled merges.

name: Auto Release

on:
  push:
    branches: [main]

concurrency:
  group: auto-release
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  auto-release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          fetch-depth: 0

      - uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        id: app-token
        with:
          app-id: ${{ secrets.RELEASE_APP_ID }}
          private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}

      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: 24.x

      - name: Detect mode
        id: detect
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: |
          COMMIT_MSG=$(git log -1 --format=%s)

          # Mode 2: bump commit -> tag only
          if [[ "$COMMIT_MSG" =~ ^"chore: bump to v" ]]; then
            VERSION="${COMMIT_MSG#chore: bump to v}"
            # Strip PR number suffix that GitHub appends on squash-merge
            VERSION="${VERSION%% (#*}"
            echo "mode=tag" >> "$GITHUB_OUTPUT"
            echo "version=$VERSION" >> "$GITHUB_OUTPUT"
            echo "Detected bump commit -> tagging v${VERSION}"
            exit 0
          fi

          # Mode 1: check merged PR for release label
          PR_NUMBER=$(gh pr list --repo "$GITHUB_REPOSITORY" \
            --search "$GITHUB_SHA" --state merged \
            --json number --jq '.[0].number // empty')

          if [ -z "$PR_NUMBER" ]; then
            echo "mode=skip" >> "$GITHUB_OUTPUT"
            echo "No merged PR found for $GITHUB_SHA -> skip"
            exit 0
          fi

          LABEL=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" \
            --json labels --jq '
            .labels[].name
            | select(. == "release:beta" or . == "release:stable")
          ' | head -1)

          if [ -z "$LABEL" ]; then
            echo "mode=skip" >> "$GITHUB_OUTPUT"
            echo "PR #${PR_NUMBER} has no release label -> skip"
            exit 0
          fi

          echo "mode=bump" >> "$GITHUB_OUTPUT"
          echo "label=$LABEL" >> "$GITHUB_OUTPUT"
          echo "pr_number=$PR_NUMBER" >> "$GITHUB_OUTPUT"
          echo "Detected PR #${PR_NUMBER} with label ${LABEL} -> bump"

      - name: Compute next version
        if: steps.detect.outputs.mode == 'bump'
        id: version
        run: |
          CURRENT=$(node -p "require('./package.json').version")
          LABEL="${{ steps.detect.outputs.label }}"

          if [ "$LABEL" = "release:beta" ]; then
            if [[ "$CURRENT" =~ -beta\.([0-9]+)$ ]]; then
              BASE="${CURRENT%-beta.*}"
              NEXT_BETA=$((${BASH_REMATCH[1]} + 1))
              VERSION="${BASE}-beta.${NEXT_BETA}"
            else
              IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
              VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))-beta.1"
            fi
          elif [ "$LABEL" = "release:stable" ]; then
            if [[ "$CURRENT" =~ -beta\. ]]; then
              VERSION="${CURRENT%-beta.*}"
            else
              IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
              VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"
            fi
          fi

          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          echo "Computed next version: ${CURRENT} -> ${VERSION} (${LABEL})"

      - name: Create bump PR
        if: steps.detect.outputs.mode == 'bump'
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: |
          VERSION="${{ steps.version.outputs.version }}"
          BRANCH="auto-release/v${VERSION}"

          git config user.name "ws-scrcpy-web-release-bot[bot]"
          git config user.email "${{ secrets.RELEASE_APP_ID }}+ws-scrcpy-web-release-bot[bot]@users.noreply.github.com"

          git checkout -b "$BRANCH"
          node scripts/bump-version.mjs "$VERSION"
          git add package.json Cargo.toml CHANGELOG.md
          git commit -m "chore: bump to v${VERSION}"
          git push origin "$BRANCH"

          gh pr create \
            --title "chore: bump to v${VERSION}" \
            --body "Automated version bump to v${VERSION}. Triggered by PR #${{ steps.detect.outputs.pr_number }} (${{ steps.detect.outputs.label }})." \
            --head "$BRANCH" \
            --base main

          gh pr merge --auto --squash "$BRANCH"
          echo "Bump PR created and auto-merge enabled for v${VERSION}"

      - name: Push tag
        if: steps.detect.outputs.mode == 'tag'
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: |
          VERSION="${{ steps.detect.outputs.version }}"

          git config user.name "ws-scrcpy-web-release-bot[bot]"
          git config user.email "${{ secrets.RELEASE_APP_ID }}+ws-scrcpy-web-release-bot[bot]@users.noreply.github.com"

          git tag -a "v${VERSION}" -m "v${VERSION}"
          git push origin "v${VERSION}"
          echo "Pushed tag v${VERSION} -> release.yml will take it from here"
```

- [ ] **Step 2: Verify the file passes YAML lint**

Run from the repo root:
```bash
node -e "const y=require('fs').readFileSync('.github/workflows/auto-release.yml','utf8'); try{require('yaml').parse(y);console.log('YAML OK')}catch(e){console.error(e.message);process.exit(1)}"
```

If `yaml` is not installed, just visually confirm indentation is correct (the YAML parser in GitHub Actions is lenient, and CI will catch syntax errors).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/auto-release.yml
git commit -m "ci: add auto-release pipeline

Automates version bump + tag push on labeled PR merges.
release:beta -> next beta, release:stable -> next stable.
Uses GitHub App token for downstream workflow triggers."
```

---

### Task 3: Create the release labels

**Files:** None (GitHub API)

- [ ] **Step 1: Create the `release:beta` label**

```bash
gh label create "release:beta" \
  --repo bilbospocketses/ws-scrcpy-web \
  --description "Auto-release: bump to next beta on merge" \
  --color "1d76db"
```

- [ ] **Step 2: Create the `release:stable` label**

```bash
gh label create "release:stable" \
  --repo bilbospocketses/ws-scrcpy-web \
  --description "Auto-release: bump to next stable on merge" \
  --color "0e8a16"
```

- [ ] **Step 3: Verify**

```bash
gh label list --repo bilbospocketses/ws-scrcpy-web | grep "release:"
```

Expected output:
```
release:beta    Auto-release: bump to next beta on merge    #1d76db
release:stable  Auto-release: bump to next stable on merge  #0e8a16
```

---

### Task 4: End-to-end test with the Velopack upgrade PR

**Files:** None (testing the pipeline)

The Velopack 1.0.1 upgrade PR (#176) is already open. We'll use it as the first test of the pipeline. However, the auto-release workflow needs to be on main before PR #176 merges. So:

- [ ] **Step 1: Land the auto-release workflow first**

The workflow file from Task 2 needs to be on main before we can test it. Create a separate PR for just the workflow:

```bash
git push origin chore/velopack-1.0.1  # already pushed
```

Wait -- the auto-release.yml needs to be on main BEFORE PR #176 merges. Two options:
1. Add auto-release.yml to the Velopack PR (bundle them)
2. Merge auto-release.yml in a separate PR first, then label PR #176

Option 2 is cleaner. Create a PR for the workflow + labels from the commit in Task 2:

```bash
git checkout -b ci/auto-release-pipeline
git cherry-pick <commit-from-task-2>
git push -u origin ci/auto-release-pipeline
gh pr create \
  --title "ci: add auto-release pipeline" \
  --body "Adds auto-release.yml workflow. See spec: docs/superpowers/specs/2026-05-27-auto-release-pipeline-design.md" \
  --head ci/auto-release-pipeline \
  --base main
```

Wait for CI green, merge (no release label -- this is infra, not a release).

- [ ] **Step 2: Add the `release:beta` label to PR #176**

After auto-release.yml is on main:

```bash
gh pr edit 176 --repo bilbospocketses/ws-scrcpy-web --add-label "release:beta"
```

- [ ] **Step 3: Let auto-merge fire on PR #176**

PR #176 already has auto-merge enabled. When CI passes, it squash-merges. The auto-release workflow should:
1. Fire on the merge commit
2. Detect `release:beta` label on PR #176
3. Compute version: current `0.1.28` -> `0.1.29-beta.1`
4. Create bump PR `auto-release/v0.1.29-beta.1`

- [ ] **Step 4: Watch the bump PR**

```bash
gh pr list --repo bilbospocketses/ws-scrcpy-web --head "auto-release/"
```

Verify:
- Bump PR was created with title "chore: bump to v0.1.29-beta.1"
- CI is running on the bump PR
- Auto-merge is enabled

- [ ] **Step 5: Watch the tag + release**

After bump PR merges:

```bash
gh run list --repo bilbospocketses/ws-scrcpy-web --workflow=auto-release.yml --limit 2
```

Verify the second run detected the bump commit and pushed the tag:

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" fetch --tags
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" tag -l "v0.1.29*"
```

Then verify release.yml fired:

```bash
gh run list --repo bilbospocketses/ws-scrcpy-web --workflow=release.yml --limit 1
```

- [ ] **Step 6: Verify published release**

```bash
gh release view v0.1.29-beta.1 --repo bilbospocketses/ws-scrcpy-web
```

Confirm: MSI, Portable.zip, nupkg, AppImage, releases.stable.json (or beta.json), SHA256SUMS all present.

- [ ] **Step 7: VM smoke the MSI**

Install the published MSI on a clean VM. Verify the app starts, connects to a device, and the in-app updater reports the correct version (`0.1.29-beta.1`).

---

### Task 5: Update TODO and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-05-27-auto-release-pipeline-design.md` (status: Draft -> Shipped)
- Modify: `CHANGELOG.md` (add entry under [Unreleased])

- [ ] **Step 1: Update spec status**

Change the status line in the spec from `Draft` to `Shipped`.

- [ ] **Step 2: Add CHANGELOG entry**

Under `## [Unreleased]` in CHANGELOG.md, add to the `### Changed` section (create it if needed):

```markdown
- **Automated release pipeline.** New `auto-release.yml` workflow automates version bump + tag push on labeled PR merges. Add `release:beta` or `release:stable` label to a PR; on merge, the pipeline computes the next version, creates a bump PR, and after CI passes, pushes the tag to trigger the full build + publish. No manual intervention required.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-05-27-auto-release-pipeline-design.md CHANGELOG.md
git commit -m "docs: mark auto-release pipeline shipped, update CHANGELOG"
```

- [ ] **Step 4: Update todo_ws_scrcpy_web.md**

Close TODO 18 (local vpk re-pin) since the Velopack 1.0.1 upgrade that exercises the pipeline also resolves it. Update the Velopack freshness check in the Reference section to note `1.0.1` is now the active pin.
