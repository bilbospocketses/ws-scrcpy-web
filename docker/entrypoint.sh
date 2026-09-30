#!/bin/sh
# Root shim: fix /data ownership, then step down to uid 1000 and exec the app.
#
# Runs as root ONLY long enough to chown. A fresh named volume mounts
# root-owned, and a bind mount arrives with whatever the host has, so the app
# cannot create <dataRoot>/config.json or the SQLite store without this.
set -e

APP_UID=1000
APP_GID=1000

if [ "$(id -u)" = '0' ]; then
    # /data/dependencies specifically, not just /data: /app/dependencies is a
    # symlink to it (see the Dockerfile), and start.sh's probe follows that link
    # before anything has created the target.
    # /data/home is the app's HOME (below). It has to exist before the chown so
    # a fresh volume hands it over with everything else. /data/logs is where the
    # server log lands now that it follows DATA_ROOT rather than DEPS_PATH;
    # creating it here means the first boot writes into a directory the app
    # already owns, instead of relying on the logger's own mkdir.
    mkdir -p /data/dependencies /data/home /data/logs
    # Only when it is actually wrong. `chown -R` on a populated /data with a
    # large dependencies tree costs real seconds on every boot for nothing.
    if [ "$(stat -c '%u' /data)" != "$APP_UID" ]; then
        echo "[entrypoint] taking ownership of /data for uid $APP_UID"
        chown -R "$APP_UID:$APP_GID" /data
    fi
    # Unconditionally, and not covered by the block above: a volume that
    # predates /data/home is already owned by the app user, so the recursive
    # chown is skipped and the directory just created above stays root's —
    # and adb aborts on it exactly as it did on /root. One directory, no cost.
    chown "$APP_UID:$APP_GID" /data/home
    # setpriv keeps this shell's environment, and this shell's HOME is /root.
    # adb creates $HOME/.android on EVERY invocation — `adb --version`
    # included — and aborts with a core dump when it cannot ("Cannot mkdir
    # '/root/.android'"). Measured 2026-09-03: the server's installed-version
    # probe swallowed that abort into "not installed", the first-run banner
    # named adb as failed to download on every boot, and no device could have
    # connected. HOME lives on the volume rather than in the image so the adb
    # key pair (the device-authorization identity) survives `docker rm`.
    export HOME=/data/home
    # exec, so tini keeps signalling PID 1's group and setpriv does not become
    # an extra process between tini and the app.
    #
    # --inh-caps=-all is not decoration: without it the stepped-down process
    # inherits the ambient capability set, which defeats half the point of not
    # being root.
    exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups --inh-caps=-all -- "$@"
fi

# Already non-root: `docker run --user` or compose `user:`. Nothing to drop, but
# the two things the root branch sets up still have to be true, because this
# path used to just exec and got neither (measured 2026-09-30):
#   - /data writable by this uid. A fresh named volume is root-owned, so the
#     server died at boot with exit 1 and nothing naming the cause.
#   - HOME on the volume. Docker sets HOME=/ for a uid with no passwd entry;
#     adb then aborted on "Cannot mkdir '//.android'" and no device appeared.
# Nothing can chown from here, so an unwritable /data stops with the fix named.
for dir in /data /data/dependencies /data/home /data/logs; do
    if [ -e "$dir" ] && [ ! -w "$dir" ]; then
        echo "[entrypoint] $dir is not writable by uid $(id -u):$(id -g)." >&2
        echo "[entrypoint] Running with --user needs a /data that uid owns. Either chown the volume once:" >&2
        echo "[entrypoint]   docker run --rm -u 0 -v <volume>:/data --entrypoint chown <image> -R $(id -u):$(id -g) /data" >&2
        echo "[entrypoint] or drop --user and let the image step down to uid $APP_UID itself." >&2
        exit 1
    fi
done
mkdir -p /data/dependencies /data/home /data/logs
export HOME=/data/home
exec "$@"
