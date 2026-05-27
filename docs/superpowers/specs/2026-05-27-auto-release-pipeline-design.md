# Auto-Release Pipeline Design

**Date:** 2026-05-27
**Status:** Draft
**Scope:** New `auto-release.yml` workflow that automates version bump, tag, and release after labeled PRs merge to main.

## Problem

The current release flow requires 4 manual steps between PR merge and published GitHub Release: run `npm run version:bump`, commit, tag, push. Each step is dead time waiting for a human to nudge the pipeline forward. The VM smoke happens on the published release anyway, so there is no value in a manual gate before publish.

## Design

### Trigger and version logic

A new workflow `auto-release.yml` triggers on `push` to `main`. On each trigger it determines whether to act:

1. **Labeled-PR merge:** Check the merged commit's associated PR for a `release:beta` or `release:stable` label via `gh pr list --search <sha>`. If found, compute the next version and create a bump PR.
2. **Bump commit merge:** If the commit message matches `chore: bump to v*`, skip to tag creation (push `v<version>` tag). This is the second firing after the bump PR merges.
3. **Neither:** Exit early. Docs-only PRs, CI changes, and Dependabot merges without a release label produce no release.

### Version computation

Read the current version from `package.json`.

- **`release:beta`:** If current is `X.Y.Z` (no prerelease), produce `X.Y.(Z+1)-beta.1`. If current is `X.Y.Z-beta.N`, produce `X.Y.Z-beta.(N+1)`.
- **`release:stable`:** If current is `X.Y.Z-beta.N`, produce `X.Y.Z` (strip prerelease). If current is `X.Y.Z` (already stable), produce `X.Y.(Z+1)`.

### Pipeline chain

```
Feature PR merges to main (labeled release:beta or release:stable)
  |
  v
auto-release.yml fires (1st time)
  -> Detects labeled PR
  -> Computes next version
  -> Checks out main, runs `npm run version:bump <version>`
  -> Creates branch `auto-release/v<version>`
  -> Pushes branch, creates PR with `gh pr create`
  -> Enables auto-merge with `gh pr merge --auto --squash`
  |
  v
CI (build-and-test) runs on bump PR (~2 min)
  -> Auto-merge fires on green
  |
  v
Bump PR squash-merges to main
  |
  v
auto-release.yml fires (2nd time)
  -> Detects bump commit (message: "chore: bump to v<version>")
  -> Extracts version from commit message
  -> Creates + pushes annotated signed tag `v<version>`
  |
  v
release.yml fires (existing workflow, triggered by tag push)
  -> prepare -> build-windows + build-linux -> publish
  |
  v
GitHub Release published. VM-smoke at leisure.
```

### Authentication

GitHub App token via `actions/create-github-app-token`. The App needs:
- `contents: write` (push branches + tags)
- `pull_requests: write` (create bump PR, enable auto-merge)

GitHub App tokens are NOT subject to the `GITHUB_TOKEN` workflow-trigger suppression, so:
- The bump PR push triggers CI (build-and-test)
- The tag push triggers release.yml

**One-time setup:**
1. Create GitHub App "ws-scrcpy-web-release-bot" with the permissions above
2. Install on `bilbospocketses/ws-scrcpy-web`
3. Store `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` as repo secrets

### Concurrency and safety

**Infinite loop prevention:** The workflow distinguishes its two firing modes by commit message pattern. A bump commit (`chore: bump to v*`) triggers tagging only, never another bump. A labeled-PR commit triggers bumping only, never tagging.

**Concurrent merges:** `concurrency: { group: auto-release, cancel-in-progress: false }` serializes runs. The second merge queues behind the first. By the time it runs, `package.json` reflects the first bump, so the second increments correctly.

**Bump PR CI failure:** Auto-merge does not fire. The bump PR stays open for investigation. No release ships with a broken build.

**Label removed post-merge:** The workflow reads labels at trigger time. No label = no action. Safe default.

**Empty CHANGELOG `[Unreleased]`:** The bump script handles this gracefully -- produces an empty version section. Acceptable for betas; stable releases should have changelog entries written in feature PRs.

### Workflow file sketch

