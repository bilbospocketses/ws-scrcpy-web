# ws-scrcpy-web → TypeScript 7 migration (design)

**Date:** 2026-07-18
**Status:** Phase 1 SHIPPED (#493 swc/tsx + #494 docs/ignore). Phase 2 APPROVED 2026-07-18 — Approach A (isolated TS 6 for `build:types`), in progress.
**Scope:** The build-system changes needed for ws-scrcpy-web to run on the TypeScript 7 native compiler.

## Problem

TypeScript 7.0 (the native / Go compiler) ships no stable *programmatic* API — that lands in 7.1. ws-scrcpy-web's build depends on three tools that import the compiler as a library, so none of them can run on TS 7:

- **ts-loader** — the webpack loader that transpiles the app's TS. It already runs `transpileOnly: true`, i.e. it only transpiles and does not type-check.
- **ts-node** — loads the TypeScript webpack configs (`webpack/ws-scrcpy-web.{common,prod,dev}.ts`).
- **dts-bundle-generator** — emits the bundled public `dist/public/ws-scrcpy.d.ts` consumed by the UMD/ESM/embed library builds.

**Key evidence — the code is already TS-7-clean.** In CI (`.github/workflows/ci.yml`), `npx tsc --noEmit` runs at step 2, *before* `npm run build` at step 6. Dependabot PR #487 (`typescript 6.0.3 → 7.0.2`) failed at `npm run build`; because steps are sequential, `tsc --noEmit` therefore **passed on TS 7**. So the type-check is happy on the native compiler — the only blockers are the three build tools above.

## Goal

Run ws-scrcpy-web on the TS 7 native compiler by replacing the compiler-API-bound build tools with API-free equivalents, with **no change to the shipped runtime behavior**.

## Non-goals

- No source/type changes to satisfy TS 7 — there are none (`tsc --noEmit` passes).
- No change to what the app does or how it is packaged/released (Velopack).
- Bundler stays webpack (no migration to vite/rspack).

## Approach: decoupled, two phases

Phase 1 removes the two fragile blockers (ts-loader, ts-node) **while staying on TypeScript 6**, so any behavior delta is provably the loader swap alone and not the compiler change. Phase 2 is a separate PR that bumps to TS 7 and resolves dts-bundle-generator.

---

## Phase 1 — swc-based build, still on TypeScript 6

### 1. `isolatedModules` safety net (lands first)

Enable `isolatedModules: true` in `tsconfig.json` and run `tsc --noEmit`. swc transpiles each file independently, so it cannot do the cross-file type erasure `tsc` performs; `isolatedModules` makes `tsc` flag anything that would break under per-file transpile (type re-exports without `export type`, `const enum`, etc.). The code already survives per-file transpile today — ts-loader `transpileOnly` uses `transpileModule`, which is per-file — so this is expected to pass clean. It lands first as cheap insurance, so any latent violation surfaces as a type error rather than a silent runtime break after the loader swap.

### 2. Loader: ts-loader → swc-loader

- Add `@swc/core` + `swc-loader` (devDependencies); remove `ts-loader`.
- Replace the webpack rule `{ test: /\.tsx?$/, use: [{ loader: 'ts-loader', options: { transpileOnly: true } }] }` (in `webpack/ws-scrcpy-web.common.ts`) with `swc-loader`.
- Configure swc to match the current tsconfig emit: TypeScript parser (tsx on), `jsc.target: es2022` (matches tsconfig `target: ES2022`), interop equivalent to `esModuleInterop`, and leave module form to webpack. The repo uses no decorators and no `const enum` (the usual swc/tsc divergence points).
- Remains transpile-only, exactly as today. Type safety stays with the separate `tsc --noEmit`.

### 3. Config runtime: remove ts-node

The `webpack/*.ts` configs are loaded by ts-node today (webpack auto-detects the `.ts` extension via `interpret`/`rechoir`). These files are outside `tsconfig`'s `include` (`src/**/*`), so they are not type-checked in CI regardless.

- **Primary:** keep the configs as `.ts` and let webpack's config resolver load them via `@swc-node/register` (swc-based, no compiler API; listed in `interpret` for `.ts`). Add it, remove `ts-node`.
- **Fallback (if the resolver does not pick it up cleanly):** convert the three `webpack/*.ts` files to plain `.cjs` (they already use `module.exports = [...]`), with JSDoc `@type {import('webpack').Configuration}` for authoring hints.

Either fully removes `ts-node`; the choice is settled during Phase 1 verification and has no runtime impact.

### 4. Verification (the gate — this is a shipping app)

- **Output equivalence:** build `dist/` on `main` (ts-loader) and on the branch (swc), then diff the emitted JS. Cosmetic transpile differences (helper naming, whitespace) are acceptable; functional differences are not.
- `npx tsc --noEmit` passes with `isolatedModules` on.
- `npm test` (vitest) passes; the Rust `cargo test` / `cargo clippy` steps are unaffected.
- **Smoke:** start the built app and confirm it actually runs (serves, a device session connects). A green build is necessary but not sufficient.

**Phase 1 done** = `ts-loader` and `ts-node` removed, build output equivalent, all checks green, app smoke-verified — still on TypeScript 6.

---

## Phase 2 — TypeScript 7 native compiler (this PR)

The app already type-checks clean on TS 7 (Dependabot #487's `tsc --noEmit` passed at CI step 2; only `npm run build` failed). After Phase 1 that build failure is isolated to the one remaining compiler-API tool — `dts-bundle-generator`, in `build:types`. So Phase 2 puts the root on TS 7 and keeps `dts-bundle-generator` on a vendored TS 6, walled off to `build:types` alone.

### Decision: keep the single bundled `.d.ts` (option a), not `tsc --emitDeclarationOnly` (option b)

`dist/public/ws-scrcpy.d.ts` is a **deliberately-shipped, single-file public artifact** — README, CONTRIBUTING, and `docs/TECHNICAL_GUIDE.md` all advertise "bundled TypeScript types," and the intended consumer usage is a one-file reference (`import type { StartStreamOptions } from './dist/public/ws-scrcpy'`). Option b was **already tried and rejected** during the original Stream API work: `docs/superpowers/plans/2026-04-17-stream-api.md` records that raw `tsc --emitDeclarationOnly` emits per-file declarations with relative imports (`from './startStream'`) that don't work as a single self-contained file — which is exactly why `dts-bundle-generator` was adopted. Reviving b would regress that public artifact to a per-file tree leaking `src/` internals and churn three docs. So we keep the bundle.

### Mechanism: vendored TS 6, isolated to `build:types`

Root `typescript` → `7.0.2`, used by `tsc --noEmit` and CI everywhere. `dts-bundle-generator` — the only tool still needing the TS ≤6 programmatic API (nothing lands natively until TS 7.1) — resolves a **separate vendored TS 6** (an `npm:typescript@6` alias in devDependencies) for that one release-time step. This is a temporary bridge: when `dts-bundle-generator` supports the TS 7.1 API, the alias is deleted and the root TS serves everything. Installing a second `typescript` devDependency is toolchain-only (never shipped) and does not touch the local-dependencies rule, which governs the app's *runtime* binaries.

The exact isolation is confirmed empirically as the plan's first task (candidates, cleanest first: npm `overrides` nesting `dts-bundle-generator`'s `typescript` to the alias → a `require`-resolver shim in `scripts/build-types.js` → a nested standalone install). Guaranteed fallback if none isolate cleanly: hand-author the small, stable public `ws-scrcpy.d.ts` (the surface is just `startStream`, the theme helpers, `version`, and ~5 types) and copy it at build time — no generator, no TS 6 at all.

### Steps

1. **Confirm the isolation mechanism** (spike): `build:types` emits a functionally-identical `ws-scrcpy.d.ts` while root `tsc --version` reports 7.x.
2. **Bump `typescript` → `7.0.2`** (root devDependencies); wire `dts-bundle-generator` to the vendored TS 6 per step 1.
3. **Remove the `typescript` major-bump `ignore`** from `.github/dependabot.yml` (added in #494) — TS 7 is now deliberately adopted, so future `typescript` updates flow through the normal grouped path again. (#487 is already closed.)
4. **Verify on the native compiler:** `npx tsc --noEmit` clean, `npm run build` (webpack/swc + `build:types`) succeeds with `dist/public/ws-scrcpy.d.ts` present and functionally equivalent to `main`, `npm test` (vitest) green, and the built app smoke-runs.

---

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| swc emit differs subtly from tsc emit | `isolatedModules` on + build-output diff + smoke run; repo uses no decorators / `const enum` (the usual divergence points). |
| Webpack config loses authoring type-safety when de-TS'd | Prefer keeping `.ts` behind `@swc-node/register`; if converting to `.cjs`, add JSDoc `@type`. Configs are not CI-type-checked today, so no CI coverage is lost. |
| Regression on a shipping app | Phase 1 is TypeScript-version-neutral; gated on output diff + smoke before merge; Velopack release flow untouched. |
| dts-bundle-generator has no TS 7 path (until 7.1) | Phase 2 isolates it on a vendored TS 6 for `build:types` only; hand-authored `.d.ts` is a guaranteed fallback. |

## Rollback

Phase 1 is a self-contained PR; reverting it restores ts-loader/ts-node. No data, release-format, or public-API changes.

## Success criteria

- **Phase 1:** ts-loader + ts-node gone; `dist/` output functionally identical to `main`; `tsc --noEmit` (isolatedModules) + `npm test` green; app smoke-verified; on TS 6.
- **Phase 2:** root `typescript@7.0.2`; `dts-bundle-generator` isolated on a vendored TS 6 (or the hand-authored fallback); `npx tsc --noEmit` + `npm run build` (incl. `build:types`) + `npm test` green on the native compiler; `dist/public/ws-scrcpy.d.ts` present and functionally equivalent to `main`; the #494 `typescript`-major dependabot `ignore` removed.
