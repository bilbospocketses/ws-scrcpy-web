import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import type { DependencyInfo, UpdateResult } from '../common/DependencyTypes';
import { compareVersions, DependencyStatus } from '../common/DependencyTypes';
import type { DependencyDefinition } from './DependencyDefinitions';
import {
    getDependencyDefinitions,
    getPlatform,
    MKCERT_SHA256SUMS_PIN,
    mkcertAssetName,
    mkcertChecksumsUrl,
    mkcertExeName,
} from './DependencyDefinitions';
import { Logger } from './Logger';
import { parseSha256Sums } from './linuxUpdateAssets';
import { writeInstalledScrcpyServerVersion } from './scrcpyServerVersion';
import { resolveSystemTool } from './service/systemTools';
import { copyFileAtomic, copyFileAtomicSync, writeFileAtomicSync } from './util/atomicFile';
import { fetchWithRetry, HttpStatusError, VERSION_CHECK_POLICY } from './util/fetchWithRetry';
import { verifySha256 } from './verifySha256';
import { extractZipTo } from './zipExtract';

const log = Logger.for('DependencyManager');
const execFileAsync = promisify(execFile);

/**
 * A per-call unique scratch directory for `update(name)`. Exported for
 * direct unit testing (N7): this was keyed on `Date.now()` alone, so two
 * concurrent `update()` calls for the SAME name -- e.g. a double-click on
 * "generate" both finding mkcert missing and racing into
 * `ensureMkcertInstalled` -- could produce it identically, since Node's
 * clock resolution is coarser than its event loop. Two calls sharing a
 * tmpDir means one's download/verify can race the other's `using`-scoped
 * cleanup, and the failure that produces is indistinguishable from a
 * genuine checksum mismatch -- the one error message that should mean
 * tampering. `randomUUID()` has no such collision window.
 */
export function makeUpdateTmpDir(name: string): string {
    return path.join(os.tmpdir(), 'ws-scrcpy-web', `update-${name}-${randomUUID()}`);
}

export class DependencyManager {
    private readonly definitions: DependencyDefinition[];
    private readonly state: Map<string, DependencyInfo>;
    private readonly restartMarkerPath: string;
    /**
     * Names whose last `checkLatest` was REFUSED by the server (an HTTP status)
     * rather than failing to reach it. Only these may fall back to a bundled
     * version — see the note in `autoInstallMissing`. Deliberately not part of
     * `DependencyInfo`: it is an internal diagnosis, not something the wire
     * format or the UI has any use for.
     */
    private readonly lookupRefused = new Set<string>();
    /**
     * In-flight `update()` calls, keyed on dependency name (NF-5).
     *
     * N7 gave each concurrent `update('mkcert')` its own tmpDir, which removed
     * the spurious "checksum mismatch" -- but nothing serialized the two, so
     * both still walked all the way to `copyFileAtomicSync` against the SAME
     * destination. On Windows a `renameSync` over a path another request is
     * mid-placement can still `EPERM`, so the class was narrowed rather than
     * removed. Coalescing removes it: the second caller awaits the first
     * caller's promise instead of performing a second install.
     *
     * Keyed on name, not global -- installing adb while mkcert installs is
     * genuinely independent work and must stay parallel. The entry is deleted
     * in a `finally`, so a rejected install does not poison the name for the
     * life of the process; the next caller retries from scratch.
     */
    private readonly inFlightUpdates = new Map<string, Promise<UpdateResult>>();

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
        // In-place mutation: callers (incl. getByName) hold references to state
        // entries and mutate them; spread copies would orphan those mutations.
        for (const info of this.state.values()) {
            // Every dependency is updatable everywhere the server runs. This was
            // gated on the packaged launcher being present, because extraction
            // shelled out to it; extraction is in-process now, so the gate is
            // gone. The field stays on the wire — the panel reads it, and a future
            // dependency may genuinely need gating (a Docker-mode pin, say).
            info.canUpdate = true;
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
            this.lookupRefused.delete(name);
            this.resolveStatus(info);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Refused (the server answered with a status) vs unreachable (no
            // answer). Only the former earns a fallback install.
            if (err instanceof HttpStatusError) {
                this.lookupRefused.add(name);
            } else {
                this.lookupRefused.delete(name);
            }
            // A failed LATEST check is only an error when there is nothing
            // installed. That is the item-124 case: we cannot learn what to
            // install, so autoInstallMissing will skip this dependency and the
            // user must be told rather than left with a silent no-op.
            //
            // When the dependency IS installed, it works — the seeded
            // scrcpy-server in the Docker image is the everyday example. All we
            // failed to learn is whether a newer version exists, which is
            // advisory. Marking a present, usable dependency `Error` because
            // api.github.com rate-limited us is a false alarm, and it broke
            // smoke 20.9/20.12 on 2026-09-09 by asserting a healthy container
            // was faulty. `resolveStatus` reports Unknown for a null
            // latestVersion, which is the honest state.
            info.latestVersion = null;
            if (info.installedVersion === null) {
                info.status = DependencyStatus.Error;
                info.errorMessage = message;
                log.warn(`Latest-version check failed for ${name} (not installed): ${message}`);
            } else {
                this.resolveStatus(info);
                info.errorMessage = undefined;
                log.info(
                    `Latest-version check failed for ${name}; keeping installed ${info.installedVersion}: ${message}`,
                );
            }
        }
    }

