#!/usr/bin/env bash
# clear-install.sh — clear EVERY ws-scrcpy-web install footprint on Linux, then verify the slate.
#
# Smoke pre-flight for the v0.1.30 gate. Idempotent + safe to run on an already-clean VM.
# Linux-only (Fedora/SELinux + Ubuntu). Paths/units/rules are pulled verbatim from source:
#   SystemdClient.ts (units, autostart, /opt, /var/opt, .desktop, stable bin in dataRoot),
#   linux_service.rs (teardown + fcontext specs), config.rs (dataRoot), single_instance.rs (lock).
# Validated on Fedora (SELinux enforcing) 2026-06-07 — 12/12 checks → CLEAN SLATE.
#
# Usage on the smoke VM:   bash clear-install.sh
set -u

GREEN=$'\e[32m'; RED=$'\e[31m'; YEL=$'\e[33m'; DIM=$'\e[2m'; RST=$'\e[0m'
PASS=0; FAIL=0
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s== %s ==%s\n' "$DIM" "$*" "$RST"; }
ok()   { printf '%s[ OK ]%s %s\n' "$GREEN" "$RST" "$*"; PASS=$((PASS+1)); }
bad()  { printf '%s[FAIL]%s %s\n' "$RED"   "$RST" "$*"; FAIL=$((FAIL+1)); }
info() { printf '%s[info]%s %s\n' "$YEL"   "$RST" "$*"; }

# --- resolved footprint (verbatim from source) ---
UNIT="WsScrcpyWeb.service"
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/WsScrcpyWeb"
USER_UNIT="$HOME/.config/systemd/user/$UNIT"
SYS_UNIT="/etc/systemd/system/$UNIT"
AUTOSTART="$HOME/.config/autostart/ws-scrcpy-web-tray.desktop"
SYS_DESKTOP="/usr/share/applications/ws-scrcpy-web.desktop"
OPT_DIR="/opt/ws-scrcpy-web"
VAR_LIB_DIR="/var/lib/ws-scrcpy-web"
LEGACY_VAR_OPT_DIR="/var/opt/ws-scrcpy-web"   # pre-beta.64 system-service state; defensively cleaned
LOCK="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/ws-scrcpy-web.lock"
# The /var/lib state dir needs NO fcontext rule (var_lib_t by the policy default). These
# specs are the install's /opt bin_t rule + legacy rules (/var/opt, /opt/.../data) -d'd defensively.
FCONTEXT_SPECS=( '/opt/ws-scrcpy-web(/.*)?' '/var/opt/ws-scrcpy-web(/.*)?' '/opt/ws-scrcpy-web/data(/.*)?' )
PROC_PAT='WsScrcpyWeb|ws-scrcpy-web-tray|ws-scrcpy-web-launcher|scrcpy-server'

HAVE_SEMANAGE=0; command -v semanage >/dev/null 2>&1 && HAVE_SEMANAGE=1
HAVE_SELINUX=0; [ -d /sys/fs/selinux ] && HAVE_SELINUX=1

say "Clearing ws-scrcpy-web footprint…"
say "  dataRoot : $DATA_ROOT"
say "  SELinux  : $([ $HAVE_SELINUX -eq 1 ] && echo present || echo absent)   semanage: $([ $HAVE_SEMANAGE -eq 1 ] && echo yes || echo no)"
sudo -v || { say "${RED}sudo required (system-scope teardown).${RST}"; exit 1; }   # prompt once, up front

step "PHASE 1 — TEARDOWN"

# 1. kill running processes (server + launcher + tray + escaped adb/scrcpy-server)
pkill -TERM -f "$PROC_PAT" 2>/dev/null || true
pkill -TERM -x adb         2>/dev/null || true
sleep 1
pkill -KILL -f "$PROC_PAT" 2>/dev/null || true

# 2. user-scope service
systemctl --user stop "$UNIT" 2>/dev/null || true
systemctl --user disable "$UNIT" 2>/dev/null || true
systemctl --user reset-failed "$UNIT" 2>/dev/null || true
rm -f "$USER_UNIT"
systemctl --user daemon-reload 2>/dev/null || true

