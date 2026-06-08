import process from 'node:process';

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
