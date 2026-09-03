import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import {
    E2E_BASE_URL,
    E2E_CONFIG_PATH,
    E2E_DATA_ROOT,
    E2E_PORT,
    E2E_PROGRAM_DATA,
    SEED_CONFIG,
    wipeE2EDatabase,
} from './tests/e2e/support/paths';

/**
 * End-to-end suite.
 *
 * This complements the vitest tests rather than repeating them. Those exercise pure
 * functions (`frameGuard`, `embedRequests`) with no I/O; these drive a real server
 * process over a real socket and assert on the file it writes — the layer where the
 * interesting failures actually live.
 *
 * Isolation is the load-bearing part of this config, for two reasons that both bite:
 *
 *   1. The consent specs approve and revoke embedding origins, and an approval
 *      REWRITES config.json. Aimed at an installed `<dataRoot>/config.json` that
 *      would edit a developer's live install; and since `webPort` lives in the same
 *      file, a careless write moves the running server to another port.
 *   2. A developer normally has the app up on 8000. Binding the suite there would
 *      collide with it, or worse, silently attach and mutate it.
 *
 * So the suite runs its own server, on its own port, against its own throwaway
 * config: WS_SCRCPY_CONFIG overrides the config path (see `src/server/Config.ts`)
 * and WS_SCRCPY_WEB_PORT overrides the port (see `src/server/index.ts`). Neither the
 * installed config nor anything under the real data root is touched.
 */
/**
 * Seed the throwaway config before anything else.
 *
 * This cannot live in `globalSetup`: Playwright starts `webServer` FIRST and only
 * then runs globalSetup, and the server throws outright when WS_SCRCPY_CONFIG names
 * a file that does not exist (an explicit override calls `loadFile` directly rather
 * than falling back to defaults the way the unset path does). Config load is the
 * last hook that genuinely precedes the server.
 *
 * Guarded to the runner process because worker processes re-import this module, and
 * re-seeding mid-run would wipe the state the specs had just written.
 *
 * The database goes first, for the same reason and one more: every run must start
 * in open mode with the seeded implicit admin, and no API call can get back there
 * once the auth specs have secured the admin account (see wipeE2EDatabase). The
 * server holds the WAL-mode file open once booted, so this is the only place the
 * wipe can happen. globalSetup re-dismisses the bookmark reminder on the fresh
 * database, so the wipe costs nothing. Skipped under QA_EXTERNAL_STACK: that
 * stack's data root is not ours to touch.
 */
if (process.env['TEST_WORKER_INDEX'] === undefined) {
    if (!process.env['QA_EXTERNAL_STACK']) wipeE2EDatabase();
    mkdirSync(E2E_DATA_ROOT, { recursive: true });
    writeFileSync(E2E_CONFIG_PATH, JSON.stringify(SEED_CONFIG, null, 4), 'utf8');

    /**
     * Decline the Linux system-wide install offer up front.
     *
     * On Linux `SystemWideInstallModal` opens on first load unless this marker
     * exists (`offerMachineWide` in `src/app/index.ts` gates on
     * `systemInstallDeclined`, which `ServiceApi` derives from the file's presence
     * rather than from a setting). Like the bookmark reminder it is a plain
     * <dialog> stacked over the consent prompt, so it swallows the clicks meant for
     * it — and being Linux-only it passes locally on Windows and fails only in CI.
     *
     * Name mirrors DECLINE_MARKER_NAME in `src/server/service/SystemdClient.ts`;
     * copied rather than imported to keep server modules out of this config.
     */
    mkdirSync(join(E2E_DATA_ROOT, 'control'), { recursive: true });
    writeFileSync(join(E2E_DATA_ROOT, 'control', 'system-install-declined'), '', 'utf8');
}

export default defineConfig({
    testDir: 'tests/e2e',
    globalSetup: './tests/e2e/global-setup.ts',

    /**
     * Serial on purpose, not as a workaround for flake.
     *
     * The server holds exactly ONE pending embed request at a time (`current` is
     * module-level state in `security/embedRequests.ts`) and every consent spec also
     * mutates the single shared config file. Run concurrently, specs would cancel
     * each other's prompts and race each other's writes.
     */
    fullyParallel: false,
    workers: 1,

    /**
     * The default run is the FAST tier: a bare `node dist/index.js`, no
     * container, no device, no credential. Two tags opt out of it.
     *
     * `@docker` needs the built image (playwright.docker.config.ts starts the
     * compose stack); `@device` needs that image AND the Android emulator, so it
     * only ever runs under qa-harness. Excluding them here rather than
     * segregating them into a directory keeps a feature's specs together — the
     * device streaming specs belong beside the settings specs that configure
     * the codec they stream.
     */
    grepInvert: /@docker|@device/,

    forbidOnly: !!process.env['CI'],
    retries: process.env['CI'] ? 1 : 0,
    timeout: 30_000,
    expect: { timeout: 10_000 },
    reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',

    use: {
        baseURL: process.env['PLAYWRIGHT_BASE_URL'] || E2E_BASE_URL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },

    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

    webServer: {
        command: 'node dist/index.js',
        url: `${E2E_BASE_URL}/`,
        /**
         * Never reuse. A server already listening on this port is not necessarily
         * ours, and attaching to someone else's would write to their config — the
         * exact accident this whole config exists to prevent.
         */
        reuseExistingServer: false,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 120_000,
        env: {
            /**
             * Isolate the whole data root, not just the config file. Per-user
             * settings (the bookmark-reminder flags among them) live in
             * `<dataRoot>/wsscrcpy.db`, so overriding only the config path would
             * leave the suite reading and writing a developer's real database.
             * PROGRAMDATA is the Windows lever, DATA_ROOT the one used elsewhere.
             */
            PROGRAMDATA: E2E_PROGRAM_DATA,
            DATA_ROOT: E2E_DATA_ROOT,
            /**
             * The log file and the dependencies folder are keyed on DEPS_PATH,
             * not on DATA_ROOT. Without it the suite's server logged into the
             * repo root and, on Linux, hydrated dependencies into
             * <repo>/dependencies — outside the isolation this config exists for.
             */
            DEPS_PATH: join(E2E_DATA_ROOT, 'dependencies'),
            WS_SCRCPY_CONFIG: E2E_CONFIG_PATH,
            WS_SCRCPY_WEB_PORT: String(E2E_PORT),
        },
    },
});
