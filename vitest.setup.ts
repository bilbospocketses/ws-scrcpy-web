import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';

// Per-worker setup: never let a test resolve this developer's REAL per-user
// profile directory.
//
// Config.getInstance() (Config.ts's private static buildServers) resolves
// resolveCertPaths's per-user TLS directory from the real LOCALAPPDATA/HOME/
// USERPROFILE env vars whenever a test doesn't override them -- and none of
// the ~25 test files that call Config._resetForTest() do, because those knobs
// were never part of the surface Config tests were built to isolate
// (PROGRAMDATA/DATA_ROOT/XDG_DATA_HOME are; see e.g. ServiceApi.test.ts's
// beforeEach). Left alone, every Config.getInstance() call in the suite does a
// real disk read against this developer's actual AppData\Local looking for a
// certificate that (today) doesn't exist there -- extra real filesystem I/O on
// the hot path of nearly every test in the suite. Measured 2026-09-19:
// ServiceApi.test.ts failed ~1 run in 3 in isolation after this path was
// added, having passed reliably before it.
//
// Point every branch (LOCALAPPDATA, HOME, USERPROFILE) at a scratch path under
// the OS temp dir that is never created -- resolveCertPaths only builds path
// strings, and the subsequent read fails ENOENT exactly like "no certificate",
// so the real path through the code still executes, it just never touches
// real per-user state. No mkdir, no cleanup: nothing is ever written there.
const scratchLocalAppData = path.join(os.tmpdir(), 'ws-scrcpy-web-test-localappdata');
process.env['LOCALAPPDATA'] = scratchLocalAppData;
process.env['HOME'] = scratchLocalAppData;
process.env['USERPROFILE'] = scratchLocalAppData;

// Per-worker setup: a worker-lifetime guard against stray process.exit.
//
// A test must never terminate its vitest worker. Some production paths schedule a
// real `setTimeout(() => process.exit(0), …).unref()` (e.g. ServiceApi's install /
// update hand-off, where the local instance exits to free the single-instance lock
// for the service). A test that exercises those paths without injecting a no-op
// `scheduleExit` leaks that timer; because vitest reuses workers across files, the
// `.unref()`'d timer can fire ~1.5s later while an UNRELATED test file is running,
// surfacing as a confusing "process.exit unexpectedly called" failure attributed to
// whatever test happened to be in flight.
//
// Neutralise process.exit for the worker's whole lifetime so a leaked call can never
// abort an unrelated test. Tests that assert on exit still `vi.spyOn(process,'exit')`
// locally and observe the call (the spy wraps this no-op). Kept silent so suite
// output stays pristine.
process.exit = ((_code?: number): never => {
    return undefined as never;
}) as typeof process.exit;
