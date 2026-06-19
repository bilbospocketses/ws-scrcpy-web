import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import type { DependencyInfo, UpdateResult } from '../common/DependencyTypes';
import { compareVersions, DependencyStatus } from '../common/DependencyTypes';
import type { DependencyDefinition } from './DependencyDefinitions';
import { getDependencyDefinitions, getPlatform } from './DependencyDefinitions';
import { Logger } from './Logger';
import { writeInstalledScrcpyServerVersion } from './scrcpyServerVersion';
import { launcherIsAvailable, resolveLauncherPath } from './service/elevatedRunner';

const log = Logger.for('DependencyManager');
const execFileAsync = promisify(execFile);

export class DependencyManager {
    private readonly definitions: DependencyDefinition[];
    private readonly state: Map<string, DependencyInfo>;
    private readonly restartMarkerPath: string;

    constructor(
        private readonly depsPath: string,
        opts: { restartMarkerPath?: string } = {},
    ) {
        // Default to <depsPath>/.restart preserves pre-Phase-1 behavior for
        // tests that don't care about the marker location. Production code
        // (index.ts) passes the explicit Config.restartMarkerPath so the
        // marker lands at <dataRoot>/.restart, matching launcher/src/paths.rs:70.
        this.restartMarkerPath = opts.restartMarkerPath ?? path.join(depsPath, '.restart');
        this.definitions = getDependencyDefinitions(depsPath);
        this.state = new Map();

        for (const def of this.definitions) {
            this.state.set(def.name, {
                name: def.name,
                displayName: def.displayName,
                installedVersion: null,
                latestVersion: null,
                status: DependencyStatus.Unknown,
                description: def.description,
                requiresRestart: def.requiresRestart,
                pairedWith: def.pairedWith,
                canUpdate: false,
            });
        }
    }

    public async getAll(): Promise<DependencyInfo[]> {
        const launcherAvail = await launcherIsAvailable();
        // In-place mutation: callers (incl. getByName) hold references to state
        // entries and mutate them; spread copies would orphan those mutations.
        for (const info of this.state.values()) {
            const def = this.definitions.find((d) => d.name === info.name);
            info.canUpdate = !def?.requiresLauncher || launcherAvail;
        }
        return Array.from(this.state.values());
    }

    public getByName(name: string): DependencyInfo | undefined {
        return this.state.get(name);
    }

    public async checkInstalled(name: string): Promise<void> {
        const def = this.definitions.find((d) => d.name === name);
        const info = this.state.get(name);
        if (!def || !info) return;

        info.status = DependencyStatus.Checking;
        try {
            info.installedVersion = await def.checkInstalled(this.depsPath);
            this.resolveStatus(info);
        } catch (err) {
            info.status = DependencyStatus.Error;
            info.errorMessage = err instanceof Error ? err.message : String(err);
        }
    }

    public async checkLatest(name: string): Promise<void> {
        const def = this.definitions.find((d) => d.name === name);
        const info = this.state.get(name);
        if (!def || !info) return;

        info.status = DependencyStatus.Checking;
        try {
            info.latestVersion = await def.checkLatest();
            this.resolveStatus(info);
        } catch (err) {
            info.status = DependencyStatus.Error;
            info.errorMessage = err instanceof Error ? err.message : String(err);
            log.warn(`Latest-version check failed for ${name}: ${info.errorMessage}`);
        }
    }

    public async checkAll(): Promise<void> {
        for (const def of this.definitions) {
            await this.checkInstalled(def.name);
        }
        for (const def of this.definitions) {
            await this.checkLatest(def.name);
        }
        const infos = Array.from(this.state.values());
        const updates = infos.filter((i) => i.status === DependencyStatus.UpdateAvailable).map((i) => i.name);
        const upToDate = infos.filter((i) => i.status === DependencyStatus.UpToDate).length;
        const errors = infos.filter((i) => i.status === DependencyStatus.Error).length;
        const parts: string[] = [];
        if (updates.length > 0) {
            parts.push(
                `${updates.length} ${updates.length === 1 ? 'update' : 'updates'} available (${updates.join(', ')})`,
            );
        }
        if (upToDate > 0) {
            parts.push(`${upToDate} up-to-date`);
        }
        if (errors > 0) {
            parts.push(`${errors} ${errors === 1 ? 'check failure' : 'check failures'}`);
        }
        log.info(`Dependency check complete: ${parts.length > 0 ? parts.join(', ') : 'no results'}`);
    }

