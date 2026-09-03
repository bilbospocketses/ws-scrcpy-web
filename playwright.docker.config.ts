import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL } from './tests/e2e/support/paths';

/**
 * The container suite.
 *
 * Same specs directory, same support library, different subject: the built image
 * rather than a bare `node dist/index.js`. Playwright's `webServer` is
 * config-scoped rather than project-scoped, so "bare server" and "container"
 * cannot be two projects in one config — two configs sharing
 * `tests/e2e/support/**` is the idiomatic answer, and it keeps one support
 * library and one selector vocabulary.
 *
 * Deliberately does NOT seed a config the way playwright.config.ts does. The
 * container is supposed to present as already-configured from WS_SCRCPY_DOCKER
 * alone (SP4 E4), and seeding `firstRunComplete` here would make
 * docker-gating.spec.ts pass whether or not the server implements it — an
 * unfalsifiable test, which is worse than no test.
 *
 * `webServer` is omitted when QA_EXTERNAL_STACK is set. qa-harness owns the
 * stack in the heavy tier (its compose file adds the emulator and a network this
 * repo knows nothing about); it points PLAYWRIGHT_BASE_URL at the running
 * container, and this config must not try to start a second one.
 */
const external = process.env['QA_EXTERNAL_STACK'] === '1';

export default defineConfig({
    testDir: 'tests/e2e',
    globalSetup: './tests/e2e/global-setup.ts',

    /**
     * The inverse of playwright.config.ts's grepInvert. `@device` is opted IN
     * only when QA_DEVICE=1, so a plain `npm run test:e2e:docker` on a machine
     * with no emulator runs the container specs and skips the device ones
     * rather than failing them.
     */
    grep: process.env['QA_DEVICE'] === '1' ? /@docker|@device/ : /@docker/,
    /**
     * `@docker-host` marks the container rows that drive a compose stack of
     * their own through the docker CLI (1.9's offline stack, 9.5's no-node-pty
     * image). They belong to this repo's CI, where the daemon is the tier's
     * execution environment; inside qa-harness's runner there is no docker CLI
     * by design, and the harness owns the one stack there is. Filtered by tag
     * when the harness owns the stack — a partition, not a skip: a filtered row
     * is not in the run at all, so it can neither pass vacuously nor fail for a
     * reason that names nothing near the cause (`spawnSync docker ENOENT`,
     * measured 2026-09-03 on every harness run before this).
     */
    ...(external ? { grepInvert: /@docker-host/ } : {}),

    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env['CI'],
    retries: process.env['CI'] ? 1 : 0,

    /**
     * Doubled against the fast config on purpose. A container boot has an order
     * more latency than an in-process spawn, and `expect` waits tight enough for
     * the fast tier produce flake here that reads as an app fault.
     */
    timeout: 60_000,
    expect: { timeout: 15_000 },

    reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',

    use: {
        baseURL: process.env['PLAYWRIGHT_BASE_URL'] || E2E_BASE_URL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },

    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

    ...(external
        ? {}
        : {
              webServer: {
                  /**
                   * `up --wait`, not `up -d`. `--wait` blocks on the
                   * HEALTHCHECK; `up -d` returns the moment the container is
                   * "Up", which is true while the server is still dead, and
                   * would hand Playwright a subject that is not listening.
                   */
                  command: 'docker compose up --wait ws-scrcpy-web',
                  url: `${E2E_BASE_URL}/api/config`,
                  /**
                   * Never reuse — same reasoning as the fast config. A server
                   * already on this port is not necessarily ours.
                   */
                  reuseExistingServer: false,
                  stdout: 'pipe',
                  stderr: 'pipe',
                  /**
                   * Five minutes, not two. A first boot against an empty volume
                   * downloads adb (~9 MB) before it listens, which is also why
                   * the image's HEALTHCHECK carries a 180s start-period.
                   */
                  timeout: 300_000,
              },
          }),
});