```yaml
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
      - uses: actions/checkout@<sha> # v6.0.2
        with:
          fetch-depth: 0

      - uses: actions/create-github-app-token@<sha>
        id: app-token
        with:
          app-id: ${{ secrets.RELEASE_APP_ID }}
          private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}

      - uses: actions/setup-node@<sha> # v6.4.0
        with:
          node-version: 24.x

      # Determine mode: labeled-PR-merge or bump-commit
      - id: detect
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: |
          COMMIT_MSG=$(git log -1 --format=%s)

          # Mode 2: bump commit -> tag only
          if [[ "$COMMIT_MSG" =~ ^"chore: bump to v" ]]; then
            VERSION=$(echo "$COMMIT_MSG" | sed 's/chore: bump to v//')
            echo "mode=tag" >> "$GITHUB_OUTPUT"
            echo "version=$VERSION" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          # Mode 1: check merged PR for release label
          PR_JSON=$(gh pr list --repo "$GITHUB_REPOSITORY" \
            --search "$GITHUB_SHA" --state merged --json number,labels --jq '.[0]')

          if [ -z "$PR_JSON" ] || [ "$PR_JSON" = "null" ]; then
            echo "mode=skip" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          LABEL=$(echo "$PR_JSON" | jq -r '
            .labels[]?.name
            | select(. == "release:beta" or . == "release:stable")
          ' | head -1)

          if [ -z "$LABEL" ]; then
            echo "mode=skip" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          echo "mode=bump" >> "$GITHUB_OUTPUT"
          echo "label=$LABEL" >> "$GITHUB_OUTPUT"

      # Compute next version (bump mode only)
      - if: steps.detect.outputs.mode == 'bump'
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

      # Create bump PR (bump mode only)
      - if: steps.detect.outputs.mode == 'bump'
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: |
          VERSION="${{ steps.version.outputs.version }}"
          BRANCH="auto-release/v${VERSION}"

          git config user.name "ws-scrcpy-web-release-bot[bot]"
          git config user.email "<app-id>+ws-scrcpy-web-release-bot[bot]@users.noreply.github.com"

          git checkout -b "$BRANCH"
          node scripts/bump-version.mjs "$VERSION"
          git add package.json Cargo.toml CHANGELOG.md
          git commit -m "chore: bump to v${VERSION}"
          git push origin "$BRANCH"

          gh pr create \
            --title "chore: bump to v${VERSION}" \
            --body "Automated version bump to v${VERSION}." \
            --head "$BRANCH" \
            --base main

          gh pr merge --auto --squash "$BRANCH"

      # Push tag (tag mode only)
      - if: steps.detect.outputs.mode == 'tag'
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: |
          VERSION="${{ steps.detect.outputs.version }}"
          git config user.name "ws-scrcpy-web-release-bot[bot]"
          git config user.email "<app-id>+ws-scrcpy-web-release-bot[bot]@users.noreply.github.com"

          git tag -a "v${VERSION}" -m "v${VERSION}"
          git push origin "v${VERSION}"
```

**Note:** SHA pins for all actions will be resolved at implementation time per the repo's `sha_pinning_required` enforcement. The `<app-id>` placeholder in the email will be replaced with the actual GitHub App numeric ID.

### Files changed

| File | Change |
|------|--------|
| `.github/workflows/auto-release.yml` | New workflow (above) |
| Repo secrets | `RELEASE_APP_ID` + `RELEASE_APP_PRIVATE_KEY` (manual setup) |
| GitHub App | One-time creation + installation (manual setup) |

No changes to existing workflows (`ci.yml`, `release.yml`, `codeql.yml`). No changes to application code. The existing `dependabot-auto-merge.yml` is not involved -- the bump PR auto-merges via `gh pr merge --auto` in the workflow itself.

### Out of scope

- Changing the existing `release.yml` build/publish logic
- Automated VM smoke testing (remains manual)
- Automated CHANGELOG entry authoring (feature PRs still write `[Unreleased]` content manually)
- Cross-repo applicability (this is ws-scrcpy-web only; other repos can adopt the pattern later)

### Testing plan

1. Create the GitHub App and install it
2. Add the workflow to a feature branch, merge with `release:beta` label
3. Verify: bump PR created automatically, CI runs on it, auto-merge fires, tag pushed, release.yml builds and publishes
4. VM-smoke the published beta
5. Test `release:stable` label path with a second merge
