import { defineConfig } from 'vitest/config';

export default defineConfig({
    define: {
        // Mirrors the webpack DefinePlugin constant so server-side modules that
        // read __PATHNAME__ (HttpServer.ts) can be imported in vitest without
        // the ReferenceError that fires when the constant is absent.
        __PATHNAME__: '""',
    },
    test: {
        // CSS imports are stubbed out (no stylesheet processing needed in tests)
        css: false,
        // The default 5s per-test timeout is too tight for tests that lazily
        // `await import()` a heavy module: under full-suite parallel load the
        // on-demand esbuild transform can momentarily exceed 5s and time the
        // test out (it passes in <1s in isolation). 20s leaves headroom for the
        // load spike without masking a genuine hang.
        testTimeout: 20000,
        globalSetup: ['./vitest.globalSetup.ts'],
        // Per-worker guard: neutralise stray process.exit so a leaked install/update
        // hand-off timer can't abort an unrelated test under worker reuse. See file.
        setupFiles: ['./vitest.setup.ts'],
    },
});
