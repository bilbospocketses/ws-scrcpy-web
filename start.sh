#!/bin/bash
# ws-scrcpy-web launcher for Linux
# Runs Node.js from dependencies folder, handles restart on update

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$SCRIPT_DIR/dependencies/node/node"
ENTRY="$SCRIPT_DIR/dist/index.js"
RESTART_MARKER="$SCRIPT_DIR/.restart"
export DEPS_PATH="$SCRIPT_DIR/dependencies"

# Ensure node binary exists
if [ ! -x "$NODE" ]; then
    echo "ERROR: Node.js not found at $NODE"
    echo "Run the initial setup or place the node binary in dependencies/node/"
    exit 1
fi

# Clean up stale restart marker
rm -f "$RESTART_MARKER"

while true; do
    echo "Starting ws-scrcpy-web..."
    "$NODE" "$ENTRY"
    EXIT_CODE=$?

    # Check if restart was requested
    if [ -f "$RESTART_MARKER" ]; then
        rm -f "$RESTART_MARKER"
        echo "Restarting..."
        sleep 2
        continue
    fi

    # Process exited without restart request — stop
    echo "ws-scrcpy-web exited with code $EXIT_CODE"
    exit $EXIT_CODE
done
