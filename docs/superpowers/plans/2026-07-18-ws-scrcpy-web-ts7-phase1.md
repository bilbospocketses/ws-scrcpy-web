# ws-scrcpy-web TS 7 — Phase 1 (swc-loader swap) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ts-loader and ts-node with swc so the webpack build no longer imports the TypeScript compiler API, while staying on TypeScript 6 with no change to shipped behavior.

**Architecture:** ts-loader (already `transpileOnly`) → `swc-loader`; the `webpack/*.ts` configs load via `@swc-node/register` instead of `ts-node`. Type-safety stays with the separate `tsc --noEmit` CI step. Every task ends green (`tsc --noEmit` + `npm test`) and the final task proves output equivalence vs `main` plus a runtime smoke.

**Tech Stack:** webpack 5, `@swc/core` + `swc-loader`, `@swc-node/register`, TypeScript 6.0.x, vitest, Node 24.

## Global Constraints

- **Stay on TypeScript 6.x** — no `typescript` version bump in Phase 1 (that is Phase 2). Verbatim: `typescript@^6.0.2`.
- **No runtime behavior change** — the merge gate is: `dist/` functionally equivalent to `main`, `tsc --noEmit` green, `npm test` green, and a smoke-run of the built server.
- **Local-dependencies rule:** the swap is build-time devDependencies only (resolved from `node_modules`, exactly like `ts-loader` was). The vendored runtime binaries under `dependencies/` (node, scrcpy-server, node-pty) are NOT touched.
- **Branch:** `feat/ts7-phase1-swc-loader` (already created off `origin/main`).
- **Commits:** SSH-signed, no AI attribution.

---

### Task 1: isolatedModules safety net

**Files:**
- Modify: `tsconfig.json` (compilerOptions)

**Interfaces:**
- Consumes: nothing.
- Produces: a tsconfig that forbids constructs swc can't transpile per-file; later tasks rely on `tsc --noEmit` being green with this flag on.

- [ ] **Step 1: Add `isolatedModules` to tsconfig**

In `tsconfig.json`, inside `compilerOptions`, add:

```json
    "isolatedModules": true,
```

(place it near the other module options, e.g. after `"resolveJsonModule": true,`)

- [ ] **Step 2: Run the type-check**

Run: `npx tsc --noEmit`
Expected: PASS with no errors. If it reports `TS1205` (re-exported type) or `TS2748` (const enum), fix each by using `export type { X }` / replacing the `const enum` with a regular `enum` or a `const` object, then re-run until clean. (Expected to already be clean: ts-loader `transpileOnly` already transpiles per-file.)

- [ ] **Step 3: Confirm nothing else regressed**

Run: `npm test`
Expected: PASS (unchanged — this is a compiler-flag-only change).

- [ ] **Step 4: Commit**

```bash
git -C C:/Users/jscha/source/repos/ws-scrcpy-web add tsconfig.json
git -C C:/Users/jscha/source/repos/ws-scrcpy-web commit -m "build: enable isolatedModules (prep for swc per-file transpile)"
```

---

### Task 2: Replace ts-loader with swc-loader

**Files:**
- Modify: `package.json` (devDependencies)
- Modify: `webpack/ws-scrcpy-web.common.ts:73-77` (the `/\.tsx?$/` rule)

**Interfaces:**
- Consumes: `isolatedModules` from Task 1.
- Produces: a webpack build that transpiles TS via swc. Later tasks rely on `npm run build` succeeding without ts-loader present.

- [ ] **Step 1: Install swc, remove ts-loader**

Run:
```
npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web install --save-dev @swc/core@^1 swc-loader@^0.2
npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web uninstall ts-loader
```
Expected: `@swc/core` + `swc-loader` in devDependencies; `ts-loader` gone.

- [ ] **Step 2: Swap the loader rule**

In `webpack/ws-scrcpy-web.common.ts`, replace:

```ts
                {
                    test: /\.tsx?$/,
                    use: [{ loader: 'ts-loader', options: { transpileOnly: true } }],
                    exclude: /node_modules/,
                },
```

with:

```ts
                {
                    test: /\.tsx?$/,
                    exclude: /node_modules/,
                    use: {
                        loader: 'swc-loader',
                        options: {
                            // Transpile-only (type-safety stays with `tsc --noEmit`),
                            // matching the tsconfig emit: ES2022, esModuleInterop-style
                            // default imports, define-semantics class fields.
                            jsc: {
                                parser: { syntax: 'typescript', tsx: true },
                                target: 'es2022',
                                transform: { useDefineForClassFields: true },
                            },
                            // Leave module form to webpack (swc emits ESM; webpack bundles).
                        },
                    },
                },
```