    public async checkAll(): Promise<void> {
        for (const def of this.definitions) {
            await this.checkInstalled(def.name);
        }
        // CONCURRENT, deliberately. Boot is `checkAll().then(() =>
        // autoInstallMissing())`, and the seed promote plus every install lives
        // inside autoInstallMissing — so this phase gates the entire hydrate.
        // Run serially, three unreachable endpoints cost the SUM of their
        // budgets; run together, the worst case is the slowest single one. Each
        // checkLatest touches only its own info, so there is nothing to race.
        await Promise.all(this.definitions.map((def) => this.checkLatest(def.name)));
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

    /**
     * NF-5: one install per dependency name at a time. Two callers that
     * arrive together (the realistic case being a double-click on "generate",
     * both finding mkcert missing and both entering `ensureMkcertInstalled`)
     * share ONE install and one result, rather than racing each other's
     * writes to the same destination file.
     *
     * Deliberately not `async`: returning the stored promise directly means
     * the second caller observes the first's settlement, whereas an `async`
     * wrapper would add a tick without changing the outcome. The
     * `UpdateResult` is a plain data object and both callers only read it.
     */
    public update(name: string): Promise<UpdateResult> {
        const existing = this.inFlightUpdates.get(name);
        if (existing) return existing;
        const started = this.performUpdate(name).finally(() => {
            this.inFlightUpdates.delete(name);
        });
        this.inFlightUpdates.set(name, started);
        return started;
    }

    private async performUpdate(name: string): Promise<UpdateResult> {
        const def = this.definitions.find((d) => d.name === name);
        const info = this.state.get(name);
        if (!def || !info) {
            return { success: false, errorMessage: `Unknown dependency: ${name}`, requiresRestart: false };
        }
        info.status = DependencyStatus.Updating;
        const fromVersion = info.installedVersion ?? 'not installed';
        const tmpDir = makeUpdateTmpDir(name);
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
            // Ensure latest version is known. `checkLatest` THROWS on a non-OK
            // response (items 124/125), so the catch is what lets a definition
            // with a fallbackVersion still install while the lookup is refused —
            // without it, a rate-limited api.github.com turns a perfectly
            // installable scrcpy-server into an update failure.
            if (!info.latestVersion) {
                try {
                    info.latestVersion = await def.checkLatest();
                } catch (err) {
                    // Same rule as autoInstallMissing: a refused lookup may fall
                    // back, an unreachable one may not.
                    if (!def.fallbackVersion || !(err instanceof HttpStatusError)) {
                        throw err;
                    }
                    const why = err instanceof Error ? err.message : String(err);
                    log.warn(`Latest-version lookup failed for ${name} (${why}); using bundled ${def.fallbackVersion}`);
                }
            }

            // The fallback is used for the DOWNLOAD but deliberately not written
            // to info.latestVersion: we still do not know what the latest is, and
            // claiming otherwise would show a false "up to date" in the panel.
            const version = info.latestVersion ?? def.fallbackVersion;
            if (!version) {
                throw new Error('Could not determine latest version');
            }

            log.info(`Updating ${name}: ${fromVersion} → ${version}`);

            const url = def.getDownloadUrl(version);

            // Create temp directory
            fs.mkdirSync(tmpDir, { recursive: true });

            // I8 (pinned-manifest extension): for mkcert, fetch and pin-check
            // the SHA256SUMS manifest BEFORE downloading the binary at all --
            // "no download of anything else" on a manifest that doesn't match
            // MKCERT_SHA256SUMS_PIN. Fetching the manifest first, rather than
            // after the binary as the original checksum design did, is what
            // makes that possible: a tampered release could otherwise alter
            // the binary and its own manifest together, so checking the
            // binary against a manifest from the same untrusted release never
            // proved anything a corrupted-download check didn't already.
            const mkcertManifest = name === 'mkcert' ? await this.fetchPinnedMkcertManifest(version) : undefined;

            // Download
            const fileName = url.split('/').pop() || `${name}-download`;
            const downloadPath = path.join(tmpDir, fileName);
            await this.download(url, downloadPath);

            // Extract / install
            await this.install(name, def, downloadPath, version, tmpDir, mkcertManifest);

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

        for (const info of this.state.values()) {
            // A first-run install must not be hostage to a version LOOKUP.
            // scrcpy-server's goes through api.github.com, which rate-limits per
            // IP at 60/hour unauthenticated — and on a rate-limited runner this
            // loop installed nothing and said nothing, which is smoke 9.4's 120s
            // poll on 2026-09-09. Installing the version this build already ships
            // beats installing none.
            //
            // Gated on the lookup having been REFUSED rather than merely absent.
            // A refused lookup says nothing about whether release assets are
            // reachable, so the download is worth trying. On a genuinely offline
            // host the download would fail too, and attempting it only burns the
            // retry budget while the status reads `Updating` — which is what
            // smoke 1.9 asserts is `error`.
            const def = this.definitions.find((d) => d.name === info.name);
            // M2: mkcert opts out of the boot-time download entirely (see
            // `deferInstall`'s own doc comment on the definition) -- it is
            // fetched on first use instead, from `createCertService.ts`'s
            // lazy-install wrapper around `run`. checkInstalled/checkLatest
            // above already ran for it, so the panel still shows accurate
            // status; only the network fetch of the ~4.5 MB binary is skipped
            // here.
            if (def?.deferInstall) {
                continue;
            }
            const mayFallBack = def?.fallbackVersion !== undefined && this.lookupRefused.has(info.name);
            const target = info.latestVersion ?? (mayFallBack ? def!.fallbackVersion! : null);
            if (info.installedVersion === null && target != null) {
                // Nothing UNCONDITIONAL is skipped here any more (mkcert's
                // skip just above is a deliberate opt-out, not a launcher gate
                // — see its own comment). Node and adb used to be skipped, on
                // every platform, whenever the packaged launcher was absent —
                // which is every source checkout. On Windows that was invisible
                // (dev and MSI share %PROGRAMDATA%\WsScrcpyWeb\dependencies\, so
                // adb was usually already there); on Linux and macOS, where the
                // dev deps folder starts empty, it meant a from-source run had no
                // adb and one info-level log line to say so.
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
        copyFileAtomicSync(seedFile, destFile);
        log.info(`promoted seed scrcpy-server → ${destFile}`);
    }

    public requestRestart(): void {
        writeFileAtomicSync(this.restartMarkerPath, `restart-requested-${Date.now()}`);
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
        // `timeoutMs: null` deliberately. This streams the payload — the Node
        // archive is ~110 MB — and `AbortSignal.timeout` aborts the whole
        // exchange, body included, so any per-attempt deadline would kill a
        // legitimately slow download mid-stream. Retry alone here.
        const res = await fetchWithRetry(url, {
            timeoutMs: null,
            onRetry: (n) => log.warn(`download ${n.attempt}/${n.attempts} for ${n.url}: ${n.reason}`),
        });
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
        mkcertManifest?: string,
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
            case 'mkcert':
                // update() always fetches and pin-verifies the manifest
                // BEFORE calling install() for mkcert -- see its own call
                // site -- so this is never undefined on this branch.
                await this.installMkcert(downloadPath, version, mkcertManifest!);
                break;
            default:
                throw new Error(`No install handler for: ${name}`);
        }
    }

    /**
     * I8: mkcert mints a CA the user then installs into their OS and phone
     * trust stores, so a tampered download does not just break the app -- it
     * becomes a trusted signing authority on every device the user set up.
     * That is the highest-consequence binary this app fetches, which is why
     * it is the one singled out for verification among the FOUR dependencies
     * this class manages: nodejs/adb/scrcpy-server check no hash at all today.
     * (`UpdateService`'s Linux self-update AppImage does, via the same
     * `parseSha256Sums`/`verifySha256` pair reused below -- that is a
     * different subsystem, but it is the existing pattern this follows
     * rather than inventing a second one.) Verification runs BEFORE the file
     * is copied anywhere `resolveMkcertExe` would find it; a mismatch
     * throws, `update()`'s catch records the failure, and the
     * `using`-scoped tmpDir cleanup in `update()` removes the unverified
     * download. Nothing partially-verified is ever installed.
     *
     * `manifest` arrives ALREADY pin-verified by `fetchPinnedMkcertManifest`
     * -- this method only checks the downloaded binary against it.
     */
    private async installMkcert(downloadPath: string, version: string, manifest: string): Promise<void> {
        await this.verifyMkcertBinaryAgainstManifest(downloadPath, version, manifest);

        const destDir = path.join(this.depsPath, 'mkcert');
        fs.mkdirSync(destDir, { recursive: true });
        const destFile = path.join(destDir, mkcertExeName());
        copyFileAtomicSync(downloadPath, destFile);
        if (getPlatform() !== 'win32') {
            await fs.promises.chmod(destFile, 0o755);
        }
    }

    /**
     * Fetches the release's SHA256SUMS manifest and checks the MANIFEST
     * ITSELF against `MKCERT_SHA256SUMS_PIN` -- see that constant's own doc
     * comment for why. Called from `update()` BEFORE the binary is
     * downloaded at all: "no download of anything else" on a manifest that
     * doesn't match the pin, per the user's decision this implements.
     *
     * Deliberately a DIFFERENT thrown message than
     * `verifyMkcertBinaryAgainstManifest`'s: "the manifest doesn't match its
     * pin" means the release changed under us (or the pin is stale after a
     * version bump) -- a maintenance signal -- while "the binary doesn't
     * match the manifest" means a bad download or a same-release tamper. A
     * single generic message would make a stale pin look identical to an
     * active attack.
     */
    private async fetchPinnedMkcertManifest(version: string): Promise<string> {
        const checksumsUrl = mkcertChecksumsUrl(version);
        const res = await fetchWithRetry(checksumsUrl, {
            ...VERSION_CHECK_POLICY,
            onRetry: (n) => log.warn(`mkcert checksum manifest fetch ${n.attempt}/${n.attempts}: ${n.reason}`),
        });
        if (!res.ok) {
            throw new Error(`mkcert checksum manifest fetch failed: HTTP ${res.status} from ${checksumsUrl}`);
        }
        const manifest = await res.text();
        const manifestHash = createHash('sha256').update(manifest).digest('hex');
        if (manifestHash !== MKCERT_SHA256SUMS_PIN) {
            throw new Error(
                'mkcert checksum manifest itself does not match the pinned digest ' +
                    `(expected ${MKCERT_SHA256SUMS_PIN}, got ${manifestHash}) -- the release may have changed, ` +
                    'or MKCERT_SHA256SUMS_PIN is stale after a version bump; refusing to trust it either way',
            );
        }
        return manifest;
    }

    /**
     * Checks the just-downloaded asset against an ALREADY pin-verified
     * manifest (see `fetchPinnedMkcertManifest`). Throws on ANY failure to
     * verify -- an asset the manifest does not list, or a hash mismatch --
     * because a binary that fails verification must never be executed. This
     * is deliberately fail-closed: there is no "warn and continue" path.
     *
     * NOT a build-provenance/attestation check. The spec asks for one; the
     * user's decision (recorded, not mine to revisit here) is that a
     * pinned-manifest checksum is the implemented control instead. Prior
     * reasoning against a hand-rolled Sigstore verifier still applies: no
     * Node builtin for it, and `gh attestation verify` is a PATH-resolved
     * binary Local-Dependencies-Only forbids.
     */
    private async verifyMkcertBinaryAgainstManifest(
        downloadPath: string,
        version: string,
        manifest: string,
    ): Promise<void> {
        const assetName = mkcertAssetName(version);
        // Reused from linuxUpdateAssets.ts / verifySha256.ts, the pair
        // UpdateService already uses to verify the Linux self-update
        // AppImage against its own SHA256SUMS -- the one existing pattern in
        // this codebase for "check a downloaded asset's hash before trusting
        // it", so this does not invent a second one.
        const expected = parseSha256Sums(manifest, assetName);
        if (!expected) {
            throw new Error(
                `mkcert checksum manifest does not list ${assetName} -- refusing to install an unverified binary`,
            );
        }
        const ok = await verifySha256(downloadPath, expected);
        if (!ok) {
            throw new Error(
                `mkcert checksum mismatch for ${assetName} (expected ${expected}) -- refusing to install a binary ` +
                    'that mints trust material without a verified hash',
            );
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
            await this.extractZip(downloadPath, tmpDir);
        } else {
            // Absolute path via resolveSystemTool -- never the bare name, which would
            // resolve through $PATH (Local-Dependencies-Only).
            await execFileAsync(resolveSystemTool('tar'), ['xzf', downloadPath, '-C', tmpDir]);
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
                await this.copyDirContents(extractedPath, destDir);
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
            await this.copyDirContents(extractedPath, destDir);
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
        await this.extractZip(downloadPath, tmpDir);

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
                await this.copyDirContents(platformToolsDir, destDir);
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
            await this.copyDirContents(platformToolsDir, destDir);
        }
    }

    private async installScrcpyServer(downloadPath: string, version: string): Promise<void> {
        // scrcpy-server is a direct binary download (no archive)
        const destDir = path.join(this.depsPath, 'scrcpy-server');
        fs.mkdirSync(destDir, { recursive: true });
        const destFile = path.join(destDir, 'scrcpy-server');
        copyFileAtomicSync(downloadPath, destFile);
        // Persist the installed version so checkInstalled can report it back
        // accurately on subsequent calls. Without this, the bundled
        // SERVER_VERSION constant would be returned for any updater-installed
        // version, producing a "perpetual Update available" UI loop.
        writeInstalledScrcpyServerVersion(this.depsPath, version);
    }

    private async extractZip(zipPath: string, destDir: string): Promise<void> {
        // In-process, pure JS (src/server/zipExtract.ts). No PATH lookup and no
        // external binary, so this satisfies Local-Dependencies-Only the same way
        // `ws` does — compiled into the app's own artifact.
        //
        // History worth not repeating: this was PowerShell `Expand-Archive` /
        // system `unzip` (PATH-resolved — the violation), then the Rust
        // launcher's `--unzip` subcommand (no PATH, but the launcher only exists
        // in a packaged install, so `autoInstallMissing` silently skipped adb and
        // Node in every source checkout). Extracting in-process is the first
        // version that is both PATH-free and available everywhere the server runs
        // — including a Docker image, which would otherwise have needed a Rust
        // build stage purely to unzip.
        await extractZipTo(zipPath, destDir);
    }

    /**
     * Async on purpose, and it must stay that way. This runs during the
     * first-run install while the server is serving requests, and the Node
     * tree it copies is ~2,500 files / ~110 MB. The synchronous version parked
     * every in-flight request behind it — a 4-second `/api/config` measured on
     * a fast NVMe box, past 10 s on a CI runner (the auth suite's "flaky" 18.11
     * was a reloaded page whose `/api/settings` never got an answer). Each step
     * goes through `fs.promises`, so the loop turns between files
     * (dependencyManager.eventLoop.test.ts pins that).
     */
    private async copyDirContents(src: string, dest: string): Promise<void> {
        const entries = await fs.promises.readdir(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                await fs.promises.mkdir(destPath, { recursive: true });
                await this.copyDirContents(srcPath, destPath);
            } else {
                await copyFileAtomic(srcPath, destPath);
                // Preserve executable permissions on Linux
                if (getPlatform() !== 'win32') {
                    try {
                        const stat = await fs.promises.stat(srcPath);
                        await fs.promises.chmod(destPath, stat.mode);
                    } catch {
                        // Best effort
                    }
                }
            }
        }
    }
}

let depManagerInstance: DependencyManager | undefined;
let depManagerOpts: { dependenciesPath: string; restartMarkerPath?: string } | undefined;

/**
 * Composition-root singleton, mirroring `createCertService.ts`'s
 * `getCertService()`. `index.ts`'s boot sequence and mkcert's on-demand,
 * first-use install (M2 — `createCertService.ts`'s lazy-install wrapper
 * around `run`) must share the SAME manager instance and the SAME in-memory
 * `state`/`lookupRefused`: a second, independently-constructed
 * `DependencyManager` would track mkcert's install status separately from
 * the one `DependencyApi` and the dependency panel read, so a lazy install
 * triggered by a certificate generate() click would leave the panel showing
 * "not installed" forever after.
 *
 * N6: a second call with DIFFERENT options used to be silently ignored —
 * the caller got back a manager configured for whoever called first, with
 * no way to notice. Safe only because boot always precedes any request,
 * which is an accident of ordering, not a guarantee. A mismatched second
 * call now throws instead of returning a manager quietly configured
 * differently from what that caller asked for.
 */
export function getDependencyManager(opts: {
    dependenciesPath: string;
    restartMarkerPath?: string;
}): DependencyManager {
    if (!depManagerInstance) {
        depManagerOpts = opts;
        depManagerInstance = new DependencyManager(opts.dependenciesPath, {
            ...(opts.restartMarkerPath !== undefined ? { restartMarkerPath: opts.restartMarkerPath } : {}),
        });
        return depManagerInstance;
    }
    if (
        opts.dependenciesPath !== depManagerOpts!.dependenciesPath ||
        opts.restartMarkerPath !== depManagerOpts!.restartMarkerPath
    ) {
        throw new Error(
            'getDependencyManager() was already initialized with a different configuration ' +
                `(dependenciesPath: ${depManagerOpts!.dependenciesPath}); ` +
                `refusing to silently hand a caller expecting ${opts.dependenciesPath} a manager it did not ask for`,
        );
    }
    return depManagerInstance;
}
