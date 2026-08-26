# ws-scrcpy-web TypeScript 7 — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put ws-scrcpy-web's root `typescript` on the 7.0 native compiler while keeping the single bundled `dist/public/ws-scrcpy.d.ts`, by isolating `dts-bundle-generator` (the last compiler-API-bound tool) on a vendored TypeScript 6 for the `build:types` step alone.

**Architecture:** After Phase 1, the `typescript` package is used by exactly two things: `tsc --noEmit` (typecheck; no emit) and `dts-bundle-generator` (emits the `.d.ts`). The app's JS is emitted by **swc-loader** and its webpack configs are loaded by **tsx** — neither imports the `typescript` package. So moving root to TS 7 changes the emitted `dist/` **not at all**; and because `dts-bundle-generator` stays on isolated TS 6, `ws-scrcpy.d.ts` is unchanged too. Phase 2 is therefore "run `tsc --noEmit` on the native compiler" plus a contained dependency-isolation trick — a near-no-op on build output, which makes verification a clean equivalence check.

**Tech Stack:** TypeScript 7.0.2 (root) + TypeScript 6.0.3 (isolated, `build:types` only), dts-bundle-generator 9.5.1, webpack 5 + swc-loader + tsx, vitest, npm workspaces/overrides.

## Global Constraints

- Root `typescript` → `^7.0.2`. `dts-bundle-generator` MUST resolve TypeScript **≤ 6** (it needs the programmatic API, absent from native TS until 7.1).
- **No change to shipped runtime behavior or emitted app JS** — swc owns emit; the `typescript` version must not alter `dist/` app bundles.
- **Keep the single bundled `ws-scrcpy.d.ts`** — do NOT switch to per-file `tsc --emitDeclarationOnly` (rejected in the 2026-04-17 stream-api plan: relative-import per-file emit is not a usable single-file drop-in).
- **Local-dependencies rule:** all build tools resolve from the app's own `node_modules` (never system PATH / env vars). The second `typescript` is toolchain-only (never shipped), so it does not engage the runtime-binary rule.
- Commits **SSH-signed**, **no AI attribution** (no `Co-Authored-By`). Merge via **squash** (`gh pr merge --squash --delete-branch --auto`), never rebase.
- **Multi-session discipline:** absolute paths everywhere; `git -C "C:/Users/jscha/source/repos/ws-scrcpy-web"`; stage only this task's own files (never `git add -A`).
- **Shipping Velopack app:** verification gates (build + typecheck + tests + smoke on the native compiler) before merge.
- Branch: `feat/ts7-phase2-typescript7` (already cut from `origin/main` @ 70f74a2; spec commit `bcd32db` already on it).

---

### Task 1: Migrate root to TS 7 + isolate dts-bundle-generator on TS 6

**Files:**
- Modify: `package.json` (devDependencies `typescript` `^6.0.2`→`^7.0.2`; add nested `overrides` for `dts-bundle-generator`→`typescript`), `package-lock.json` (regenerated)
- Modify (fallback only): `scripts/build-types.js` (module-resolution shim)
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Changed`)

**Interfaces:**
- Produces: a working `npm run build:types` that emits `dist/public/ws-scrcpy.d.ts` byte-equivalent to `main`, while `require('typescript').version` at repo root reports `7.0.x`. Tasks 2–3 rely on the repo building + typechecking on TS 7.

- [ ] **Step 1: Capture the baseline `.d.ts` (produced on current TS 6)**

Run:
```
npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run build:types
```
Then copy the artifact to the scratchpad as a baseline:
```
Copy-Item "C:/Users/jscha/source/repos/ws-scrcpy-web/dist/public/ws-scrcpy.d.ts" "C:/Users/jscha/AppData/Local/Temp/claude/C--Users-jscha/e0082075-6307-4c1d-9b95-a0d36cef6c1b/scratchpad/ws-scrcpy.d.ts.baseline"
```
Expected: `[build-types] wrote dist/public/ws-scrcpy.d.ts (<N> bytes)`, baseline copied.

- [ ] **Step 2: Confirm the current root TypeScript is 6.x (baseline)**

Run:
```
node -e "console.log(require('C:/Users/jscha/source/repos/ws-scrcpy-web/node_modules/typescript/package.json').version)"
```
Expected: `6.0.x`.

- [ ] **Step 3: Edit `package.json` — bump root TS 7 + nested override for dts-bundle-generator**

In `devDependencies`, change:
```json
    "typescript": "^6.0.2",
```
to:
```json
    "typescript": "^7.0.2",
```
And change the existing `overrides` block:
```json
  "overrides": {
    "fast-uri": "3.1.2"
  }
```
to:
```json
  "overrides": {
    "fast-uri": "3.1.2",
    "dts-bundle-generator": {
      "typescript": "6.0.3"
    }
  }
