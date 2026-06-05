# Contributing to ws-scrcpy-web

Thanks for your interest. This document covers the essentials for getting a development environment running, the code-style bar, and how to land changes.

## Prerequisites

- **Node.js 24 LTS or newer** (`engines` field pins `>=24`)
- **ADB** (Android Debug Bridge) available on `PATH` or inside a `dependencies/adb/` folder at the repo root
- **scrcpy-server** binary (downloaded by the in-app updater; no manual step needed for local dev)
- An Android device (physical or emulator) reachable via ADB, USB or network

## Setup

```bash
git clone https://github.com/bilbospocketses/ws-scrcpy-web.git
cd ws-scrcpy-web
npm install
npm run build
node dist/index.js
```

Server listens on port 8000. Open `http://localhost:8000/` in a Chromium browser (Chrome, Edge, Brave). Firefox works for H.264 streams only — its `VideoDecoder.isConfigSupported` rejects hardware-encoded HEVC.

## Development Workflow

```bash
npm run build:dev     # dev build with source maps
npm test              # vitest run (all tests)
npm run lint          # biome check
npm run format        # biome check --write
```

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
- **TypeScript 6** with `strict` enabled. No implicit `any`.
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
