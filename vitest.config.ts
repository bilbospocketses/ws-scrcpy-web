import { defineConfig } from 'vitest/config';

export default defineConfig({
    define: {
        // Mirrors the webpack DefinePlugin constant so server-side modules that
        // read __PATHNAME__ (HttpServer.ts) can be imported in vitest without
        // the ReferenceError that fires when the constant is absent.
        __PATHNAME__: '""',
    },
    test: {
        // The Playwright suite lives in tests/e2e and uses `@playwright/test`, whose
        // `test.describe` throws outright when a different runner imports it
        // ("Playwright Test did not expect test.describe() to be called here").
        // Vitest's default spec glob would otherwise collect those files and report
        // three failures that have nothing to do with the code under test.
        exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
        // CSS imports are stubbed out (no stylesheet processing needed in tests)
        css: false,
        // The default 5s per-test timeout is too tight for tests that lazily
        // `await import()` a heavy module: under full-suite parallel load the
        // on-demand esbuild transform can momentarily exceed 5s and time the
        // test out (it passes in <1s in isolation).
        //
        // These two timeouts are hang guards, not speed checks: correct code
        // that only runs slower on a loaded box must never fail a test. So
        // they sit far past any healthy test (seconds at most), and past
        // src/testSupport/waitFor.ts's 120 s bound, so a wait that hangs is
        // reported by waitFor as HUNG, naming its condition, before the test
        // itself times out.
        testTimeout: 300_000,
        // Vitest defaults `hookTimeout` to 10s and does NOT follow
        // `testTimeout`, so before/afterEach had half the budget of the tests
        // they exist to set up -- and the heaviest work in this suite is in a
        // hook, not a test: nodePtyResolver.integration's beforeEach `cpSync`s
        // the whole node-pty + node-addon-api trees (a compiled .node binary
        // included) for EVERY test, and every copied file is scanned by
        // endpoint AV on the way past.
        //
        // Measured 2026-09-22 (item 140): with the CPU pinned, 7 of 8
        // full-suite runs failed and EVERY failure was `Hook timed out in
        // 10000ms` -- zero assertion failures, zero EPERM. The hook is
        // legitimately slow rather than wrong, so it gets the same budget as
        // the tests.
        hookTimeout: 300_000,
        globalSetup: ['./vitest.globalSetup.ts'],
        // Per-worker guard: neutralise stray process.exit so a leaked install/update
        // hand-off timer can't abort an unrelated test under worker reuse. See file.
        setupFiles: ['./vitest.setup.ts'],
    },
});
