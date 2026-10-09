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
| `LOCALAPPDATA` | Windows only: moves the TLS home into the throwaway root |
| `WS_SCRCPY_NO_BROWSER=1` | Stops a first-run boot opening the host's browser |

**`WS_SCRCPY_NO_BROWSER` keeps tabs off the developer's desktop.** A server started
without the launcher that boots with `firstRunComplete: false` opens the host's
default browser on itself (`shouldAutoOpenBrowser`, `src/server/index.ts`), and the
first-run rows boot exactly that way: each run put real tabs on the desktop. The
shared server and every `spawnServer` child set the product's own relaunch
suppression. Row 1.14, whose subject is the open attempt, removes it through
`spawnServer`'s `env` (`WS_SCRCPY_NO_BROWSER: undefined`), with `xdg-open` hidden so
nothing can actually open.

Isolating only the config file is not enough — per-user settings live in
`<dataRoot>/wsscrcpy.db`, so the suite would otherwise read and write a developer's
real database. And `reuseExistingServer` is off: a server already on this port is not
necessarily ours, and attaching to someone else's would write to their config.

**`LOCALAPPDATA` is there because the Windows TLS home is not under the data root.**
It is `%LOCALAPPDATA%\WsScrcpyWeb-tls` (`src/server/tls/certPaths.ts`), so on a
machine where Local HTTPS has been set up an inherited `LOCALAPPDATA` hands the
suite's server the developer's real certificate, and it binds a real HTTPS listener
beside 8123; a private server told to generate would replace their real CA. The
shared server (`playwright.config.ts`) and every spec-owned one (`spawnServer`) get a
`LocalAppData` folder of their own **beside** the data root, not inside it:
`resolveCertPaths` refuses a CA root under the data root, and that refusal switches
Local HTTPS off for the boot. Linux keeps the TLS home under the data root and never
reads the variable.

Because of that isolation you can run the suite while your normal instance is up on
8000.

**`WSSW_E2E_PORT` moves the shared server, for two runs on one machine.** Set, it
replaces 8123 *and* gives the shared server a data root of its own
(`ws-scrcpy-web-e2e-<port>` under the OS temp directory, `support/paths.ts`), so two
runs neither bind the same port nor wipe each other's database. Unset, nothing
changes. Two runs from one checkout also need an `--output` folder each, because
Playwright empties its output folder as a run starts and would delete the other
run's traces:

```bash
WSSW_E2E_PORT=8223 npx playwright test --output ../wssw-results-b settings-dialog.spec.ts
```

It moves only the shared server. The spec-owned servers keep the fixed ports listed
below, so two parallel runs must never run the same spec file.

## Two ordering facts worth knowing before editing the config

1. **Playwright starts `webServer` before `globalSetup`.** The server throws when
   `WS_SCRCPY_CONFIG` names a missing file, so the seed config is written at
   *config-load* time in `playwright.config.ts`, guarded to the runner process
   (workers re-import that module and would otherwise re-seed mid-run).
2. **Three first-run prompts must be suppressed, by three different mechanisms.**
   `WelcomeModal` (gated by `firstRunComplete`) is handled by the seed config.
   `SystemWideInstallModal` is **Linux-only** and gated by a marker *file*,
   `<dataRoot>/control/system-install-declined`, so it passes locally on Windows and
   fails only in CI — it is written at seed time. The bookmark reminder card
   (`BookmarkReminder`, in both its port and its service wording) is gated by
   per-user settings, covered below.
3. **`globalSetup` therefore has a live server to talk to**, which is where the
   bookmark reminder gets switched off. The card opens on every page load for an
   unacknowledged port — every load, against a virgin data root. Since item 113 it
   is a non-modal card that captures no clicks (its `<dialog>` predecessor stacked
   over the consent prompt and swallowed its clicks — `subtree intercepts pointer
   events`, which points nowhere near the cause), but it would still sit on every
   page and rows 13.1 / 13.2 must establish the flag themselves, so it is disabled
   once via the same `PATCH /api/settings` its own buttons use.

## Why it runs serially

`workers: 1` and `fullyParallel: false` are deliberate, not a flake workaround. The
server holds exactly **one** pending embed request at a time (`current` is
module-level state in `src/server/security/embedRequests.ts`), and every consent spec also
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
spec-owned server from `support/privateServer.ts`, on ports 8126–8131,
8133–8139 (12.6's port blockers) and 8142 (12.10's double signal, Linux only), each with its own data root that is wiped and
re-seeded per run. The log those rows read is `<dataRoot>/logs/ws-scrcpy-web.log`
(`support/serverLog.ts`): the console echo is TTY-only, so a spawned child's
captured stdout never carries it.

