# syntax=docker/dockerfile:1.19
#
# ws-scrcpy-web — container image (SP4).
#
# Two stages on ONE pinned base, by digest rather than by tag: a tag moves, and
# a base that moves under a digest-pinned qa-harness run makes a failure
# ambiguous between an app regression and a base change.
#
# node:24-trixie-slim @ 50c3b2f6… carries NODE_VERSION=24.20.0. The repo pins
# 24.19.0. Both are Node 24 -> NODE_MODULE_VERSION 137, which is the constraint
# that binds: the node-pty prebuilt matrix is keyed on ABI, not patch version.
#
# TRIXIE, not bookworm, and this is a correction to SP4 locked decision 1 rather
# than a preference. Measured 2026-09-03: bookworm-slim is Debian 12 with glibc
# 2.36, and `velopack`'s native addon requires GLIBC_2.39 —
#
#   Error: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found
#   (required by /app/node_modules/velopack/lib/native/velopack_nodeffi_linux_x64_gnu.node)
#
# `src/server/index.ts:1` imports VelopackApp unconditionally, so this is not
# avoidable at runtime: the image BUILDS, starts, and the app exits 1 instantly.
# Trixie is Debian 13 with glibc 2.41.
#
# The decision's actual arguments are all preserved: an explicit Debian release
# name rather than the rolling `24-slim` tag, and glibc rather than musl (the
# node-pty prebuilt matrix is glibc-only, which is why Alpine was excluded).
# Only the codename moves, because bookworm was Debian stable when the design
# was written and trixie is stable now. Ruled by the user 2026-09-03; recorded
# in the design amendment §16.5.
ARG NODE_IMAGE=node:24-trixie-slim@sha256:50c3b2f6988dfc307b86e5301d69611af31f4789bdf232863b07d3b02fe55ae0

# ---------------------------------------------------------------- build ------
FROM ${NODE_IMAGE} AS build
WORKDIR /src

# Lockfile first so a source-only edit does not re-resolve the tree.
COPY package.json package-lock.json ./
# --ignore-scripts: node-pty's install script would try to COMPILE. The repo's
# own prebuilt fetcher runs explicitly below instead, which is both faster and
# the path the desktop builds use.
RUN npm ci --ignore-scripts

COPY . .

# Every native artifact is resolved HERE, inside the per-platform leg, so
# process.arch and detectLibc() report the target. fetch-prebuilts.mjs picks the
# glibc prebuilt for this arch and ABI from the repo's own releases; the
# stage-seed scripts mirror the packaged layout NodePtyResolver expects.
#
# fetch-node.mjs is deliberately NOT run: it hardcodes linux-x64 with a single
# pinned sha256 and has no process.arch branch, so on an arm64 leg it would
# stage an x86-64 ELF at seed/node/node — which start.sh's `[ -x ]` probe would
# happily select, producing "exec format error" at container start. The runtime
# stage symlinks the image's own node instead (design amendment 16.2).
#
# No `npm prune --omit=dev` at the end: the runtime stage installs its own
# production tree from the lockfile (below), so nothing from this stage's
# node_modules is copied. The prune used to be here and did not work — the
# published beta.91 image carried the whole dev tree (Playwright, vitest,
# webpack, TypeScript 7's native compiler, swc, biome: 372 MB), which is how a
# Go-stdlib CVE inside `@typescript/typescript-linux-x64/lib/tsc` reached the
# Docker Scout gate.
RUN node scripts/fetch-prebuilts.mjs \
 && node scripts/stage-seed-node-pty.mjs \
 && node scripts/stage-seed-scrcpy-server.mjs \
 && npm run build \
 && node scripts/fetch-tini.mjs /out/tini

# -------------------------------------------------------------- runtime ------
FROM ${NODE_IMAGE} AS runtime

# setpriv is the step-down mechanism (SP4 E3, which left it "to be verified
# against node:24-bookworm-slim"). Asserted at BUILD time on purpose: if the
# base ever drops util-linux, this build fails here rather than the entrypoint
# silently continuing as root — which would present as "it works", the worst
# available outcome for a privilege step-down.
RUN test -x /usr/bin/setpriv || (echo 'setpriv missing from base image; vendor gosu per SP4 E3' >&2; exit 1)

