# Contributing to ws-scrcpy-web

Thanks for your interest. This document covers the essentials for getting a development environment running, the code-style bar, and how to land changes.

## Prerequisites

- **Node.js 24 LTS or newer** (`engines` field pins `>=24`)
- **ADB and scrcpy-server** — nothing to install. The app downloads both on first run into its own dependencies folder (`%PROGRAMDATA%\WsScrcpyWeb\dependencies\` on Windows, `<repo>/dependencies/` on Linux) and resolves them from there by absolute path.

  > **Do not put ADB on `PATH` and expect the app to find it — it won't, by design.** Every binary this project shells out to is resolved from its own dependencies folder, never from `PATH` or an environment variable. OS tools (`ip`, `arp`, `route`, `systemctl`, …) go through `resolveSystemTool()` in `src/server/service/systemTools.ts`, which scans the canonical system directories for an absolute path rather than trusting `PATH`. A PR that introduces a bare-name binary invocation will be sent back. See `docs/audits/2026-05-25-local-deps-compliance.md`.

- An Android device (physical or emulator) reachable via ADB, USB or network

## Setup

```bash
git clone https://github.com/bilbospocketses/ws-scrcpy-web.git
cd ws-scrcpy-web
npm install
npm run build
node dist/index.js
```

Server listens on port 8000. Open `http://localhost:8000/` in a Chromium browser (Chrome, Edge, Brave). Firefox works, with one gap: it cannot decode HEVC at all, so **H.265 streams won't play there** — H.264, AV1, VP8, and VP9 do. Firefox also returns a false `supported: false` for some H.264 profile strings it can actually decode, which the app handles by probing several profiles rather than one; see `docs/TECHNICAL_GUIDE.md` §8.3.

One thing worth knowing if you test on Firefox/Windows: it asks the operating system to decode H.264 while carrying its own AV1 decoder. On a machine with no OS-level H.264 decoder, H.264 genuinely will not play there while AV1 still does — that is the browser telling the truth, not a bug in the app.

## Development Workflow

```bash
npm run build:dev     # dev build with source maps
npx tsc --noEmit      # type-check — the build does NOT do this (see below)
npm test              # vitest run (unit tests)
npm run test:e2e      # Playwright end-to-end suite — see tests/e2e/README.md
npm run test:e2e:types # type-check the e2e suite (tests/ sits outside the root tsconfig)
npm run lint          # biome check
npm run format        # biome check --write
```

> **`npm test` does not run the end-to-end suite.** Vitest covers the unit tests;
> `npm run test:e2e` starts a real server on its own port against a throwaway config
> and drives it with Playwright. CI runs **both** inside `build-and-test`, so a change
> that passes `npm test` can still fail the required check. `tests/e2e/README.md`
> explains the isolation model and why the suite runs serially.

> **`npm run build` does not type-check.** The webpack build transpiles through
> `swc-loader`, which strips types without checking them — that is what made the
> TypeScript 7 migration possible, since TS 7 ships no programmatic compiler API for
> `ts-loader` to use. Type safety lives entirely in the separate `tsc --noEmit` pass.
> A green build proves nothing about types; run `npx tsc --noEmit` before you push.
> CI runs it, so a type error fails the PR rather than reaching `main` — but finding
> out locally is faster than finding out from a red check.

### Editor setup

TypeScript 7 ships no `tsserver.js` and no `lib.*.d.ts`, so **VS Code's built-in
TypeScript extension cannot drive it** — it reports the entire standard library as
missing and lights up every file, while `tsc --noEmit` is perfectly clean. The
squiggles are an artifact of the wrong language server, not real errors.

Install the recommended extension (`.vscode/extensions.json` will prompt you on first
open) and reload the window:

```
TypeScript (Native Preview) — typescriptteam.native-preview
```

If your editor isn't VS Code, point it at the native-preview language server or trust
`npx tsc --noEmit` as the source of truth.

A full build emits both the home-page bundle and the library bundles:

```
dist/public/bundle.js         home page
dist/public/bundle.css
dist/public/ws-scrcpy.umd.js  library (UMD: window.WsScrcpy)
dist/public/ws-scrcpy.esm.js  library (ES module)
dist/public/ws-scrcpy.css     library stylesheet
dist/public/ws-scrcpy.d.ts    library TypeScript types
dist/public/embed.html        iframe-friendly wrapper
dist/public/embed.js          embed page entry script
```

## Code Style

- **Biome** is the single source of truth for linting and formatting. Run `npm run format` before committing.
- **TypeScript 7** with `strict` enabled. No implicit `any`.
- **No Node.js Buffer polyfill in the browser** — use `Uint8Array` + the project's `BinaryReader` / `BinaryWriter`.
- **Dynamic HTML via DOM manipulation**, not string interpolation — the `html\`\`` tagged template in `HtmlTag.ts` XSS-escapes interpolated values. Build complex DOM with `document.createElement`.
- **Native `<dialog>` for modals** via the `Modal` base class in `src/app/ui/Modal.ts`. See existing subclasses for patterns.

## Tests

Tests use **Vitest** and live alongside the code (`*.test.ts`). Prefer unit tests for protocol layers (control messages, binary readers/writers, codec configs, device labels). Stream lifecycle is manually smoke-tested — WebCodecs + WebSocket + ADB timing doesn't mock cleanly.

Any PR that changes protocol code or control-message encoding MUST include or update a test.

## Specs and Plans

Larger features go through a spec → plan → implementation cycle:

- **Specs:** `docs/specs/YYYY-MM-DD-<topic>-design.md`
- **Plans:** `docs/plans/YYYY-MM-DD-<topic>.md`

Existing specs and plans under `docs/specs/`, `docs/plans/`, and the earlier `docs/superpowers/` tree are a useful read before proposing architectural changes.

## Commit Messages

Follow conventional-commit-style prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, `style:`, `chore:`, `build:`, `test:`.

Keep the subject line short and imperative. Wrap the body at 72 columns. Reference issue numbers when applicable.

Do not include AI-generated attribution lines in commit messages.

## Pull Requests

- Keep PRs focused on one concern. Big refactors are easier to review as a series of small commits than one sprawling patch.
- Update `CHANGELOG.md` under `[Unreleased]` for any user-visible change.
- Update `docs/TECHNICAL_GUIDE.md` or `README.md` when behavior the user sees changes.
- If you're changing protocol encoding, include a vitest test that asserts the exact byte layout.

## Branch Strategy

`main` is the development branch. Maintainer commits directly; contributors submit PRs from forks. No long-lived feature branches.

## Reporting Bugs

Open an issue on GitHub with:

- Expected vs actual behavior
- Browser + version, OS, Node.js version
- ADB version (`adb version`) and scrcpy-server version
- Device make / model / Android version
- Relevant excerpt from `ws-scrcpy-web.log`

## Reporting Security Issues

Do **not** file a public issue. See `SECURITY.md` for the private reporting flow.

## License

By contributing you agree your contributions are licensed under the project's GPL-3.0-only license.
