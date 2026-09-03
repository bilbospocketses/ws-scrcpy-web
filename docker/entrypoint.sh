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
    # a fresh volume hands it over with everything else.
    mkdir -p /data/dependencies /data/home
    # Only when it is actually wrong. `chown -R` on a populated /data with a
    # large dependencies tree costs real seconds on every boot for nothing.
    if [ "$(stat -c '%u' /data)" != "$APP_UID" ]; then
        echo "[entrypoint] taking ownership of /data for uid $APP_UID"
        chown -R "$APP_UID:$APP_GID" /data
    fi
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

# Already non-root (docker run --user). Nothing to drop; just run.
exec "$@"