```

- [ ] **Step 4: Install to resolve the new tree**

Run:
```
npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" install
```
Expected: completes; `package-lock.json` updated; `typescript@7.0.x` at root, `typescript@6.0.3` nested under `dts-bundle-generator`.

- [ ] **Step 5: Verify the isolation — root on 7, dts-bundle-generator on 6**

Run:
```
node -e "console.log('root', require('C:/Users/jscha/source/repos/ws-scrcpy-web/node_modules/typescript/package.json').version)"
node -e "console.log('dbg ', require('C:/Users/jscha/source/repos/ws-scrcpy-web/node_modules/dts-bundle-generator/node_modules/typescript/package.json').version)"
```
Expected: `root 7.0.x` and `dbg  6.0.3`.
If the second command errors (no nested copy — npm hoisted/deduped it), the override did not take → go to **Step 5-FALLBACK**; otherwise skip it.

- [ ] **Step 5-FALLBACK (only if Step 5 shows no nested TS 6): apply the resolver shim**

Revert the `overrides` addition (leave only `"fast-uri": "3.1.2"`), and instead add a TS 6 **alias** to `devDependencies`:
```json
    "typescript": "^7.0.2",
    "typescript6": "npm:typescript@^6.0.3",
```
Prepend this shim to the top of `scripts/build-types.js`, immediately after the file's opening `'use strict';` and before any `require` of `dts-bundle-generator`:
```js
// Force dts-bundle-generator onto the vendored TS 6. It imports the TypeScript
// programmatic API, which the native TS 7 compiler does not ship until 7.1.
// We install TS 6 under the `typescript6` alias and redirect the bare
// `typescript` specifier to it for THIS process only, so root + CI stay on
// TS 7 while this one build step uses TS 6.
const Module = require('node:module');
const _origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'typescript' || request.startsWith('typescript/')) {
        request = 'typescript6' + request.slice('typescript'.length);
    }
    return _origResolve.call(this, request, ...rest);
};
```
Re-run `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" install`, then continue at Step 6.

- [ ] **Step 6: Regenerate the `.d.ts` on the TS-7 root (dts-bundle-generator using isolated TS 6)**

Run:
```
npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run build:types
```
Expected: `[build-types] wrote dist/public/ws-scrcpy.d.ts (<N> bytes)` — **success proves the isolation works** (dts-bundle-generator on native TS 7 would throw an API error).

- [ ] **Step 7: Diff the regenerated `.d.ts` against the baseline**

Run:
```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" --no-pager diff --no-index --stat "C:/Users/jscha/AppData/Local/Temp/claude/C--Users-jscha/e0082075-6307-4c1d-9b95-a0d36cef6c1b/scratchpad/ws-scrcpy.d.ts.baseline" "C:/Users/jscha/source/repos/ws-scrcpy-web/dist/public/ws-scrcpy.d.ts"
```
Expected: **no output** (identical). If it differs, inspect the full diff; only a changed generator banner/timestamp is acceptable — a change in the exported type surface is a failure and must be understood before proceeding.

- [ ] **Step 8: Typecheck on the native compiler**

Run:
```
npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" exec -- tsc --noEmit
```
(or `node "C:/Users/jscha/source/repos/ws-scrcpy-web/node_modules/typescript/bin/tsc" --noEmit -p "C:/Users/jscha/source/repos/ws-scrcpy-web/tsconfig.json"`)
Expected: exits 0, no errors — the code typechecks clean on TS 7 (`skipLibCheck` + `isolatedModules` already set).
Confirm the compiler used is native: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" exec -- tsc --version` → `Version 7.0.x`.

- [ ] **Step 9: Record the change in CHANGELOG.md**

Under `## [Unreleased]` → `### Changed`, add (beside the Phase 1 swc entry):
```
- Root TypeScript upgraded to the **7.0 native compiler** for `tsc --noEmit`. `dts-bundle-generator` (which still needs the pre-7.1 programmatic API) is isolated on a vendored TypeScript 6 for the `build:types` step only; the emitted app bundles and the bundled `ws-scrcpy.d.ts` are unchanged.
```

- [ ] **Step 10: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add package.json package-lock.json CHANGELOG.md
# if the shim fallback was used, also: git -C "..." add scripts/build-types.js
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "build(ts7): root on TypeScript 7.0.2; isolate dts-bundle-generator on TS 6 for build:types"
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" log -1 --format='%h %G? %s'
```
Expected: commit created, signature `G`.

---

### Task 2: Restore `typescript` to the Dependabot flow + sync docs

**Files:**
- Modify: `.github/dependabot.yml:25-32` (remove the `typescript` major-bump ignore + its comment block, added in #494)
- Modify: any doc that pins the toolchain at "TypeScript 6" (verify by grep; e.g. `README.md`, `docs/TECHNICAL_GUIDE.md`)

**Interfaces:**
- Consumes: nothing from Task 1 (independent config/doc change).
- Produces: Dependabot free to propose future `typescript` majors again (individually, for review).

- [ ] **Step 1: Remove the major-bump ignore block**

In `.github/dependabot.yml`, delete these lines (the comment + the `ignore:` block) that sit between `      prefix: "chore(deps)"` and `    # Batch all minor + patch bumps...`:
```yaml
    # TypeScript 7 is the native compiler with no programmatic API until 7.1, so the
    # webpack build (dts-bundle-generator; historically ts-loader/ts-node) can't build
    # against it yet. The 6->7 migration is staged deliberately -- see
    # docs/superpowers/specs/2026-07-18-ws-scrcpy-web-ts7-migration-design.md. Block the
    # major so Dependabot stops re-proposing the un-buildable jump.
    ignore:
      - dependency-name: "typescript"
        update-types: ["version-update:semver-major"]
```

