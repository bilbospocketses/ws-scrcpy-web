#!/usr/bin/env node
// Dev-mode supervisor for `npm start`. Spawns `node dist/index.js` and
// respawns on exit-75 OR `<dataRoot>/.restart` marker presence, mirroring
// `launcher/src/supervisor.rs:36-45` decide_restart semantics so dev
// iteration behaves like an installed MSI/AppImage run when the server
// requests a restart (port change, dependency update, etc.).
//
// Without this, dev mode (`node dist/index.js` directly) has no supervisor
// to catch the server's `process.exit(75)` — Node dies, the browser
// redirects to a dead port, and the user must re-run `npm start` manually.
//
// Crash-loop protection: bail if 3+ respawns happen within 10 s.
// Forwards SIGINT / SIGTERM to the child so Ctrl+C stops the supervisor
// AND the server in one shot.
//
// In install (MSI / AppImage), `ws-scrcpy-web-launcher.exe` is the
// supervisor; this script is NEVER shipped — `scripts/stage-publish.mjs`
// does not copy `scripts/` into `publish/`.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const EXIT_RESTART = 75;
const MAX_RESPAWNS_IN_WINDOW = 3;
const MAX_RESPAWNS_WINDOW_MS = 10_000;
const RESPAWN_DELAY_MS = 250;
const SHUTDOWN_GRACE_MS = 10_000;

// Windows-built-in process killer, anchored at its System32 path so PATH
// shadowing can't redirect us to a different `taskkill` (matches the
// `WINDOWS_TAR` precedent in scripts/fetch-node.mjs). Not subject to
// Local-Dependencies-Only since it's part of the Windows OS image — same
// rationale as tar.exe in the seed-fetch script.
const WINDOWS_TASKKILL = 'C:\\Windows\\System32\\taskkill.exe';

/**
 * Resolve the `.restart` marker path the same way `Config.restartMarkerPath`
 * does for the server — so dev supervisor reads the file the server writes.
 * On Windows: `<PROGRAMDATA>\WsScrcpyWeb\.restart`. On non-Windows: repo-root
 * `.restart` (matches `launcher/src/paths.rs:62` collapse + dev fallback's
 * `<entryDir>/../dependencies` placement).
 */
export function computeMarkerPath(env = process.env, platform = process.platform, repoRoot = REPO_ROOT) {
    if (platform === 'win32') {
        const programData = env.PROGRAMDATA || 'C:\\ProgramData';
        return join(programData, 'WsScrcpyWeb', '.restart');
    }
    return join(repoRoot, '.restart');
}

/**
 * Pure decision function. Mirrors `launcher/src/supervisor.rs:36-45`:
 * marker presence wins over exit code (both signal an intentional restart,
 * but the marker handles the crash-with-write-but-no-clean-exit case).
 * Returns the reason string or null to indicate "stop, don't restart."
 */
export function decideRestart(exitCode, markerExists) {
    if (markerExists) return 'marker';
    if (exitCode === EXIT_RESTART) return 'exit-75';
    return null;
}

/**
 * Resolve the Node binary the supervisor will use to spawn the server.
 * Mirrors `launcher/src/spawn.rs::resolve_node_with` exactly: local-deps
 * first, seed second. Strict — no system-Node fallback. Per CLAUDE.md's
 * Local-Dependencies-Only architecture, the runtime Node MUST resolve
 * inside the app folder; the prestart hook (`scripts/fetch-node.mjs`)
 * guarantees `seed/node/node.exe` exists at v24.15.0 before this runs,
 * so the seed branch always covers the cold-install case.
 *
 * Returns `null` if neither path resolves, which `main()` surfaces as a
 * fatal startup error with instructions — never silently bootstraps to
 * the user's system Node.
 */
export function resolveNodeBinary(env = process.env, platform = process.platform, repoRoot = REPO_ROOT) {
    const ext = platform === 'win32' ? '.exe' : '';

    if (platform === 'win32') {
        const dataRoot = join(env.PROGRAMDATA || 'C:\\ProgramData', 'WsScrcpyWeb');
        const localDeps = join(dataRoot, 'dependencies', 'node', `node${ext}`);
        if (existsSync(localDeps)) return { path: localDeps, source: 'local-deps' };
    }

    const seed = join(repoRoot, 'seed', 'node', `node${ext}`);
    if (existsSync(seed)) return { path: seed, source: 'seed' };

    return null;
}

