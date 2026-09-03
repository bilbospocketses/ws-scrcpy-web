#!/bin/bash
# ws-scrcpy-web launcher for Linux
# Runs Node.js from dependencies folder, handles restart on update

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$SCRIPT_DIR/dependencies/node/node"
ENTRY="$SCRIPT_DIR/dist/index.js"
export DEPS_PATH="$SCRIPT_DIR/dependencies"
RESTART_MARKER="$DEPS_PATH/.restart"

# Probe chain: dependencies first, then Velopack seed fallback
if [ ! -x "$NODE" ]; then
    NODE="$SCRIPT_DIR/seed/node/node"
fi
if [ ! -x "$NODE" ]; then
    echo "ERROR: Node.js not found at dependencies/node/ or seed/node/"
    echo "Reinstall the app to restore the bundled Node."
    exit 1
fi

# Clean up stale restart marker
rm -f "$RESTART_MARKER"

# Forward SIGTERM/SIGINT to the node child and WAIT for it, instead of letting
# bash die where it stands.
#
# Without this, bash has no trap: a SIGTERM aimed at the process group kills the
# shell instantly, the shell's supervisor sees the launcher exit 143, and node's
# shutdown (adb kill-server + service release) is cut off mid-flight. Measured in
# the container 2026-09-03: `docker stop` gave exit 143 with the teardown
# unfinished, while signalling node alone gave a clean exit 0 -- the difference
# was entirely this missing trap.
#
# It matters on the desktop too. systemd's `stop` signals the whole cgroup, so a
# user-scope or system-scope service unit hits the identical path.
#
# NODE_PID is only set while a child is running, so a signal arriving between
# restarts cannot kill -TERM an empty string. `wait` returns >128 when it is
# interrupted by the trap, so it is called twice: the second returns the child's
# real exit status once it has actually finished.
NODE_PID=""
forward_signal() {
    _sig="$1"
    if [ -n "$NODE_PID" ]; then
        echo "Forwarding SIG$_sig to ws-scrcpy-web (pid $NODE_PID)..."
        kill -"$_sig" "$NODE_PID" 2>/dev/null || true
    fi
}
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

while true; do
    echo "Starting ws-scrcpy-web..."
    # Backgrounded + wait, not a foreground call: bash runs traps only between
    # commands, so a foreground child would defer the trap until it exited --
    # which is the very delay this is here to remove.
    "$NODE" "$ENTRY" &
    NODE_PID=$!
    wait "$NODE_PID"
    EXIT_CODE=$?
    # >128 means `wait` was interrupted by our own trap rather than the child
    # finishing. Wait again for the real status now that the signal is forwarded.
    if [ "$EXIT_CODE" -gt 128 ]; then
        wait "$NODE_PID"
        EXIT_CODE=$?
    fi
    NODE_PID=""

    # Check if restart was requested — marker file OR exit code 75
    if [ -f "$RESTART_MARKER" ]; then
        rm -f "$RESTART_MARKER"
        echo "Restarting (marker)..."
        sleep 2
        continue
    fi
    if [ "$EXIT_CODE" -eq 75 ]; then
        echo "Restarting (exit 75)..."
        sleep 2
        continue
    fi

    # Process exited without restart request — stop
    echo "ws-scrcpy-web exited with code $EXIT_CODE"
    exit $EXIT_CODE
done