    public async update(name: string): Promise<UpdateResult> {
        const def = this.definitions.find((d) => d.name === name);
        const info = this.state.get(name);
        if (!def || !info) {
            return { success: false, errorMessage: `Unknown dependency: ${name}`, requiresRestart: false };
        }
        if (def.requiresLauncher && !(await launcherIsAvailable())) {
            return {
                success: false,
                reason: 'launcher-required',
                errorMessage:
                    `${def.displayName} updates require an installed build. ` +
                    'In dev mode, populate dependencies/ via scripts/fetch-node.mjs.',
                requiresRestart: false,
            };
        }

        info.status = DependencyStatus.Updating;
        const fromVersion = info.installedVersion ?? 'not installed';
        const tmpDir = path.join(os.tmpdir(), 'ws-scrcpy-web', `update-${name}-${Date.now()}`);
        // §25 — TS6 using-declaration replaces the prior try/finally cleanup.
        // The dispose fires on every scope exit (return / throw / fall-through)
        // and rmSync with force:true is safe even if mkdirSync below never ran.
        using _tmpDirCleanup = {
            [Symbol.dispose](): void {
                try {
                    fs.rmSync(tmpDir, { recursive: true, force: true });
                } catch {
                    // Best-effort
                }
            },
        };

        try {
            // Ensure latest version is known
            if (!info.latestVersion) {
                info.latestVersion = await def.checkLatest();
            }
            if (!info.latestVersion) {
                throw new Error('Could not determine latest version');
            }

            log.info(`Updating ${name}: ${fromVersion} → ${info.latestVersion}`);

            const version = info.latestVersion;
            const url = def.getDownloadUrl(version);

            // Create temp directory
            fs.mkdirSync(tmpDir, { recursive: true });

            // Download
            const fileName = url.split('/').pop() || `${name}-download`;
            const downloadPath = path.join(tmpDir, fileName);
            await this.download(url, downloadPath);

            // Extract / install
            await this.install(name, def, downloadPath, version, tmpDir);

            // Re-read installed version from disk rather than trusting the
            // requested `version` directly. For scrcpy-server this means the
            // .version marker just written by installScrcpyServer is read
            // back through the same path checkAll() uses — the in-memory
            // state stays sourced from a single place and the post-update
            // "Update available" loop can't re-emerge from a desync.
            await this.checkInstalled(name);
            info.errorMessage = undefined;

            log.info(`Updated ${name} to ${version}${def.requiresRestart ? ' (restart queued)' : ''}`);

            return { success: true, newVersion: version, requiresRestart: def.requiresRestart };
        } catch (err) {
            info.status = DependencyStatus.Error;
            info.errorMessage = err instanceof Error ? err.message : String(err);
            log.error(`Update ${name} failed: ${info.errorMessage}`);
            return {
                success: false,
                errorMessage: info.errorMessage,
                requiresRestart: def.requiresRestart,
            };
        }
    }

    public async autoInstallMissing(): Promise<void> {
        // v0.1.9: try the seed-promotion path before any network
        // download. If we ship scrcpy-server as a seed (in
        // <install>/seed/scrcpy-server/scrcpy-server), copy it into
        // <deps>/scrcpy-server/scrcpy-server so the runtime path
        // (DeviceProbe / ScrcpyConnection) can read it. Idempotent —
        // if the dest already exists, the promotion is a no-op.
        // Network download still runs after, in case the seed is
        // missing or the user has an updater-managed newer version.
        try {
            this.promoteSeedScrcpyServer();
        } catch (err) {
            log.warn(`seed-promote scrcpy-server failed: ${(err as Error).message}`);
        }

        const launcherAvail = await launcherIsAvailable();
        for (const info of this.state.values()) {
            if (info.installedVersion === null && info.latestVersion !== null) {
                const def = this.definitions.find((d) => d.name === info.name);
                if (def?.requiresLauncher && !launcherAvail) {
                    log.info(`Skipping auto-install of ${info.name} in dev mode (no launcher)`);
                    continue;
                }
                log.info(`First-run: auto-installing ${info.name}`);
                await this.update(info.name);
            }
        }
    }