WORKDIR /app
COPY --from=build /out/tini            /usr/local/bin/tini
COPY --from=build /src/package.json /src/package-lock.json ./

# The production tree is installed HERE, from the lockfile, rather than copied
# from the build stage: `npm ci --omit=dev` cannot carry a devDependency or one
# of its optional platform packages, where a prune of the build tree provably
# did (see the build stage). --ignore-scripts for the same reason as above —
# node-pty's install script would compile; the runtime never loads node-pty from
# this tree anyway, NodePtyResolver copies it from seed/node-pty-pkg.
#
# Then the base image's package managers go. The app runs `node dist/index.js`
# and nothing in start.sh, entrypoint.sh or src/ ever invokes npm, npx, corepack
# or yarn — and the bundled npm is where Scout found tar, brace-expansion and
# ip-address with fixable high CVEs that no base rebuild had cleared. One RUN,
# so the tree and the removals land in one layer and the npm cache never ships.
RUN npm ci --omit=dev --ignore-scripts \
 && rm -rf /root/.npm \
           /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && test ! -e /app/node_modules/@typescript \
 && test ! -e /app/node_modules/@playwright \
 && test ! -e /usr/local/lib/node_modules/npm

COPY --from=build /src/dist            ./dist
COPY --from=build /src/seed            ./seed
COPY start.sh                          ./start.sh
COPY docker/entrypoint.sh              /usr/local/bin/entrypoint.sh

# start.sh probes dependencies/node/node then seed/node/node. Point the seed at
# the image's own interpreter: an absolute in-image path, target-arch and
# ABI-correct by construction, and no ~50 MB download per leg. This is the
# execution environment, not an app dependency; adb, scrcpy-server and node-pty
# remain strictly local.
#
# The dependencies SYMLINK is belt-and-braces now, and worth keeping. start.sh
# used to `export DEPS_PATH="$SCRIPT_DIR/dependencies"` unconditionally, which
# OVERRODE the ENV below: without this link the hydrate wrote adb and
# scrcpy-server into /app/dependencies, inside the image layer, and every
# `docker rm` silently threw them away and re-downloaded ~9 MB on the next boot.
# That override is also what put the server log at /app/logs and made the
# container unloggable. start.sh honours an inherited DEPS_PATH now, so the ENV
# below is authoritative — the link remains so that anything still reaching for
# /app/dependencies by path lands on the volume anyway.
RUN mkdir -p /app/seed/node /data/dependencies \
 && ln -sf /usr/local/bin/node /app/seed/node/node \
 && ln -sfn /data/dependencies /app/dependencies \
 && chmod +x /app/start.sh /usr/local/bin/entrypoint.sh

# DATA_ROOT is the one root: config.json, the SQLite store, the dependencies
# tree, the server log and the restart marker all derive from it. DEPS_PATH
# names the same directory the symlink above points at, so the two can never
# disagree about where dependencies live.
ENV DATA_ROOT=/data \
    DEPS_PATH=/data/dependencies \
    WS_SCRCPY_DOCKER=1 \
    WS_SCRCPY_WEB_PORT=8000 \
    NODE_ENV=production
VOLUME /data
EXPOSE 8000

# 8000 internally, always; the host maps it. The probe targets GET /api/config,
# which src/server/security/instanceToken.ts exempts from the per-instance
# token — so it answers 200 without a cookie. A probe against `/` would follow
# the auth gate once module 18 is enabled and start reporting unhealthy on a
# perfectly healthy server.
#
# start-period is 180s, not the default 0: FIRST boot hydrates /data by
# downloading adb (~9 MB) before it listens. A shorter window marks the
# container unhealthy during a successful first run.
HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8000/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# tini -g, not tini. The -g flag forwards SIGTERM to the whole process GROUP, so
# it reaches node THROUGH start.sh's bash restart loop. Without it bash defers
# its trap until the foreground child exits, node never runs gracefulShutdown()
# (adb kill-server + service release), and `docker stop` SIGKILLs it after the
# grace period leaving adb state orphaned. Smoke row 12.1 is the assertion.
ENTRYPOINT ["/usr/local/bin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["/app/start.sh"]