async function main() {
    const markerPath = computeMarkerPath();
    const serverScript = join(REPO_ROOT, 'dist', 'index.js');
    if (!existsSync(serverScript)) {
        console.error(`[dev-supervisor] FATAL: ${serverScript} not found — run \`npm run build\` first`);
        process.exit(1);
    }

    const recentRespawns = [];
    let shutdown = false;
    let currentChild = null;
    let forceKillTimer = null;

    /**
     * Force-kill the entire process tree rooted at `pid`. On Windows uses
     * `taskkill /T /F` (kills tree, forces). On Linux signals the process
     * group via SIGKILL. Required when the child's own shutdown handler
     * hangs and won't exit on its own — also reaps any grandchildren the
     * child spawned (node-pty workers, scrcpy-server local helpers, etc.).
     */
    const forceKillTree = (pid) => {
        if (process.platform === 'win32') {
            try {
                spawnSync(WINDOWS_TASKKILL, ['/pid', String(pid), '/T', '/F'], { stdio: 'inherit' });
            } catch (err) {
                console.error(`[dev-supervisor] taskkill failed: ${err.message}`);
            }
        } else {
            try {
                // Negative pid signals the process group (set by detached:true on POSIX).
                process.kill(-pid, 'SIGKILL');
            } catch {
                try { process.kill(pid, 'SIGKILL'); } catch {}
            }
        }
    };

    const forwardSignal = (sig) => {
        if (!currentChild || currentChild.killed) return;
        shutdown = true;
        // Second signal during the grace window? Skip ahead to the force-kill.
        if (forceKillTimer) {
            console.log(`[dev-supervisor] received ${sig} again during grace window — force-killing tree now`);
            clearTimeout(forceKillTimer);
            forceKillTimer = null;
            forceKillTree(currentChild.pid);
            return;
        }
        // Platform divergence: POSIX signals work properly, so we forward
        // sig to the child for a graceful shutdown. On Windows, POSIX
        // signals don't exist — Node's `subprocess.kill('SIGINT')` is
        // TerminateProcess (per Node docs), which kills the child
        // abruptly (no graceful handler, no time for pending sync I/O
        // like the server's exit() teardown logs + fs.appendFileSync to
        // ws-scrcpy-web.log). It's ALSO redundant on win32 because
        // PowerShell's Ctrl+C broadcasts CTRL_C_EVENT to the entire
        // console process group, so the child has already received a
        // GRACEFUL SIGINT via the console group and is running its
        // exit() handler cleanly. Skipping the forward lets that handler
        // complete; the force-kill grace timer below catches the
        // genuine-hang case. Diagnosed 2026-05-15 via missing
        // ws-scrcpy-web.log entries after SIGINT: child was being nuked
        // mid-exit() so even sync log writes never landed.
        if (process.platform === 'win32') {
            console.log(`[dev-supervisor] ${sig} received (win32: relying on console-group propagation to child); force-kill tree in ${SHUTDOWN_GRACE_MS}ms if child still alive`);
        } else {
            console.log(`[dev-supervisor] forwarding ${sig} to child pid=${currentChild.pid}; force-kill in ${SHUTDOWN_GRACE_MS}ms if still alive`);
            currentChild.kill(sig);
        }
        forceKillTimer = setTimeout(() => {
            forceKillTimer = null;
            if (currentChild && !currentChild.killed) {
                console.warn(`[dev-supervisor] grace period elapsed — taskkill /T /F pid=${currentChild.pid}`);
                forceKillTree(currentChild.pid);
            }
        }, SHUTDOWN_GRACE_MS).unref();
    };
    process.on('SIGINT', () => forwardSignal('SIGINT'));
    process.on('SIGTERM', () => forwardSignal('SIGTERM'));

    const nodeResolution = resolveNodeBinary();
    if (!nodeResolution) {
        console.error('[dev-supervisor] FATAL: no Node binary found at <dataRoot>/dependencies/node/ or <repo>/seed/node/');
        console.error('[dev-supervisor] Run `node scripts/fetch-node.mjs` (or `npm run prestart`, which chains it) to download + stage the pinned Node version. No system-Node fallback per Local-Dependencies-Only.');
        process.exit(1);
    }
    console.log(`[dev-supervisor] starting; node=${nodeResolution.path} (source=${nodeResolution.source}); marker=${markerPath}`);

    for (;;) {
        // Re-resolve Node every iteration: once autoInstall populates
        // <dataRoot>/dependencies/node/ during the FIRST server run, the
        // SECOND server run (post-restart) automatically picks up the
        // local-deps Node over the seed.
        const node = resolveNodeBinary();
        if (!node) {
            console.error('[dev-supervisor] FATAL: Node binary disappeared between iterations — aborting');
            process.exit(1);
        }
        currentChild = spawn(node.path, ['--disable-warning=ExperimentalWarning', serverScript], {
            stdio: 'inherit',
            cwd: REPO_ROOT,
        });

        const exitCode = await new Promise((res) => {
            currentChild.on('exit', (code) => res(code ?? 1));
        });
        currentChild = null;
        // Child exited (gracefully or forcibly) — cancel any pending force-kill
        // timer so it doesn't fire mid-respawn and torch the NEXT child.
        if (forceKillTimer) {
            clearTimeout(forceKillTimer);
            forceKillTimer = null;
        }

        if (shutdown) {
            console.log('[dev-supervisor] shutdown signal received, exiting');
            process.exit(exitCode);
        }

        const markerExists = existsSync(markerPath);
        if (markerExists) {
            try {
                unlinkSync(markerPath);
                console.log(`[dev-supervisor] consumed marker at ${markerPath}`);
            } catch (err) {
                console.warn(`[dev-supervisor] failed to remove marker: ${err.message}`);
            }
        }

        const reason = decideRestart(exitCode, markerExists);
        if (reason === null) {
            console.log(`[dev-supervisor] child exited ${exitCode} (no restart signal) — exiting`);
            process.exit(exitCode);
        }

        const now = Date.now();
        recentRespawns.push(now);
        while (recentRespawns.length > 0 && now - recentRespawns[0] > MAX_RESPAWNS_WINDOW_MS) {
            recentRespawns.shift();
        }
        if (recentRespawns.length > MAX_RESPAWNS_IN_WINDOW) {
            console.error(
                `[dev-supervisor] ${recentRespawns.length} respawns within ${MAX_RESPAWNS_WINDOW_MS}ms — crash-loop, aborting`,
            );
            process.exit(1);
        }

        console.log(`[dev-supervisor] respawning (reason=${reason}, respawns in window=${recentRespawns.length})`);
        await new Promise((r) => setTimeout(r, RESPAWN_DELAY_MS));
    }
}

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMainModule) {
    main();
}