# 3. system-scope service
sudo systemctl stop "$UNIT" 2>/dev/null || true
sudo systemctl disable "$UNIT" 2>/dev/null || true
sudo systemctl reset-failed "$UNIT" 2>/dev/null || true
sudo rm -f "$SYS_UNIT"
sudo systemctl daemon-reload 2>/dev/null || true

# 4. machine-wide /opt + system state /var/lib (+ legacy /var/opt, defensively)
sudo rm -rf "$OPT_DIR" "$VAR_LIB_DIR" "$LEGACY_VAR_OPT_DIR"

# 5. desktop entries
sudo rm -f "$SYS_DESKTOP"
command -v update-desktop-database >/dev/null 2>&1 && sudo update-desktop-database /usr/share/applications 2>/dev/null || true
rm -f "$AUTOSTART"

# 6. per-user dataRoot (config.json, logs/, dependencies/, bin/WsScrcpyWeb.AppImage, control/instance.lock)
rm -rf "$DATA_ROOT"

# 7. single-instance lock
rm -f "$LOCK"

# 8. SELinux fcontext rules (current x2 + legacy beta.40 /opt/.../data)
if [ $HAVE_SEMANAGE -eq 1 ]; then
  for spec in "${FCONTEXT_SPECS[@]}"; do sudo semanage fcontext -d "$spec" 2>/dev/null || true; done
else
  info "semanage absent — skipping fcontext cleanup (non-SELinux host)"
fi
say "Teardown issued."

step "PHASE 2 — VERIFY (test it cleared)"
[ ! -e "$USER_UNIT" ]   && ok "user unit removed"        || bad "user unit present: $USER_UNIT"
[ ! -e "$SYS_UNIT"  ]   && ok "system unit removed"      || bad "system unit present: $SYS_UNIT"
[ ! -e "$OPT_DIR"   ]   && ok "/opt removed"             || bad "/opt present: $OPT_DIR"
[ ! -e "$VAR_LIB_DIR" ] && ok "/var/lib removed"         || bad "/var/lib present: $VAR_LIB_DIR"
[ ! -e "$DATA_ROOT" ]   && ok "dataRoot removed"         || bad "dataRoot present: $DATA_ROOT"
[ ! -e "$AUTOSTART" ]   && ok "tray autostart removed"   || bad "autostart present: $AUTOSTART"
[ ! -e "$SYS_DESKTOP" ] && ok "system .desktop removed"  || bad ".desktop present: $SYS_DESKTOP"
[ ! -e "$LOCK" ]        && ok "instance lock removed"    || bad "lock present: $LOCK"

systemctl --user list-unit-files 2>/dev/null | grep -q "^$UNIT" && bad "user unit still known to systemd --user" || ok "user unit unknown to systemd --user"
systemctl list-unit-files 2>/dev/null | grep -q "^$UNIT" && bad "system unit still known to systemd" || ok "system unit unknown to systemd"

if pgrep -fa "$PROC_PAT" >/dev/null 2>&1; then bad "processes still running:"; pgrep -fa "$PROC_PAT" | sed 's/^/        /'
else ok "no ws-scrcpy-web processes running"; fi

if [ $HAVE_SEMANAGE -eq 1 ]; then   # NB: -l needs sudo (non-root semanage throws "SELinux policy is not managed")
  leftover="$(sudo semanage fcontext -l 2>/dev/null | grep ws-scrcpy-web || true)"
  [ -z "$leftover" ] && ok "no fcontext rules remain" || { bad "fcontext rules remain:"; printf '%s\n' "$leftover" | sed 's/^/        /'; }
fi

shopt -s nullglob; dls=( "$HOME/Downloads"/WsScrcpyWeb-linux*.AppImage "$HOME"/WsScrcpyWeb*.AppImage ); shopt -u nullglob
[ ${#dls[@]} -gt 0 ] && info "downloaded AppImage left in place (installer, not install): ${dls[*]}"

say ""
if [ $FAIL -eq 0 ]; then printf '%sCLEAN SLATE ✓%s  %d checks passed.\n' "$GREEN" "$RST" "$PASS"; exit 0
else printf '%sNOT CLEAN ✗%s  %d passed, %d FAILED — see [FAIL] lines.\n' "$RED" "$RST" "$PASS" "$FAIL"; exit 1; fi