    /**
     * v0.1.9: copy the bundled scrcpy-server seed to <deps>/scrcpy-server/.
     * Used by autoInstallMissing on first run so an offline / no-internet
     * machine still has a working scrcpy-server. The seed is staged into
     * the installer payload at build time (alongside seed/node/), so
     * Velopack ships it; subsequent updater fetches replace this copy
     * with whatever Genymobile released.
     *
     * v0.1.10: seed-path fix. The Velopack production layout is:
     *   <installRoot>/current/                    (Velopack-managed image)
     *     ws-scrcpy-web-launcher.exe
     *     dist/                                   (__dirname of this bundle)
     *     seed/scrcpy-server/scrcpy-server        (where vpk packs the seed)
     *   <installRoot>/dependencies/               (depsPath, sibling of current/)
     *
     * v0.1.9 used `path.dirname(depsPath)` = `<installRoot>` and looked at
     * `<installRoot>/seed/...` — which doesn't exist. The seed actually
     * lives at `<installRoot>/current/seed/...`. Fixing by anchoring at
     * __dirname (always `<image>/dist/`), so `__dirname/..` is the image
     * root that contains seed/. This mirrors the Rust launcher's
     * `exe_dir.join("seed")` resolution for seed/node.
     */
    private promoteSeedScrcpyServer(): void {
        const destDir = path.join(this.depsPath, 'scrcpy-server');
        const destFile = path.join(destDir, 'scrcpy-server');
        if (fs.existsSync(destFile)) {
            return; // already promoted or updater-installed
        }
        const seedFile = path.join(__dirname, '..', 'seed', 'scrcpy-server', 'scrcpy-server');
        if (!fs.existsSync(seedFile)) {
            return; // no seed available — autoInstallMissing will fall through to network download
        }
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(seedFile, destFile);
        log.info(`promoted seed scrcpy-server → ${destFile}`);
    }

    public requestRestart(): void {
        fs.writeFileSync(this.restartMarkerPath, `restart-requested-${Date.now()}`);
        log.info(`Restart requested; writing marker at ${this.restartMarkerPath} and exiting with code 75`);
        process.exit(75);
    }

    private resolveStatus(info: DependencyInfo): void {
        if (info.installedVersion === null) {
            info.status = DependencyStatus.Unknown;
            return;
        }
        if (info.latestVersion === null) {
            info.status = DependencyStatus.Unknown;
            return;
        }
        const cmp = compareVersions(info.installedVersion, info.latestVersion);
        if (cmp > 0) {
            // Never auto-downgrade: filter (e.g. Option D prebuilt gating) can
            // report a "latest" older than what the user has. Leave them alone.
            info.status = DependencyStatus.UpToDate;
            info.errorMessage = undefined;
            log.info(
                `Installed ${info.name} ${info.installedVersion} is newer than filtered latest ` +
                    `${info.latestVersion}; staying put`,
            );
            return;
        }
        info.status = cmp === 0 ? DependencyStatus.UpToDate : DependencyStatus.UpdateAvailable;
        info.errorMessage = undefined;
    }

