#!/usr/bin/env bash
# capture-logs.sh — snapshot every ws-scrcpy-web diagnostic into one folder, for a smoke capture point.
#
# Run this at any "capture point" during the smoke pass — ESPECIALLY the moment a test FAILS, and
# right after an install / uninstall / update — to collect a complete, attachable evidence bundle.
# Read-only: it never changes the install. Linux (Fedora/SELinux + Ubuntu). Paths are pulled
# verbatim from source, same set as clear-install.sh.
#
# Usage:   bash capture-logs.sh [label]
#   e.g.   bash capture-logs.sh 5.8-after-user-uninstall
#          bash capture-logs.sh 6.6-system-update      # watch 10-avc.txt + 33-dataroot for the result
#          bash capture-logs.sh 14.7-uninstall-clean   # 30-fcontext.txt must be empty
# Output:  ~/wssw-smoke-logs/<timestamp>-<label>/   (+ a .tar.gz of the same folder to attach)
set -u

LABEL="${1:-capture}"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$HOME/wssw-smoke-logs/${TS}-${LABEL}"
mkdir -p "$OUT"

GREEN=$'\e[32m'; YEL=$'\e[33m'; RST=$'\e[0m'
note() { printf '%s[capture]%s %s\n' "$YEL" "$RST" "$*"; }

# --- resolved footprint (verbatim from source; mirrors clear-install.sh) ---
UNIT="WsScrcpyWeb.service"
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/WsScrcpyWeb"
USER_UNIT="$HOME/.config/systemd/user/$UNIT"
SYS_UNIT="/etc/systemd/system/$UNIT"
OPT_DIR="/opt/ws-scrcpy-web"
VAR_OPT_DIR="/var/opt/ws-scrcpy-web"
PROC_PAT='WsScrcpyWeb|ws-scrcpy-web-tray|ws-scrcpy-web-launcher|scrcpy-server'

HAVE_SEMANAGE=0; command -v semanage >/dev/null 2>&1 && HAVE_SEMANAGE=1
HAVE_AUSEARCH=0; command -v ausearch >/dev/null 2>&1 && HAVE_AUSEARCH=1

note "capturing to $OUT"
note "sudo is used for system-scope items (AVC, system journal, /var/opt, fcontext)"
sudo -v 2>/dev/null || note "sudo unavailable — system-scope items will be partial"

# 00. environment + version + key config fields
{
  echo "label:      $LABEL"
  echo "captured:   $(date -Is)"
  echo "host:       $(uname -a)"
  printf 'getenforce: '; getenforce 2>/dev/null || echo "(no SELinux)"
  echo
  echo "# files in this bundle:"
  echo "#   10-avc            SELinux denials this boot (want: none)"
  echo "#   20/21 user svc    journal + status (user scope)"
  echo "#   22/23 system svc  journal + status (system scope)"
  echo "#   30-fcontext       SELinux rules (want: empty after uninstall)"
  echo "#   31/32/33 ls -Z    /opt, /var/opt, dataRoot labels + recursive listing (leftover check)"
  echo "#   40/41-config      config.json (local / system)"
  echo "#   50-procs          running ws-scrcpy-web processes"
  echo "#   60/61-unit        systemd unit files"
  echo "#   70/71-*.log       app logs (local- / system-)"
} > "$OUT/00-env.txt"
{
  echo "# /opt VERSION:";   cat "$OPT_DIR/VERSION" 2>/dev/null || echo "(none)"
  echo "# local config webPort/installMode/firstRun:"
  grep -Eo '"(webPort|installMode|firstRunComplete)"[^,}]*' "$DATA_ROOT/config.json" 2>/dev/null || echo "(no local config.json)"
} > "$OUT/01-version.txt"

# 10. SELinux AVC denials (this boot) — the single most important signal
if [ -d /sys/fs/selinux ]; then
  if [ $HAVE_AUSEARCH -eq 1 ]; then sudo ausearch -m avc -ts boot 2>/dev/null; else sudo journalctl -b 2>/dev/null | grep -i avc; fi > "$OUT/10-avc.txt"
  if [ -s "$OUT/10-avc.txt" ]; then note "AVC denials FOUND — see 10-avc.txt"; else echo "(no AVC denials this boot)" > "$OUT/10-avc.txt"; fi
else
  echo "(no SELinux on this host)" > "$OUT/10-avc.txt"
fi

# 20. service journals + status (user + system)
journalctl --user -u "$UNIT" -b --no-pager -n 500 > "$OUT/20-journal-user.txt"   2>&1
systemctl  --user status "$UNIT" --no-pager      > "$OUT/21-status-user.txt"   2>&1
sudo journalctl -u "$UNIT" -b --no-pager -n 500     > "$OUT/22-journal-system.txt" 2>&1
sudo systemctl status "$UNIT" --no-pager         > "$OUT/23-status-system.txt"  2>&1

# 30. SELinux fcontext rules + file labels + recursive dataRoot listing (catches leftovers)
if [ $HAVE_SEMANAGE -eq 1 ]; then
  sudo semanage fcontext -l 2>/dev/null | grep ws-scrcpy-web > "$OUT/30-fcontext.txt"
  [ -s "$OUT/30-fcontext.txt" ] || echo "(no ws-scrcpy-web fcontext rules)" > "$OUT/30-fcontext.txt"
else
  echo "(semanage absent)" > "$OUT/30-fcontext.txt"
fi
ls -laZ  "$OPT_DIR"      > "$OUT/31-opt-ls.txt"      2>&1
sudo ls -laZ "$VAR_OPT_DIR" > "$OUT/32-var-opt-ls.txt"  2>&1
ls -laRZ "$DATA_ROOT"   > "$OUT/33-dataroot-ls.txt" 2>&1

# 40. config.json (local + system)
cp      "$DATA_ROOT/config.json"   "$OUT/40-config-local.json"  2>/dev/null || true
sudo cp "$VAR_OPT_DIR/config.json" "$OUT/41-config-system.json" 2>/dev/null || true

# 50. running processes
pgrep -fa "$PROC_PAT" > "$OUT/50-procs.txt" 2>&1 || echo "(no ws-scrcpy-web processes)" > "$OUT/50-procs.txt"

# 60. unit files
cp      "$USER_UNIT" "$OUT/60-user-unit.service"   2>/dev/null || true
sudo cp "$SYS_UNIT"  "$OUT/61-system-unit.service" 2>/dev/null || true

# 70. app logs (local + system) — prefixed so the two trees never clash
for f in "$DATA_ROOT"/logs/*.log;   do [ -e "$f" ] && cp      "$f" "$OUT/70-local-$(basename "$f")"  2>/dev/null; done
sudo find "$VAR_OPT_DIR/logs" -maxdepth 1 -type f -name '*.log*' 2>/dev/null | while IFS= read -r f; do sudo cp "$f" "$OUT/71-system-$(basename "$f")" 2>/dev/null; done

# bundle it for easy attachment
tar czf "$OUT.tar.gz" -C "$(dirname "$OUT")" "$(basename "$OUT")" 2>/dev/null && note "bundle: $OUT.tar.gz"
printf '%sCaptured ✓%s  %s\n' "$GREEN" "$RST" "$OUT"
