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
        // test out (it passes in <1s in isolation). 20s leaves headroom for the
        // load spike without masking a genuine hang.
        testTimeout: 20000,
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
        // 10000ms` -- zero assertion failures, zero EPERM. Matching the test
        // budget is the smallest honest fix; the hook is legitimately slow
        // rather than wrong.
        hookTimeout: 20000,
        globalSetup: ['./vitest.globalSetup.ts'],
        // Per-worker guard: neutralise stray process.exit so a leaked install/update
        // hand-off timer can't abort an unrelated test under worker reuse. See file.
        setupFiles: ['./vitest.setup.ts'],
    },
});
