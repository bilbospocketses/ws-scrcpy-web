//! Smoke test: launcher --print-active-session exits 0 and writes EITHER:
//!   - a single u32 (followed by newline) when an active interactive
//!     session is resolvable (typical user desktop, RDP session,
//!     Hyper-V Enhanced Session, etc.), OR
//!   - empty stdout when none is resolvable (typical headless CI runner,
//!     pre-logon boot state, fully headless install).
//!
//! Pre-todo-§33 the handler always printed (used `WTSGetActiveConsoleSessionId`
//! which always returns some u32, often 0xFFFFFFFF in headless contexts).
//! Post-§33 fix the handler uses the canonical `common::session` resolver
//! which returns `Option<u32>`; the empty-stdout case is a deliberate
//! graceful fallback (Node-side `active-session.ts` treats non-numeric
//! stdout as `ok: false` → marker written without session filter →
//! "accepts any tray helper" graceful fallback).
//!
//! We can't assert a specific session value (depends on the test runner's
//! environment), but we can assert the format of whatever is produced.

use std::process::Command;

#[test]
fn print_active_session_outputs_a_number_or_empty() {
    let exe = env!("CARGO_BIN_EXE_ws-scrcpy-web-launcher");
    let out = Command::new(exe)
        .arg("--print-active-session")
        .output()
        .expect("spawn launcher");
    assert!(out.status.success(), "launcher exited non-zero: {:?}", out);
    let stdout = String::from_utf8(out.stdout).expect("utf8 stdout");
    let trimmed = stdout.trim();

    if trimmed.is_empty() {
        // No active interactive session resolvable — valid degraded state
        // (CI runner / headless / pre-logon). Nothing further to assert.
        return;
    }

    // Session is resolvable: expect a single line that parses as u32.
    assert_eq!(
        stdout.lines().count(),
        1,
        "expected exactly one line of stdout, got: {:?}",
        stdout
    );
    let parsed: u32 = trimmed.parse().expect("session id parses as u32");
    // Sanity: session 0 (LocalSystem) or 1+ (interactive). u32::MAX
    // shouldn't appear because the canonical resolver maps the
    // WTSGetActiveConsoleSessionId 0xFFFFFFFF sentinel to None (which
    // would have produced empty stdout above).
    assert_ne!(parsed, u32::MAX, "expected real session id, got u32::MAX sentinel");
}