`spawnServer` is the one way to start such a server, so every one of them gets the
same isolation block as the shared server. Its options cover what the rows vary:
`env` adds variables, and a key set to `undefined` is *removed* from the child's
environment (a runner that exports `WS_SCRCPY_ALLOW_REMOTE_ADMIN` would otherwise make
every "local" assertion lie); `portOverride: false` drops `WS_SCRCPY_WEB_PORT`,
because that override is exact and never walks forward, so a row about a busy port
being auto-shifted cannot have it. Rows whose subject is an environment variable wrap
their `env` in `withoutInheritedOverrides()`, which clears the port, scan, service and
feed variables a developer's shell might carry.

A port "held by another program" is `holdPort` (`support/ports.ts`), a wildcard bind
like the app's own. It accepts and drops every connection: a walking server probes the
busy port to ask whether a sibling instance holds it, and a blocker with no connection
handler turns the probe's reset into an uncaught `read ECONNRESET` in the test
process.

The item-164 specs added these spec-owned servers. Each file keeps to its own range
so a leftover server or data root names the file it came from:

| Spec | Ports | Data roots | Helpers |
|---|---|---|---|
| `server-api.spec.ts` | 8151–8157 | `ws-scrcpy-web-e2e-164a-*` | `rawHttp`, `serverLog`, `ports` |
| `config-overrides.spec.ts` | 8158–8159 | `ws-scrcpy-web-e2e-164a-*` | `rawHttp`, `serverLog`, `ports`, `tlsFixtures` |
| `auth-admin.spec.ts` | 8161–8169, 8196 | `ws-scrcpy-web-e2e-164b-*` | `ownedServer` (`OwnedServer`), `sessions`, `rawHttp` (`lanAddress`) |
| `settings-dialog.spec.ts` | 8171–8175 | `ws-scrcpy-web-e2e-164c-*` | `ownedServer`, `settingsUi`, `pendingSettings` |
| `first-run-and-reminders.spec.ts` | 8176–8179 | `ws-scrcpy-web-e2e-164c-*` | `ownedServer`, `settingsUi`, `ports` |
| `embed-trust.spec.ts` | 8181, 8184 (its adb daemon), 8188–8189 (embedding pages) | `ws-scrcpy-web-e2e-164d-*` | `lockedServer`, `rawHttp` (`serveHtml`) |
| `devices-ui.spec.ts` | 8182, 8183 (its adb daemon), 8187 (never bound) | `ws-scrcpy-web-e2e-164d-*` | `lockedServer`, `fetchCounter` |
| `local-https-fast.spec.ts` | 8191–8195 | `ws-scrcpy-web-e2e-164e-*` | `tlsFixtures`, `tlsPanel` |
| `mkcert-provenance.spec.ts` | 8197, 8198 (its fixture release server) | `ws-scrcpy-web-e2e-164b-21-12` | `ownedServer` |
| `dependencies-restart.spec.ts` | 8145, 8146 (its fixture nodejs.org) | `ws-scrcpy-web-e2e-deps-restart` | `privateServer`, `serverLog` |

8140 is `container-user.spec.ts`'s, 8142 is `lifecycle.spec.ts`'s (12.10), and 8141, 8143–8144, 8147–8150, 8160, 8170, 8180, 8190 and
8199 are free (8150, 8160, 8170, 8180 and 8190 are the shared-server ports the
item 164 batches used through `WSSW_E2E_PORT` while writing these specs in parallel;
nothing binds them in a normal run). `lockedServer` can give a server an **adb daemon of its own**
(`ANDROID_ADB_SERVER_PORT`, mDNS off): a developer's daemon on 5037 auto-connects
every paired device advertising on the LAN, so "no device connected" is only true
on a daemon the spec owns. In locked mode `/api/dependencies` needs a signed-in
admin, so those rows pass the admin's request context to `waitForDependencies`
instead of a base URL.

**Teardown stops what runs from the root first (item 170).** On Windows the harness
stops a spec-owned server with `child.kill()`, which is TerminateProcess, so the
server's own shutdown (`adb kill-server`) never runs. Every server pre-warms an adb
daemon at boot, started detached from `<root>/WsScrcpyWeb/dependencies/adb`, and that
daemon survives the kill and holds `adb.exe` open; removing the root then failed
EPERM in teardown and again at the next run's seed. So `removePrivateRoot` and
`seedPrivateDataRoot` first stop every process whose executable lives inside the root
(`stopProcessesUnder`, `support/rootProcesses.ts`), then remove it with a bounded
retry of their own (`removeTree`; `rmSync`'s `maxRetries` does not retry EPERM on
Node 24). The stop is scoped by executable path, so a developer's own adb on 5037,
which runs from its own install, is never touched; nor is the shared server's
daemon, which lives under its own root.