    private async download(url: string, destPath: string): Promise<void> {
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Download failed: HTTP ${res.status} from ${url}`);
        }
        if (!res.body) {
            throw new Error('Download failed: empty response body');
        }
        const fileStream = fs.createWriteStream(destPath);
        // Convert web ReadableStream to Node writable via pipeline
        await pipeline(res.body as unknown as NodeJS.ReadableStream, fileStream as unknown as Writable);
    }

    private async install(
        name: string,
        _def: DependencyDefinition,
        downloadPath: string,
        version: string,
        tmpDir: string,
    ): Promise<void> {
        const platform = getPlatform();

        switch (name) {
            case 'nodejs':
                await this.installNodejs(downloadPath, version, tmpDir, platform);
                break;
            case 'adb':
                await this.installAdb(downloadPath, tmpDir, platform);
                break;
            case 'scrcpy-server':
                await this.installScrcpyServer(downloadPath, version);
                break;
            default:
                throw new Error(`No install handler for: ${name}`);
        }
    }

    private async installNodejs(
        downloadPath: string,
        _version: string,
        tmpDir: string,
        platform: 'win32' | 'linux',
    ): Promise<void> {
        const destDir = path.join(this.depsPath, 'node');
        fs.mkdirSync(destDir, { recursive: true });

        // 1. Non-destructive: extract to tmpDir (both platforms).
        if (platform === 'win32') {
            await this.extractZip(downloadPath, tmpDir, platform);
        } else {
            await execFileAsync('tar', ['xzf', downloadPath, '-C', tmpDir]);
        }
        const archiveDir = fs.readdirSync(tmpDir).find((d) => d.startsWith('node-v'));
        if (!archiveDir) {
            throw new Error('Could not find Node.js directory in extracted archive');
        }
        const extractedPath = path.join(tmpDir, archiveDir);

        // 2. Destructive (Windows only): rename + copy with rollback.
        if (platform === 'win32') {
            const runningExe = path.join(destDir, 'node.exe');
            const oldExe = path.join(destDir, 'node.exe.old');
            let renamed = false;
            if (fs.existsSync(runningExe)) {
                try {
                    fs.renameSync(runningExe, oldExe);
                    renamed = true;
                } catch {
                    // May fail if not the managed node — proceed without rollback safety net.
                }
            }
            try {
                this.copyDirContents(extractedPath, destDir);
            } catch (err) {
                if (renamed && !fs.existsSync(runningExe)) {
                    try {
                        fs.renameSync(oldExe, runningExe);
                    } catch {
                        // Best-effort rollback. Original error bubbles up regardless.
                    }
                }
                throw err;
            }
            if (renamed) {
                try {
                    fs.unlinkSync(oldExe);
                } catch {
                    /* best-effort cleanup */
                }
            }
        } else {
            this.copyDirContents(extractedPath, destDir);
        }
    }

    private async installAdb(downloadPath: string, tmpDir: string, platform: 'win32' | 'linux'): Promise<void> {
        const destDir = path.join(this.depsPath, 'adb');
        fs.mkdirSync(destDir, { recursive: true });

        // Stop ADB server before replacing files
        const ext = platform === 'win32' ? '.exe' : '';
        const adbExe = path.join(destDir, `adb${ext}`);
        if (fs.existsSync(adbExe)) {
            try {
                await execFileAsync(adbExe, ['kill-server'], { timeout: 5000 });
            } catch {
                // ADB may not be running
            }
        }

        // 1. Non-destructive: extract to tmpDir.
        await this.extractZip(downloadPath, tmpDir, platform);

        const platformToolsDir = path.join(tmpDir, 'platform-tools');
        if (!fs.existsSync(platformToolsDir)) {
            throw new Error('Could not find platform-tools directory in extracted archive');
        }

        // 2. Destructive (Windows only): rename + copy with rollback.
        if (platform === 'win32') {
            const oldExe = path.join(destDir, 'adb.exe.old');
            let renamed = false;
            if (fs.existsSync(adbExe)) {
                try {
                    fs.renameSync(adbExe, oldExe);
                    renamed = true;
                } catch {
                    // May fail if adb server didn't fully stop — proceed without rollback safety net.
                }
            }
            try {
                this.copyDirContents(platformToolsDir, destDir);
            } catch (err) {
                if (renamed && !fs.existsSync(adbExe)) {
                    try {
                        fs.renameSync(oldExe, adbExe);
                    } catch {
                        // Best-effort rollback.
                    }
                }
                throw err;
            }
            if (renamed) {
                try {
                    fs.unlinkSync(oldExe);
                } catch {
                    /* best-effort cleanup */
                }
            }
        } else {
            this.copyDirContents(platformToolsDir, destDir);
        }
    }

    private async installScrcpyServer(downloadPath: string, version: string): Promise<void> {
        // scrcpy-server is a direct binary download (no archive)
        const destDir = path.join(this.depsPath, 'scrcpy-server');
        fs.mkdirSync(destDir, { recursive: true });
        const destFile = path.join(destDir, 'scrcpy-server');
        fs.copyFileSync(downloadPath, destFile);
        // Persist the installed version so checkInstalled can report it back
        // accurately on subsequent calls. Without this, the bundled
        // SERVER_VERSION constant would be returned for any updater-installed
        // version, producing a "perpetual Update available" UI loop.
        writeInstalledScrcpyServerVersion(this.depsPath, version);
    }

    private async extractZip(zipPath: string, destDir: string, _platform: 'win32' | 'linux'): Promise<void> {
        // Cross-platform: shell out to the launcher's --unzip subcommand
        // (pure-Rust zip crate). Replaces the prior PowerShell Expand-Archive
        // (win32) + system `unzip` (linux) shellouts that resolved binaries
        // via system PATH — local-dependencies-only violations
        // that §30 missed because §30's scope was the elevation path only.
        // The launcher binary is SHA-pinned-to-release and ships in
        // `current/` alongside this Node process, so no external binary
        // discovery is needed.
        if (!(await launcherIsAvailable())) {
            throw new Error(
                `extractZip requires the packaged launcher binary at ${resolveLauncherPath()}. ` +
                    'Dev mode should populate dependencies/ via scripts/fetch-node.mjs (Node) or ' +
                    `by pre-seeding from a prior install; the dependency-manager's autoInstall ` +
                    'extractZip path is intended for Velopack-installed deployments only.',
            );
        }
        await execFileAsync(resolveLauncherPath(), ['--unzip', zipPath, destDir], {
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });
    }

    private copyDirContents(src: string, dest: string): void {
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                fs.mkdirSync(destPath, { recursive: true });
                this.copyDirContents(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
                // Preserve executable permissions on Linux
                if (getPlatform() !== 'win32') {
                    try {
                        const stat = fs.statSync(srcPath);
                        fs.chmodSync(destPath, stat.mode);
                    } catch {
                        // Best effort
                    }
                }
            }
        }
    }
}