- [ ] **Step 2: Find and fix any doc that pins "TypeScript 6"**

Run:
```
```
Use Grep for `TypeScript 6|typescript@6|TypeScript 6\.|\bTS 6\b` across `README.md docs/**/*.md CONTRIBUTING.md`. For any that states the toolchain version as 6 (not a historical note), update to 7. (Historical CHANGELOG entries and the migration spec/plan stay as written.)
Expected: at most a small number of hits; update only current-state toolchain statements.

- [ ] **Step 3: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add .github/dependabot.yml
# plus any docs touched in Step 2
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "chore(deps): drop the typescript major-bump ignore now that TS 7 is adopted"
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" log -1 --format='%h %G? %s'
```
Expected: commit created, signature `G`.

---

### Task 3: Pre-merge verification gate on the native compiler

**Files:** none (verification only; fix + re-verify if a gate fails).

**Interfaces:**
- Consumes: the TS-7 tree from Tasks 1–2.
- Produces: green build + tests + smoke evidence for the PR.

- [ ] **Step 1: Full production build on the native compiler**

Run:
```
npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run build
```
Expected: webpack (swc) + `build:types` both succeed; `dist/public/` contains the known artifact set (`bundle.js`, `bundle.css`, `ws-scrcpy.umd.js`, `ws-scrcpy.esm.js`, `ws-scrcpy.css`, `ws-scrcpy.d.ts`, `embed.html`, `embed.js`) and `dist/index.js`.

- [ ] **Step 2: Confirm emitted app JS is unchanged vs `main` (equivalence)**

The `typescript` version does not feed swc/tsx, so app bundles must be identical to `main`. Verify the key bundles are byte-stable by hashing them and comparing to a `main` build (produced in a throwaway checkout or from the last `main` CI artifact). At minimum, assert the `dist/` file set matches Phase 1's 41-file set and that `dist/public/ws-scrcpy.d.ts` equals the Task 1 baseline.
Run:
```
Get-ChildItem -Recurse "C:/Users/jscha/source/repos/ws-scrcpy-web/dist" -File | Measure-Object | Select-Object -ExpandProperty Count
```
Expected: same count as a `main` build (Phase 1 = 41 files). Any delta must be explained (expected: none).

- [ ] **Step 3: Full unit-test suite**

Run:
```
npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" test
```
Expected: all vitest tests green (Phase 1 baseline: 1478/1478).

- [ ] **Step 4: Smoke-run the built app**

Per Phase 1's method: stage seeds then start the app, or run `node dist/index.js` and confirm the process behaves identically to the `main` (Phase 1) build (starts without crashing; note that full serving needs the dev-supervisor + seeded assets, as established in Phase 1 — behavior must match `main`, not necessarily listen standalone).
Expected: identical boot behavior to `main`.

- [ ] **Step 5: Finish the branch**

Invoke **superpowers:finishing-a-development-branch**. Established session choice: **Push + create PR** with squash auto-merge:
```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" push -u origin feat/ts7-phase2-typescript7
gh pr create -R bilbospocketses/ws-scrcpy-web --fill --base main --head feat/ts7-phase2-typescript7
gh pr merge <N> -R bilbospocketses/ws-scrcpy-web --squash --delete-branch --auto
```
Then watch CI (`build-and-test` is the required check) to green + confirm merge.

---

## Self-Review

**1. Spec coverage:**
- Spec "confirm isolation mechanism" → Task 1 Steps 3–6 (overrides primary, shim fallback). ✓
- Spec "bump typescript → 7.0.2 keeping dts-bundle-generator on TS 6" → Task 1. ✓
- Spec "remove the #494 dependabot ignore" → Task 2 Step 1. ✓
- Spec "verify tsc --noEmit + build (incl build:types, .d.ts equivalent) + vitest + smoke on native" → Task 1 Steps 6–8 + Task 3. ✓
- Spec "hand-authored `.d.ts` ultimate fallback" → not a task; it is the escape hatch only if BOTH Step 5 override and Step 5-FALLBACK shim fail to isolate. Noted here rather than as a task to avoid speculative work (YAGNI); if reached, stop and re-plan.

**2. Placeholder scan:** Task 2 Step 2 uses Grep (a tool) rather than a canned command — acceptable (the empty code fence is intentional; the grep is described exactly). No TBD/TODO. Shim code is complete. No "handle edge cases" hand-waving.

**3. Type consistency:** No new types introduced; the public type surface is asserted **unchanged** (Task 1 Step 7 diff). The only "interface" is the isolation invariant (root=7, dts-bundle-generator=6), consistently referenced across tasks.
