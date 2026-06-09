# SP4 — Docker image (design)

**Date:** 2026-06-09
**Status:** Approved (brainstorm) — pending implementation plan
**Scope item:** `todo_ws_scrcpy_web.md` item 2 (SP4). Consumes and refines the 2026-05-28 locked-decision block recorded there.

---

## 1. Goal

Ship a multi-stage, multi-arch Docker image for ws-scrcpy-web so the app can be self-hosted in a container, alongside the existing Windows + Linux (Velopack) install paths. The container connects to Android devices over **wireless ADB only**. This is the next full release after `0.1.30` stable; it must not regress the standalone desktop builds, and the app must stay independently usable (Docker via composition, no codebase merge with Control Menu).

## 2. Scope & non-goals

**In scope**

- A multi-stage `Dockerfile` (`amd64` + `arm64`) on `node:24-bookworm-slim`.
- A release-triggered publish workflow to Docker Hub with channel-aware tags.
- In-app "Docker awareness": the containerized UI hides desktop-only affordances (service install, in-app update, libfuse2) via a single env flag.
- A new manual smoke module for the Docker path (feeds SP5).

**Non-goals (explicit)**

- **USB device access** — wireless ADB only (locked 2026-05-28, decision 3). No `--device`, no usbip, no USB docs.
- **The Rust launcher** — not present in the image (see §4). The container's "launcher" is `tini` + `start.sh`.
- **HTTPS / reverse-proxy configuration** — documented in SP5, not baked into the image.
- **`.deb` / `.rpm` / Snap / Flatpak** — out of scope.
- **Alpine / musl** — excluded; our node-pty prebuilt matrix is glibc-only (ABIs 137/127).

## 3. Decisions

### 3.1 Locked by the user (2026-06-09 brainstorm)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Dependency bootstrap = seed + first-run hydrate.** Bake the existing desktop `seed/` (node + scrcpy-server + node-pty) into the image; `DependencyManager.autoInstallMissing` fills the empty `/data/dependencies` volume (incl. adb) on first boot. | Smallest image; reuses the exact host first-run code path; works with named volumes *and* bind mounts. Cost: first boot needs outbound network (to fetch adb at minimum). |
| D2 | **Registry = Docker Hub** (`bilbospocketses/ws-scrcpy-web`). | Matches the locked UI copy verbatim; cleanest pull UX; most discoverable. Cost: needs `DOCKER_USERNAME` + a PAT secret; anonymous pulls are rate-limited. |
| D3 | **Channel-aware tags.** Every release → immutable `:X.Y.Z[-beta.N]`. Beta release also moves `:beta`; stable release also moves `:latest` + `:stable`. | Mirrors the Velopack beta/stable channels; lets the Docker path be smoked on `:beta` now; `:latest` never surprises users with a beta. |
| D4 | **Single `/data` state volume** (`DATA_ROOT=/data`, `DEPS_PATH=/data/dependencies`). Refines the locked "`/dependencies` only" wording. | One mount; `config.json` + `logs/` + `dependencies/` all persist across `docker rm`/image update; identical to the on-host dataRoot layout. |

### 3.2 Engineering defaults confirmed (2026-06-09)

| # | Decision |
|---|----------|
| E1 | **`tini -g`** as PID 1 (process-group signal mode) — see §5. |
| E2 | **`tini` vendored** as a pinned static binary with SHA256 verification, per-arch — not apt, not `docker run --init`. Local-Dependencies-Only compliance. |
| E3 | **Non-root runtime** — run as the base image's `node` user (uid 1000); a root entrypoint shim fixes `/data` ownership, then steps down to uid 1000. Step-down mechanism is chosen in the plan: prefer one already in the base image (`setpriv`/`runuser` from util-linux) — **to be verified against `node:24-bookworm-slim`**; otherwise vendor a pinned `gosu` (Local-Dependencies-Only). |
| E4 | **Docker-awareness via server env**, not a seeded `config.json` file — the server treats `WS_SCRCPY_DOCKER=1` as implying `firstRunComplete: true` + `installMode: 'user'` in runtime config resolution. |
| E5 | **`HEALTHCHECK`** included, implemented in Node (no vendored `curl`). |

## 4. Image architecture — multi-stage, no Rust

The container runs Node directly via `start.sh`; it **never invokes the Rust launcher**. The launcher exists only for desktop tray / systemd service / Velopack update / install-handoff — none of which apply in a container. Therefore the Docker build needs **no Rust toolchain**, making it much thinner than the AppImage (`package-linux.mjs`) path.

- **Stage `build`** (`node:24-bookworm-slim`): `npm ci` → `npm run build` → `dist/`. Dev dependencies remain in this stage only.
- **Stage `runtime`** (`node:24-bookworm-slim`, published): copies `dist/`, production `node_modules` (`npm ci --omit=dev` or a pruned copy), the baked `seed/`, `start.sh`, and the vendored `tini`. Sets ENV, `EXPOSE 8000`, `HEALTHCHECK`, `USER`, `ENTRYPOINT`.

