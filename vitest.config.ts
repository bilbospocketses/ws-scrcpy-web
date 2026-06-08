import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // CSS imports are stubbed out (no stylesheet processing needed in tests)
        css: false,
        globalSetup: ['./vitest.globalSetup.ts'],
        // Per-worker guard: neutralise stray process.exit so a leaked install/update
        // hand-off timer can't abort an unrelated test under worker reuse. See file.
        setupFiles: ['./vitest.setup.ts'],
    },
});
