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

**`@docker-host`.** Two of those rows — 1.9's offline stack and 9.5's no-node-pty image —
drive a compose stack of their own through the docker CLI. They run in this repo's CI,
where the daemon is the tier's execution environment, and carry `@docker-host` beside
`@docker`. When qa-harness owns the stack (`QA_EXTERNAL_STACK=1`, inside its runner, which
has no docker CLI by design) the container config filters that tag out. A partition by tag,
the same mechanism that keeps `@docker` out of the fast tier — not a skip. Before this, every
harness run reported the two as `spawnSync docker ENOENT`, a failure naming nothing near its
cause.


Two `@docker` rows need a container the main stack cannot be, and bring up
their own compose stacks from `tests/docker/` beside it (`support/dockerStack.ts`):

| Row | Stack | Why its own |
|---|---|---|
| 1.9 first-run bootstrap banner | `compose.offline.yml`, port 8124 | boots with **no working resolver** (`dns: 127.0.0.1`) so every download fails at once; the spec then writes a real resolver into `/etc/resolv.conf` (root `docker exec`) and clicks Retry. Not `network_mode: none` — such a container can never be connected afterwards — and not an `internal` network, which also disables port publishing so the host could not reach it at all. |
| 9.5 shell unavailable shows a reason | `compose.no-node-pty.yml`, port 8125 | built from `tests/docker/Dockerfile.no-node-pty`, one `rm` of the node-pty prebuilt layered on the already-built image tag. Not a stage in the main Dockerfile: a trailing stage there would become the default build target and every plain `docker build` would ship it. |

Both resolve `docker` from the shell, as `playwright.docker.config.ts`'s
`docker compose up --wait` already does: the daemon is the tier's execution
environment, not an app dependency.

## The suite as an artefact: the bundle and the manifest

qa-harness does not check this repo out. It mounts `wssw-suite-<version>.tar.gz` — attached to
every release next to the installers — into a Linux runner and runs the suite against the
*published image*. `scripts/build-suite-bundle.mjs` builds it from `tests/`, both Playwright
configs, `qa-manifest.json`, `tsconfig.json`, `package.json` and `package-lock.json`, and
nothing else: no `src/`, no `dist/`, no `node_modules/`. `tsconfig.json` is there because
`tests/e2e/tsconfig.json` extends it; the runner never builds the app.

`qa-manifest.json` is what the runner reads. `runner.playwrightVersion` must equal the version
the runner image was built with, or it refuses to start (a skew otherwise surfaces later as
"browser was downloaded by a different version of Playwright", which names the browser and
not the skew). The bundle script checks that field against `package-lock.json`, and
`scripts/build-suite-bundle.test.mjs` fails on the same drift, so bumping `@playwright/test`
names the manifest line to change. `suites` declares the three tiers with their `npm run`
commands; `suiteMap` is what today's runner actually consults — a spec path it hands to
`playwright test` — and it lists only `fast`, because the runner cannot select a config and a
`docker` or `device` entry would run the fast config's filter and report the wrong specs as
passed. Running the other two tiers from the bundle is the harness's run-lifecycle work
(P3 task 14), which executes each suite's `command` from the bundle root.

Locally: `node scripts/build-suite-bundle.mjs --out Releases --verify` builds the archive,
prints its sha256, extracts it into `.suite-check/` and typechecks the suite from inside the
copy — the same round-trip CI runs on every PR.

## The device tier

`tests/e2e/device/*.spec.ts`, tagged `@device`, run only inside qa-harness's Linux runner:
the subject container, P2's Android emulator on the run network, and a runner that refuses to
start Playwright unless its own adb sees the emulator in `device` state. `npm run test:e2e:device`
is what the bundle's manifest names, and the runner executes it from the bundle root with
`PLAYWRIGHT_BASE_URL` set to the subject on **loopback** (the runner shares the subject's network
namespace — WebCodecs is exposed only in a secure context, and `http://<ip>:8000` is not one; on
that origin the app registers no player at all, register finding 8.10).

`support/device.ts` is the shared ground: `deviceAddress()` (the emulator's adb address from
`QA_DEVICE_ADDRESS`, failing loudly when unset — a device spec **never skips**), `qaAdb()` (the
runner's vendored adb by the absolute path it bakes in `QA_ADB`, the out-of-band witness that
locks the screen, reads the process table and counts shells; never the app's own adb, which is
the thing under test), connect/disconnect through the app's routes, the device row locator,
a decoded-frame counter installed before navigation, a canvas signature, and
`expectFramesArriving()` — which stimulates the screen, because scrcpy encodes only on surface
updates, and asserts a *picture*, never a connection.

Every row is judged on the device: the shell modal by the device's process table, the file modal
by `ls` and `cat` on the device, sleep/wake by the app's own screen-state route, the stream by
frames decoded and a canvas that changes. Each spec leaves the device connected, awake and
unlocked and the server in open mode, including on failure: the four files share one emulator and
run serially in alphabetical order.

What the tier cannot do, and says so: H.265 is undecodable by every browser in the Linux runner
(the HEVC halves of 8.5 and 8.7 are residual here, coverable on a Windows host with Chrome);
headless chromium cannot prove that audio plays; and rows 1.9 and 9.5 (`@docker-host`) need the
docker CLI the runner lacks by design, so they run in this repo's CI only.

## Still manual

- **A LAN client is refused.** Verified by hand (all three embed endpoints return
  their loopback refusals from a non-loopback address). Automating it needs a second
  host or a second interface, which CI does not have.
- **The embed flow in locked mode.** `/embed-request` and `/embed-request/` are
  allow-listed in `AuthGate` so the consent flow survives `authEnabled`; the auth
  spec proves the gate itself, not the consent flow under it.