Base pinned to the explicit release name `node:24-bookworm-slim` (glibc; multi-arch manifest covers `linux/amd64` + `linux/arm64`).

**Cross-arch build note (load-bearing for the plan):** the baked `seed/` carries a native `node-pty` prebuilt and a Node runtime that must match **both** the container's Node ABI (Node 24 → ABI 137) **and** the target arch of each buildx leg. The build stage must stage the arch-correct node + node-pty for each platform, keyed off buildx's `TARGETARCH`. adb is *not* seeded (fetched at first run), so it is arch-resolved at runtime by `DependencyManager` for the running container's platform.

## 5. Process model — `tini -g` → `start.sh` → node

PID 1 = **`tini -g`** → `start.sh` (the locked ENTRYPOINT, retaining its exit-75 / `.restart`-marker restart loop) → `node dist/index.js`.

The `-g` (process-group) flag is **required**: `tini` forwards `SIGTERM` to the whole process group, so it reaches Node *through* the bash restart loop. Without `-g`, bash defers its signal trap until the foreground child exits, so on `docker stop` Node would never run `gracefulShutdown()` (adb kill-server + service release) and would be `SIGKILL`ed after the 10s grace, orphaning adb state. With `-g`, `docker stop` yields a clean teardown.

`start.sh` is reused unchanged: it already probes `dependencies/node/node` → `seed/node/node`, exports `DEPS_PATH`, and loops on exit-75 / marker. (The exit-75 restart path stays meaningful in-container for dep-driven restarts; the Velopack app self-update path is inert because the Updates UI is gated off — §7.)

## 6. Dependency bootstrap (D1)

The image bakes `seed/{node, scrcpy-server, node-pty}` — the same artifacts the desktop build stages via `fetch-node.mjs`, `stage-seed-scrcpy-server.mjs`, `stage-seed-node-pty.mjs`. On first boot with an empty `/data` volume:

1. `start.sh` → `seed/node` (dependencies/node absent on first boot) → `dist/index.js`.
2. `DependencyManager.autoInstallMissing` populates `/data/dependencies` — **adb** (never seeded), plus staging node / scrcpy-server / node-pty into the managed location.
3. Subsequent boots run from `/data/dependencies`.

ADB is wireless-only: `adb connect <ip>:<port>` after the user enables wireless debugging on the device (Android 11+) or runs `adb tcpip 5555` elsewhere.

## 7. State, volume & "already set up" presentation (D4, E4)

```
ENV DATA_ROOT=/data
ENV DEPS_PATH=/data/dependencies
VOLUME /data

/data/
  ├── dependencies/   (node, adb, scrcpy-server, node-pty — runtime-managed)
  ├── logs/
  ├── config.json     (webPort, installMode, theme, settings)
  └── control/        (markers)
```

`DEPS_PATH` env wins in `Config.resolveDependenciesPath` (env → config → fallback), so the strict resolver hits the volume unambiguously. Layout mirrors the on-host dataRoot exactly.

**No Velopack install hook exists in Docker** (on the host, `hooks.rs::on_install` seeds `config.json` and the first-run/installMode state). Default config is `installMode: null, firstRunComplete: false`, which would trigger the desktop `WelcomeModal` and the Linux `SystemWideInstallModal`. To present the container as already-configured **without** a seeded file, the **server treats `WS_SCRCPY_DOCKER=1` as implying `firstRunComplete: true` + `installMode: 'user'`** in its runtime config resolution. `config.json` is then written to `/data` lazily as the user changes settings, and persists. (Single source of truth, in TypeScript, unit-testable — preferred over a shell config-seeding step.)

**Internal port:** the container always serves on **8000** internally (`EXPOSE 8000`); host mapping (`-p <host>:8000`) handles the user-facing port. The `HEALTHCHECK` targets 8000.

## 8. Container-awareness UI gating (locked decision 4)

`ENV WS_SCRCPY_DOCKER=1` → the server exposes `docker: true` on the config-runtime / service-status envelopes (so the frontend gates without a second probe):

- **Settings → Service:** hidden; replaced with informational copy *"service install not applicable — this instance runs in a container."*
- **Settings → Updates:** the "check for updates now" control hidden; replaced with *"update via `docker pull bilbospocketses/ws-scrcpy-web:latest`."* (locked copy, verbatim).
- **libfuse2 banner:** always hidden (Velopack-specific; no Docker relevance).

**Note styling:** the Service + Updates informational copy above adopts the shared **indented bold-italic** Settings-note convention (todo item 47, surfaced in the beta.52 smoke) so it reads as a sub-note, set apart from the settings.

## 9. Local-Dependencies-Only compliance

- adb / node / scrcpy-server resolve **only** from `/data/dependencies`. The old stub `Dockerfile`'s `apt-get install android-tools-adb` is **deleted** — it was a direct violation (system-package adb).
- **`tini` is vendored** (E2): the build `ADD`s the pinned `tini-static-{amd64,arm64}` release binary and **verifies its SHA256**, per arch. No reliance on the distro package or on `docker run --init` (which would assume a host-provided tini).
- No binary is resolved via host PATH, env-var lookup, or assumed-present on the CI runner. Everything the app spawns lives under the image or the `/data` volume.