**`@docker-host`.** Eight rows — 1.9's offline stack, 9.5's no-node-pty image, the three
container-lifecycle rows (20.6, 20.11, 20.12), the published-image row (20.8), the
`--user` row (20.21) and the certificate-on-the-volume row (20.22, which recreates the
lifecycle stack) — drive the docker CLI on the host: a compose stack of their own, a
`docker stop`, a `docker pull`, a `docker run` of their own. They run in this repo's CI, where the daemon is the tier's execution
environment, and carry `@docker-host` beside `@docker`. When qa-harness owns the stack
(`QA_EXTERNAL_STACK=1`, inside its runner, which has no docker CLI by design) the container
config filters that tag out. A partition by tag, the same mechanism that keeps `@docker` out
of the fast tier — not a skip. Before this, every harness run reported the first two as
`spawnSync docker ENOENT`, a failure naming nothing near its cause.


Three `@docker` stacks exist beside the main one, from `tests/docker/`
(`support/dockerStack.ts`):

| Row(s) | Stack | Why its own |
|---|---|---|
| 1.9 first-run bootstrap banner | `compose.offline.yml`, port 8124 | boots with **no working resolver** (`dns: 127.0.0.1`) so every download fails at once; the spec then writes a real resolver into `/etc/resolv.conf` (root `docker exec`) and clicks Retry. Not `network_mode: none` — such a container can never be connected afterwards — and not an `internal` network, which also disables port publishing so the host could not reach it at all. |
| 9.5 shell unavailable shows a reason | `compose.no-node-pty.yml`, port 8125 | built from `tests/docker/Dockerfile.no-node-pty`, one `rm` of the node-pty prebuilt layered on the already-built image tag. Not a stage in the main Dockerfile: a trailing stage there would become the default build target and every plain `docker build` would ship it. |
| 20.6, 20.11, 20.12 container lifecycle; 20.22 (`container-https.spec.ts`) | `compose.lifecycle.yml`, port 8132 | the same image on its own volume, with **no restart policy**, so the specs can stop it, `rm` it and bring it back on the same volume — and assert that a clean exit *stays* exited. The main stack cannot be stopped under the other `@docker` specs. The server log is read off the volume with a throwaway `--entrypoint cat` run of the app image (`readVolumeFile`), because the console echo is TTY-only and `docker logs` never carries the server log. It does carry the entrypoint's own stderr, which is what 20.21 reads (below). |

Row 20.8 (`container-publish.spec.ts`) brings up nothing: it reads Docker Hub's tags
API, pulls `:beta`, and compares digests.

Row 20.21 (`container-user.spec.ts`) is not a compose stack either. Each test runs the
app image (`appImage()`) with `docker run --user 1234:1234` through `dockerCli`, on port
8140 and a volume of its own, and removes both in its `finally`: a per-run `--user` is
not something a compose file can vary. It reads the entrypoint's refusal with
`dockerLogs`, which returns stdout AND stderr. `docker logs` replays the container's
stderr on its own stderr, so a stdout-only read comes back empty for an entrypoint's
`>&2`.

Both resolve `docker` from the shell, as `playwright.docker.config.ts`'s
`docker compose up --wait` already does: the daemon is the tier's execution
environment, not an app dependency.

## A known product bug is `test.fail`, never a weakened assertion

When a row finds that the product is wrong, the row keeps asserting what the smoke
test says should happen and is marked expected-to-fail:

```ts
// PRODUCT FINDING (item 164, batch A, 2026-10-05): this answers 500 … Marked
// expected-to-fail so the suite stays green and flips red the day it is fixed.
test.fail(true, 'finding 7.8 regressed or never held against real adb: the route answers 500');
```

The comment above the line says it is a product finding and not a test defect,
names the finding (the smoke row, or the register finding's id), and traces the
cause to the file and line that produce it. The `test.fail` description names the
finding again, so the list reporter's output carries it. Playwright reports such a
row as passing while it fails; the day the bug is fixed it fails with "expected to
fail, but passed", which is the cue to delete the line, never to loosen the row. No
row carries one today.

## The suite as an artifact: the bundle and the manifest

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
