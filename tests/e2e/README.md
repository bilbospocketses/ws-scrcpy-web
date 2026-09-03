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

## The auth spec is a state machine, and it runs first

`auth.spec.ts` covers smoke module 18 (the opt-in login) as twelve rows in one
serial group. 18.2 secures the admin account and turns login on, every row until
18.11 runs against a locked server, and 18.11 returns it to open mode. Four facts
follow from that, and the config relies on all of them:

1. **The database is wiped before `webServer` starts.** `wipeE2EDatabase()` runs
   in the same runner-only block that seeds `config.json`. Securing the admin
   account renames user 1 and gives it a password hash, and nothing in the API
   ever takes that back — so a database carried over from an earlier run makes
   the next run's "secure the admin account" take the normal-create branch and
   never enable login, and a run that died while locked makes `globalSetup`'s
   `PATCH /api/settings` fail with 401 before a single spec runs. The wipe is
   skipped under `QA_EXTERNAL_STACK` (that data root is not ours).
2. **`retries: 0` on that group.** A serial-group retry would re-run 18.1 against
   a database 18.2 already locked down, which can never pass.
3. **Its `afterAll` returns to open mode even when a row failed.** The file sorts
   before every other spec, and a locked server answers every later
   `page.goto('/')` with the login page at HTTP 200 — so those files would fail
   on missing buttons that point nowhere near auth. The one thing it cannot
   recover from is the only admin being locked out (see the next point); the
   next run is clean because of the wipe.
4. **Never send a wrong admin password, never retry a login.** The lockout is per
   user row: five failures in five minutes lock it for fifteen, every attempt
   while locked re-arms the lock, and unlocking needs the admin session you no
   longer have. `loginAs` sends exactly one request; the wrong-password rows
   target the regular user only.

Row 18.12 (sessions survive a restart) never touches the shared server: the fast
tier's `webServer` is a bare `node dist/index.js` with no supervisor, and
`POST /api/dependencies/restart` exits the process with code 75 for good. The row
spawns its own server on port 8124 with its own data root under the OS temp
directory (`support/privateServer.ts`), restarts it the product's way, and
removes the root afterwards.

## Rows that need a host the tier cannot be

The same pattern carries the server-surface, lifecycle and dependencies rows
(smoke §10, §12, §9.4): anything that stops or restarts a server, reads a
boot-time-only config key (`allowedHosts`), reads the server's own log file, or
needs locked mode without touching the shared server's auth state runs on a
spec-owned server from `support/privateServer.ts`, on ports 8126–8131, each with
its own data root that is wiped and re-seeded per run. The log those rows read
is `<dataRoot>/logs/ws-scrcpy-web.log`: the console echo is TTY-only, so a
spawned child's captured stdout never carries it.

Two `@docker` rows need a container the main stack cannot be, and bring up
their own compose stacks from `tests/docker/` beside it (`support/dockerStack.ts`):

| Row | Stack | Why its own |
|---|---|---|
| 1.9 first-run bootstrap banner | `compose.offline.yml`, port 8124 | boots with **no working resolver** (`dns: 127.0.0.1`) so every download fails at once; the spec then writes a real resolver into `/etc/resolv.conf` (root `docker exec`) and clicks Retry. Not `network_mode: none` — such a container can never be connected afterwards — and not an `internal` network, which also disables port publishing so the host could not reach it at all. |
| 9.5 shell unavailable shows a reason | `compose.no-node-pty.yml`, port 8125 | built from `tests/docker/Dockerfile.no-node-pty`, one `rm` of the node-pty prebuilt layered on the already-built image tag. Not a stage in the main Dockerfile: a trailing stage there would become the default build target and every plain `docker build` would ship it. |

Both resolve `docker` from the shell, as `playwright.docker.config.ts`'s
`docker compose up --wait` already does: the daemon is the tier's execution
environment, not an app dependency.

## Still manual

- **A LAN client is refused.** Verified by hand (all three embed endpoints return
  their loopback refusals from a non-loopback address). Automating it needs a second
  host or a second interface, which CI does not have.
- **The embed flow in locked mode.** `/embed-request` and `/embed-request/` are
  allow-listed in `AuthGate` so the consent flow survives `authEnabled`; the auth
  spec proves the gate itself, not the consent flow under it.
