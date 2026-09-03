# End-to-end tests

Playwright suite covering the embed-consent protocol, the framing headers and the
Settings → Embedding surface.

```bash
npm run test:e2e            # run the suite
npm run test:e2e:types      # typecheck it (tests/ is outside the root tsconfig)
npx playwright test --ui    # pick through it interactively
```

`npm run build` must have run at least once: the suite starts the built
`dist/index.js`, not a dev server.

## What this covers that the unit tests do not

`src/server/security/frameGuard.test.ts` and `embedRequests.test.ts` already cover
the pure functions. These specs exist for the layer underneath that: a real server
process, real sockets, and the config file it actually writes. Two failures that a
unit test cannot see, and that this suite would:

- `securityHeaders()` once applied only to the static handler, so the login page and
  its 401 shipped with no framing headers at all. The function was fine; the wiring
  was not.
- An approval that rebuilt `config.json` instead of amending it would drop `webPort`
  and move the running server to another port. Every consent spec asserts the
  untouched keys for that reason.

## Three tiers, one suite

| Tag | Subject | Runs in | Command |
|---|---|---|---|
| *(untagged)* | `node dist/index.js`, throwaway data root | `build-and-test` | `npm run test:e2e` |
| `@docker` | the built image, via docker-compose.yml | `build-and-test` | `npm run test:e2e:docker` |
| `@device` | the image + an Android emulator | qa-harness only | `npm run test:e2e:device` |

Tag by putting the marker in the test **TITLE** — `test('@device streams h264', …)`
— which is what Playwright's `--grep` matches. A tag in a comment or in a
`describe` block's metadata does nothing, and the spec silently joins the default
tier.

One suite, partitioned by tag rather than split across directories or repos: the
default config `grepInvert`s the two tags, and `playwright.docker.config.ts`
greps them back in. A feature's specs therefore stay together — the device
streaming specs belong beside the settings specs that configure the codec they
stream — and there is one support library and one selector vocabulary.

`@device` specs are authored here and run there. Nothing about them is
qa-harness-specific except the emulator's presence, so keeping them beside their
feature's other specs costs nothing and forking the support library would cost a
lot.

**`test:e2e:device` uses an inline env assignment** (`QA_DEVICE=1 QA_EXTERNAL_STACK=1 …`).
That is POSIX syntax and is correct: the script is invoked by `qa-harness` from
inside its Linux runner, never from PowerShell. It is not broken on Windows, it
is simply not for Windows — please do not "fix" it with `cross-env`.

`QA_EXTERNAL_STACK=1` tells the container config **not** to start a stack of its
own, because qa-harness already owns one (its compose topology adds the emulator
and a network this repo knows nothing about) and points `PLAYWRIGHT_BASE_URL` at
it.

## Isolation

The suite never touches a real install. It runs its own server on **port 8123**
against a **throwaway data root** under the OS temp directory:

| Variable | Effect |
|---|---|
| `PROGRAMDATA` / `DATA_ROOT` | Redirects the whole data root, including `wsscrcpy.db` |
| `WS_SCRCPY_CONFIG` | Points `config.json` at the throwaway root |
| `WS_SCRCPY_WEB_PORT` | Binds 8123 instead of the configured port |

Isolating only the config file is not enough — per-user settings live in
`<dataRoot>/wsscrcpy.db`, so the suite would otherwise read and write a developer's
real database. And `reuseExistingServer` is off: a server already on this port is not
necessarily ours, and attaching to someone else's would write to their config.

Because of that isolation you can run the suite while your normal instance is up on
8000.

## Two ordering facts worth knowing before editing the config

1. **Playwright starts `webServer` before `globalSetup`.** The server throws when
   `WS_SCRCPY_CONFIG` names a missing file, so the seed config is written at
   *config-load* time in `playwright.config.ts`, guarded to the runner process
   (workers re-import that module and would otherwise re-seed mid-run).
2. **Four first-run dialogs must be suppressed, by three different mechanisms.**
   `ServiceFirstRunModal` (gated by `installMode`) and `WelcomeModal` (by
   `firstRunComplete`) are handled by the seed config. `SystemWideInstallModal` is
   **Linux-only** and gated by a marker *file*, `<dataRoot>/control/system-install-declined`,
   so it passes locally on Windows and fails only in CI — it is written at seed time.
   `PortChangeModal` is gated by per-user settings, covered below.
3. **`globalSetup` therefore has a live server to talk to**, which is where the
   bookmark reminder gets switched off. `PortChangeModal` opens on every page load
   for an unacknowledged port — every load, against a virgin data root — and being a
   plain `<dialog>` it stacks over the consent prompt and swallows its clicks.
   Symptom is `subtree intercepts pointer events`, which points nowhere near the
   cause. Dismissing it per-spec raced the async fetch that opens it, so it is
   disabled once via the same `PATCH /api/settings` its own checkbox uses.

## Why it runs serially

`workers: 1` and `fullyParallel: false` are deliberate, not a flake workaround. The
server holds exactly **one** pending embed request at a time (`current` is
module-level state in `security/embedRequests.ts`), and every consent spec also
mutates the single shared config file. Run concurrently, specs would cancel each
other's prompts and race each other's writes.

## Still manual

- **A LAN client is refused.** Verified by hand (all three embed endpoints return
  their loopback refusals from a non-loopback address). Automating it needs a second
  host or a second interface, which CI does not have.
- **Locked mode.** `/embed-request` and `/embed-request/` are allow-listed in
  `AuthGate` so the flow survives `authEnabled`; untested either way.