- [ ] **Step 3: Build (dev, readable output) and type-check**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web run build:dev`
Expected: build SUCCEEDS, emits `dist/public/bundle.js`, `dist/index.js`, etc.

Run: `npx tsc --noEmit` (cwd = repo)
Expected: PASS.

- [ ] **Step 4: Run the test suite**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web test`
Expected: PASS (vitest transpiles via esbuild independently, so this is a regression check on the app, not on swc).

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/jscha/source/repos/ws-scrcpy-web add package.json package-lock.json webpack/ws-scrcpy-web.common.ts
git -C C:/Users/jscha/source/repos/ws-scrcpy-web commit -m "build: transpile with swc-loader instead of ts-loader"
```

---

### Task 3: Remove ts-node (config runtime → @swc-node/register)

**Files:**
- Modify: `package.json` (devDependencies)

**Interfaces:**
- Consumes: `@swc/core` from Task 2.
- Produces: a build whose `webpack/*.ts` config loads without ts-node. Later tasks rely on `npm run build` working with ts-node absent.

- [ ] **Step 1: Install @swc-node/register, remove ts-node**

Run:
```
npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web install --save-dev @swc-node/register@^1
npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web uninstall ts-node
```

- [ ] **Step 2: Verify webpack loads the .ts config via swc (the risky bit)**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web run build`
Expected: build SUCCEEDS (webpack resolves the `.ts` config through `@swc-node/register`; `interpret` lists it for `.ts`). The step exercises loading `webpack/ws-scrcpy-web.prod.ts` → `.common.ts`.

**If it FAILS to load the config** (e.g. "Unable to use specified module loader"): apply the fallback — convert the three `webpack/ws-scrcpy-web.{common,prod,dev}.ts` files to `.cjs`:
- rename to `.cjs`, change `import X from 'y'` → `const X = require('y')` and `import { a } from './z'` → `const { a } = require('./z.cjs')`, keep `module.exports = [...]`,
- update the `build`/`build:dev` scripts in `package.json` to point at the `.cjs` config paths,
- add `/** @type {import('webpack').Configuration} */` above the config objects for authoring hints,
- then re-run `npm run build` and confirm success.

- [ ] **Step 3: Type-check + tests still green**

Run: `npx tsc --noEmit`  → PASS
Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web test` → PASS

- [ ] **Step 4: Commit**

```bash
git -C C:/Users/jscha/source/repos/ws-scrcpy-web add -A
git -C C:/Users/jscha/source/repos/ws-scrcpy-web commit -m "build: load webpack config via @swc-node/register, drop ts-node"
```

---

### Task 4: Prove equivalence + smoke, open PR

**Files:** none (verification + release).

**Interfaces:**
- Consumes: the swc build from Tasks 2–3.
- Produces: a merged, verified Phase 1.

- [ ] **Step 1: Build a reference `dist/` from `main` (ts-loader)**

```bash
git -C C:/Users/jscha/source/repos/ws-scrcpy-web worktree add ../wssw-main origin/main
npm --prefix C:/Users/jscha/source/repos/wssw-main ci
npm --prefix C:/Users/jscha/source/repos/wssw-main run build:dev
```

- [ ] **Step 2: Build the branch `dist/` and compare**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web run build:dev`
Compare the two `dist/` trees:
```
# same set of emitted files + comparable sizes; content diffs are expected (swc vs tsc)
Compare-Object (Get-ChildItem -Recurse ../wssw-main/dist | Select Name,Length) (Get-ChildItem -Recurse ./dist | Select Name,Length)
```
Expected: same file set; no missing/extra bundles; sizes within a small delta. Content byte-diffs are acceptable (cosmetic transpile differences); a missing module/entry is NOT.

- [ ] **Step 3: Smoke-run the built server**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web run build && node C:/Users/jscha/source/repos/ws-scrcpy-web/dist/index.js` (background; stop after check)
Verify: server boots without error and serves the client — `curl -sf http://localhost:8000/ | Select-String '<script'` returns the index referencing `bundle.js`, and `curl -sf http://localhost:8000/bundle.js -o $null` succeeds (valid JS served). Stop the server.
Expected: boots, serves index + bundle, no unhandled exception in the log. (Full device streaming needs a real Android target and is out of scope for CI smoke.)

- [ ] **Step 4: Clean up the worktree**

```bash
git -C C:/Users/jscha/source/repos/ws-scrcpy-web worktree remove ../wssw-main
```

- [ ] **Step 5: Push + open PR**

```bash
git -C C:/Users/jscha/source/repos/ws-scrcpy-web push -u origin feat/ts7-phase1-swc-loader
```
Open the PR (base `main`) titled `build: swap ts-loader/ts-node for swc (TS 7 migration, phase 1)`, body summarizing: removes the compiler-API-bound loader/config-runtime, stays on TS 6, verified by output diff + `tsc --noEmit` + tests + smoke. Enable squash auto-merge; CI (`tsc --noEmit`, tests, `npm run build`) is the final gate.

---

## Self-Review

**Spec coverage:** Phase 1 items all mapped — isolatedModules (Task 1), swc-loader (Task 2), ts-node removal + fallback (Task 3), verification: output diff / tsc / tests / smoke (Task 4). Phase 2 (TS 7 bump, dts-bundle-generator, #487) is explicitly out of scope for this plan. ✓

**Placeholder scan:** No TBD/TODO; the `.cjs` fallback in Task 3 is fully specified (rename, require-conversion, script path update). ✓

**Type consistency:** No new code types introduced (build-config only); swc options block is self-consistent across tasks. ✓

**Note on TDD:** this is a build-system refactor, so the verification cycle is the existing test suite + `tsc --noEmit` + build-output equivalence + smoke, run at each task — not new unit tests (there is no new runtime code to unit-test).