## 10. Multi-arch build & publish workflow

- **Separate workflow** `.github/workflows/docker-publish.yml`, triggered on **`release: published`** — reuses the release tag, decoupled from `release.yml`'s Velopack legs. Actions are **SHA-pinned** (repo convention).
- `docker buildx build --platform linux/amd64,linux/arm64` (locked decision 2; matches the node-pty glibc ABI coverage).
- **Channel-aware tag computation** from the release tag, reusing the same rule as `package-linux.mjs:119` (`version.includes('-beta')`):
  - beta → `:X.Y.Z-beta.N` **and** `:beta`
  - stable → `:X.Y.Z` **and** `:stable` **and** `:latest`
- Push to `bilbospocketses/ws-scrcpy-web`. Secrets: `DOCKER_USERNAME` + `DOCKER_PAT`.
- The pre-existing disabled `docker-publish.yml.disabled` (placeholder: `my-image-name:latest`, push-on-every-main-push) is **replaced/removed**.

## 11. Networking (mostly → SP5 docs)

The image is network-agnostic. Wireless ADB from a container requires the container to reach the device's LAN; default bridge networking frequently cannot, so **SP5 documents `--network host`** (or an explicit route/macvlan) as the reachable path. No image-level network default is forced.

## 12. Error handling & edge cases

- **No network on first boot:** `seed/node` boots the app, but the dep hydrate (adb fetch) fails → the existing dep-manager error surface reports it; retriable once connectivity is restored. Documented as a first-boot prerequisite.
- **`docker stop`:** §5 `tini -g` → Node runs `gracefulShutdown()` before exit.
- **Empty vs populated volume:** hydrate is idempotent (`autoInstallMissing` fills only what's missing) — safe on every boot.
- **Volume ownership:** fresh named volumes mount root-owned; the root entrypoint shim `chown`s `/data` then steps down to uid 1000 (mechanism per E3).
- **`HEALTHCHECK`:** a Node one-liner requests `http://127.0.0.1:8000/` (or `/api/config`) and exits non-zero on failure, so `docker ps` / orchestrators see real health (no vendored `curl`).

## 13. Testing strategy

- **TypeScript unit:** the new `WS_SCRCPY_DOCKER` server defaults (`firstRunComplete`/`installMode`/`docker` flag on the config-runtime + service-status envelopes); the frontend gating (Service section hidden, Updates copy swap, libfuse2 hidden).
- **CI build smoke:** `buildx` both arches on PR (no push); push only on `release: published`.
- **Manual smoke (new `docs/smoke-tests/` module):** pull `:beta`; run with a `/data` volume; verify first-boot hydrate (adb fetched); wireless-connect a device; **persistence across `docker rm` + re-run** (config + logs survive); graceful `docker stop`; `HEALTHCHECK` reports healthy. Feeds SP5.

## 14. Exit criteria

1. `docker buildx` produces a working `linux/amd64` + `linux/arm64` image from a single `Dockerfile`.
2. A fresh `docker run -v wsdata:/data -p 8000:8000 …` boots from seed, hydrates `/data/dependencies` (incl. adb), and serves the UI on 8000 with **no** WelcomeModal / service-install / libfuse2 affordances.
3. A wireless `adb connect` device streams.
4. `docker stop` shuts down gracefully (adb released); `docker rm` + re-run preserves `config.json` + `logs/`.
5. `release: published` builds + pushes channel-aware tags to Docker Hub; `:beta` resolves to the beta, `:latest` only to stable.
6. No binary resolved outside the image / `/data` volume (Local-Dependencies-Only).
7. Desktop Velopack builds unaffected; app remains standalone.

## 15. References (verified against `main` @ `e600182`)

- `start.sh` — the reused ENTRYPOINT (probe chain + exit-75/marker loop).
- `Dockerfile` (current) — the pre-SP2 stub to discard (`node:18-slim`, apt adb, no start.sh/tini/DEPS_PATH).
- `.github/workflows/docker-publish.yml.disabled` — placeholder to replace.
- `scripts/package-linux.mjs` — Velopack AppImage path (the channel rule at line 119; *not* reused by Docker).
- `scripts/{fetch-node,stage-seed-scrcpy-server,stage-seed-node-pty,stage-publish}.mjs` — seed assembly.
- `src/server/Config.ts` — `resolveDependenciesPath` (env→config→fallback), `resolveDataRoot`, dataRoot/config/marker paths.
- `src/server/DependencyManager.ts` — `autoInstallMissing`.
- `src/common/ConfigEvents.ts` — `InstallMode = 'user' | 'user-service' | 'system' | 'system-service'`; `AppConfig` (`installMode`, `firstRunComplete`); `APP_CONFIG_DEFAULTS`; the `{config, runtime}` envelope.
- `src/app/index.ts` — `maybeShowWelcomeModal` gates on `!config.firstRunComplete`.
- `src/app/client/SettingsModal.ts` — Service / Updates / libfuse2 render sites to gate.

---

*Next: `writing-plans` → implementation plan. No image code is written until the plan is approved.*
