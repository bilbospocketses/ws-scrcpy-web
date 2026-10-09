import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import { SERVER_JAR_SHA256, SERVER_VERSION } from '../common/Constants';
import type { DependencyInfo, LatestLookup, UpdateResult } from '../common/DependencyTypes';
import { compareVersions, DependencyStatus } from '../common/DependencyTypes';
import {
    type AuthenticodeChecker,
    defaultAuthenticodeChecker,
    verifyPlatformToolsAuthenticode,
} from './adbAuthenticode';
import type { DependencyDefinition } from './DependencyDefinitions';
import {
    ADB_REPOSITORY_XML_URL,
    adbArchiveName,
    getDependencyDefinitions,
    getPlatform,
    mkcertAssetName,
    mkcertChecksumsUrl,
    mkcertExeName,
    NODE_DIST_BASE_ENV,
    nodeChecksumsSignatureUrl,
    nodeChecksumsUrl,
    nodeDistBase,
    parseAdbArchive,
    scrcpyServerAssetName,
    scrcpyServerChecksumsSignatureUrl,
    scrcpyServerChecksumsUrl,
} from './DependencyDefinitions';
import { Logger } from './Logger';
import { parseSha256Sums } from './linuxUpdateAssets';
import { liveStreams } from './liveStreams';
import { defaultMkcertProvenanceDeps, MKCERT_URL_BASE_ENV, verifyMkcertManifestProvenance } from './mkcertProvenance';
import { NODE_RELEASE_KEYS, SCRCPY_RELEASE_KEYS } from './release-keys/pinnedReleaseKeys';
import {
    readScrcpyServerVersionMarker,
    removeScrcpyServerVersionMarker,
    scrcpyServerVersionForSha256,
    writeInstalledScrcpyServerVersion,
} from './scrcpyServerVersion';
import { resolveSystemTool } from './service/systemTools';
import { copyFileAtomic, copyFileAtomicSync, rmTreeSyncWithRetry, writeFileAtomicSync } from './util/atomicFile';
import { fetchWithRetry, HttpStatusError, VERSION_CHECK_POLICY } from './util/fetchWithRetry';
import { ensureRootOwnedTreeIfRoot } from './util/rootOwnedTree';
import { tarExtractArgs } from './util/tarExtract';
import { type ReleaseKeySet, ReleaseSignatureError, verifyDetachedSignature } from './verifyOpenPgp';
import { sha256FileSync, verifySha1, verifySha256 } from './verifySha256';
import { extractZipTo } from './zipExtract';

const log = Logger.for('DependencyManager');
const execFileAsync = promisify(execFile);

/** The publisher keys a hash list must be signed by (M5), per dependency that has one. */
export interface DependencyReleaseKeys {
    nodejs: ReleaseKeySet;
    scrcpyServer: ReleaseKeySet;
}

/**
 * The keys pinned in this repo. Production has no other: `DependencyManager`'s
 * `releaseKeys` option is a constructor argument that only tests pass, and no
 * environment variable or config field reaches it, so a mirror set through
 * `WS_SCRCPY_NODE_DIST_BASE` must still serve lists Node's own keys signed.
 */
export const PINNED_RELEASE_KEYS: DependencyReleaseKeys = {
    nodejs: { label: 'Node.js', keys: NODE_RELEASE_KEYS },
    scrcpyServer: { label: 'scrcpy', keys: SCRCPY_RELEASE_KEYS },
};

/**
 * A test seam: exactly '1' makes the BOOT pass (`checkAll({ boot: true })`)
 * skip the latest-version lookup for every dependency that is already
 * installed. A dependency that is not installed is still looked up -- its
 * install needs the answer -- and check-for-updates and `update()` are never
 * affected. The fast e2e tier sets it: every server boot otherwise spent 2-3 of
 * api.github.com's 60 unauthenticated calls an hour on lookups nothing read.
 */
export const SKIP_BOOT_LATEST_ENV = 'WS_SCRCPY_SKIP_BOOT_LATEST';

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
 *
 * The directory sits DIRECTLY under the OS temp dir, with no shared parent.
 * It used to be `<tmp>/ws-scrcpy-web/update-…`, and on Linux that parent is
 * one per machine: whichever user ran the app first created it with their
 * umask (775), so every other user's `mkdir` inside it failed with EACCES and
 * their first-run dependency installs all failed (qa-harness arc L1, beta.140).
 * `performUpdate` creates it with mode 0700, and without `recursive`, so a path
 * that already exists is an error rather than something we silently reuse.
 */
export function makeUpdateTmpDir(name: string): string {
    return path.join(os.tmpdir(), `ws-scrcpy-web-update-${name}-${randomUUID()}`);
}

export class DependencyManager {
    private readonly definitions: DependencyDefinition[];
    private readonly state: Map<string, DependencyInfo>;
    private readonly restartMarkerPath: string;
    /**
     * Names whose last `checkLatest` was REFUSED by the server (an HTTP status)
     * rather than failing to reach it. Only these may fall back to a bundled
     * version — see the note in `autoInstallMissing`. The wire carries the same
     * refused-vs-unreachable distinction, per lookup, as
     * `DependencyInfo.latestLookup`; this set is the gate the fallback reads,
     * and stays internal.
     */
    private readonly lookupRefused = new Set<string>();
    /**
     * Per dependency, how many latest-version lookups this process has STARTED
     * -- the source of `LatestLookup.seq`. Counted at the start rather than read
     * back from `info.latestLookup` at the end, so two lookups in flight together
     * (a check-for-updates racing an update's own lookup) never share a number.
     */
    private readonly lookupSeq = new Map<string, number>();
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
    /** Throws unless the mkcert checksum manifest is attested -- see `mkcertProvenance.ts`. */
    private readonly verifyMkcertManifest: (manifest: string, tag: string) => Promise<void>;
    /** Who must have signed Node's and scrcpy's hash lists -- see `PINNED_RELEASE_KEYS`. */
    private readonly releaseKeys: DependencyReleaseKeys;
    /** Windows only: the Authenticode check on every downloaded platform-tools binary -- see `adbAuthenticode.ts`. */
    private readonly checkAuthenticode: AuthenticodeChecker;
    /**
     * Config.dockerMode. In a container the image owns scrcpy-server: updates
     * are refused there ("Pull a newer image to update"), so the boot repair
     * replaces a volume's jar with the image's seed whenever they differ.
     */
    private readonly inContainer: boolean;

    constructor(
        private readonly depsPath: string,
        opts: {
            restartMarkerPath?: string;
            /** A seam for tests; production always takes the default. */
            verifyMkcertManifest?: (manifest: string, tag: string) => Promise<void>;
            /**
             * A seam for tests, which sign their fixture lists with a throwaway
             * key; production always takes `PINNED_RELEASE_KEYS`.
             * `getDependencyManager` never passes it, and nothing a user can set
             * reaches it.
             */
            releaseKeys?: DependencyReleaseKeys;
            /** A seam for tests; production always takes `defaultAuthenticodeChecker`. */
            checkAuthenticode?: AuthenticodeChecker;
            /** Config.dockerMode: leave out the definitions the image provides itself. */
            inContainer?: boolean;
        } = {},
    ) {
        this.releaseKeys = opts.releaseKeys ?? PINNED_RELEASE_KEYS;
        this.inContainer = opts.inContainer === true;
        this.checkAuthenticode = opts.checkAuthenticode ?? defaultAuthenticodeChecker;
        // Default to <depsPath>/.restart preserves pre-Phase-1 behavior for
        // tests that don't care about the marker location. Production code
        // (index.ts) passes the explicit Config.restartMarkerPath so the
        // marker lands at <dataRoot>/.restart, matching launcher/src/paths.rs:70.
        this.restartMarkerPath = opts.restartMarkerPath ?? path.join(depsPath, '.restart');
        // Sigstore's TUF cache sits beside the dependencies it vouches for.
        // Its own default is the running user's home, which for the Windows
        // service is the SYSTEM profile.
        const provenance = defaultMkcertProvenanceDeps(path.join(depsPath, '.sigstore'));
        const mkcertBase = process.env[MKCERT_URL_BASE_ENV]?.trim();
        if (mkcertBase && !opts.inContainer) {
            // Item 167: say where mkcert comes from, once, so a mirror or a test
            // fixture is never mistaken for GitHub in a support log.
            log.info(`mkcert release lookups and downloads from ${MKCERT_URL_BASE_ENV}=${mkcertBase}`);
        }
        const nodeBase = process.env[NODE_DIST_BASE_ENV]?.trim();
        if (nodeBase && !opts.inContainer) {
            // Smoke row 9.12's seam, logged the same way: a container never
            // manages Node (it is hostOnly), so there it moves nothing.
            log.info(`Node.js release index and downloads from ${NODE_DIST_BASE_ENV}=${nodeDistBase(nodeBase)}`);
        }
        this.verifyMkcertManifest =
            opts.verifyMkcertManifest ?? ((manifest, tag) => verifyMkcertManifestProvenance(manifest, tag, provenance));
        this.definitions = getDependencyDefinitions(depsPath, { inContainer: opts.inContainer === true });
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
                deferInstall: def.deferInstall,
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

    /** Fetched on first use rather than at boot (`DependencyDefinition.deferInstall`). */
    private isDeferred(name: string): boolean {
        return this.definitions.find((d) => d.name === name)?.deferInstall === true;
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
            info.latestVersion = await this.lookUpLatest(def, info);
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
            if (info.installedVersion === null && this.isDeferred(name) && err instanceof HttpStatusError) {
                // Not installed, not needed until someone asks for it, and the
                // lookup was merely REFUSED (an HTTP status: api.github.com's
                // rate limit, typically). Nothing is broken yet, so it reads
                // NotInstalled with its install button, and the Latest cell
                // names the refusal from `latestLookup`. An install retries the
                // lookup itself and reports its own failure (performUpdate).
                //
                // ONLY a refusal. Any other failure falls through to Error
                // below, with its message: above all the definition's own
                // refusal of the answer (mkcert's "unexpected mkcert release
                // tag", a provenance check), which smoke row 21.12 requires the
                // panel to show. Swallowing that as NotInstalled hid a refused
                // release behind an install button.
                this.resolveStatus(info);
                info.errorMessage = undefined;
                log.info(`Latest-version check failed for ${name} (not installed, installs on first use): ${message}`);
            } else if (info.installedVersion === null) {
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

    /**
     * Every latest-version lookup goes through here -- `checkLatest` and the one
     * inside `performUpdate` -- so each is counted and its outcome recorded on
     * `info.latestLookup` (see `LatestLookup`). Returns or throws exactly what
     * `def.checkLatest()` does; what the caller makes of that is unchanged.
     */
    private async lookUpLatest(def: DependencyDefinition, info: DependencyInfo): Promise<string | null> {
        const seq = (this.lookupSeq.get(def.name) ?? 0) + 1;
        this.lookupSeq.set(def.name, seq);
        const record = (lookup: Omit<LatestLookup, 'seq' | 'at'>): void => {
            // Two lookups in flight together can finish out of order; the record
            // always describes the newest one that has finished.
            if ((info.latestLookup?.seq ?? 0) > seq) return;
            info.latestLookup = { seq, at: new Date().toISOString(), ...lookup };
        };
        try {
            const version = await def.checkLatest();
            // A definition answers null when the reply held no version it would
            // accept (no LTS release, no tag_name): an answer, but not a version.
            record({ outcome: version !== null ? 'ok' : 'failed' });
            return version;
        } catch (err) {
            record(
                err instanceof HttpStatusError ? { outcome: 'refused', httpStatus: err.status } : { outcome: 'failed' },
            );
            throw err;
        }
    }

    /**
     * `boot` marks the pass `index.ts` runs at startup. Only that pass reads
     * `WS_SCRCPY_SKIP_BOOT_LATEST` (see `SKIP_BOOT_LATEST_ENV`), and reads it on
     * every call rather than once at construction.
     */
    public async checkAll(opts: { boot?: boolean } = {}): Promise<void> {
        for (const def of this.definitions) {
            await this.checkInstalled(def.name);
        }
        const skipInstalled = opts.boot === true && process.env[SKIP_BOOT_LATEST_ENV] === '1';
        const toLookUp = skipInstalled
            ? this.definitions.filter((def) => this.state.get(def.name)?.installedVersion === null)
            : this.definitions;
        if (toLookUp.length < this.definitions.length) {
            log.info(`boot latest-version lookups skipped for installed dependencies (${SKIP_BOOT_LATEST_ENV}=1)`);
        }
        // CONCURRENT, deliberately. Boot is `checkAll().then(() =>
        // autoInstallMissing())`, and the seed promote plus every install lives
        // inside autoInstallMissing — so this phase gates the entire hydrate.
        // Run serially, three unreachable endpoints cost the SUM of their
        // budgets; run together, the worst case is the slowest single one. Each
        // checkLatest touches only its own info, so there is nothing to race.
        await Promise.all(toLookUp.map((def) => this.checkLatest(def.name)));
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
        // Retried: the tree holds the extracted adb/Node binaries, and a
        // just-killed adb's image or a scanner reading a fresh executable keeps
        // a file locked for a moment, which a single rmSync turned into a leaked
        // ws-scrcpy-web-update-* directory. Still best-effort -- a cleanup
        // failure must not fail the update -- but no longer silent.
        using _tmpDirCleanup = {
            [Symbol.dispose](): void {
                try {
                    rmTreeSyncWithRetry(tmpDir);
                } catch (err) {
                    log.warn(`update(${name}): could not remove temp dir ${tmpDir}: ${(err as Error).message}`);
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
                    info.latestVersion = await this.lookUpLatest(def, info);
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

            // Create temp directory (private to this user; see makeUpdateTmpDir)
            fs.mkdirSync(tmpDir, { mode: 0o700 });

            // I8: for mkcert, fetch the SHA256SUMS manifest and check its
            // provenance BEFORE downloading the binary at all -- "no download
            // of anything else" on a manifest nothing vouches for. Checking
            // the binary against a manifest from the same release alone never
            // proved anything a corrupted-download check didn't already: a
            // tampered release could alter both together.
            const mkcertManifest = name === 'mkcert' ? await this.fetchAttestedMkcertManifest(version) : undefined;

            // Download
            const fileName = url.split('/').pop() || `${name}-download`;
            const downloadPath = path.join(tmpDir, fileName);
            await this.download(url, downloadPath);

            // Check the download against what its publisher lists BEFORE
            // install() runs anything -- adb's install starts by killing the
            // running adb server, so a bad archive must be refused before that.
            // Every failure throws into the catch below: nothing is installed,
            // and the `using` cleanup removes the unverified file.
            await this.verifyDownload(name, version, fileName, downloadPath);

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
        let promoted = false;
        try {
            promoted = this.promoteSeedScrcpyServer();
        } catch (err) {
            log.warn(`seed-promote scrcpy-server failed: ${(err as Error).message}`);
        }
        // Re-read what is installed once the seed has landed. checkAll() ran
        // before the promote and recorded scrcpy-server as not installed, so
        // the loop below downloaded the same version over the copy just made
        // (measured on beta.160: "promoted seed" then "Updating scrcpy-server:
        // not installed → 4.1" 0.8 s later, on every fresh volume and every
        // first run). A newer release is still offered, as an update.
        if (promoted) {
            await this.checkInstalled('scrcpy-server');
            // An offline first boot left checkLatest's "not installed" error on
            // it. Installed, a failed lookup is advisory (checkLatest's own
            // rule), so the error no longer describes this dependency.
            const scrcpy = this.state.get('scrcpy-server');
            if (scrcpy && scrcpy.installedVersion !== null) {
                scrcpy.errorMessage = undefined;
            }
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
            // fetched when the user presses **install** in the Dependencies
            // panel (0.5.1), or, as a backstop, by `createCertService.ts`'s
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
    /**
     * The copy records the version the seed's hash names in the `.version`
     * marker (`verifiedSeedScrcpyServer`). Normally that is SERVER_VERSION,
     * but a seed left over from an older build -- `npm run start:no-supervisor`
     * skips `stage-seed` -- is recorded as what it is, so the panel offers the
     * update instead of a 4.1 jar being marked 5.0 for good. A seed matching no
     * pin is refused, and the download below installs scrcpy-server instead.
     * Before 2026-10-07 the promote wrote no marker; see
     * `repairScrcpyServerVersionMarker` for the installs left that way.
     *
     * @returns true when this call copied the seed in.
     */
    private promoteSeedScrcpyServer(): boolean {
        const destFile = path.join(this.depsPath, 'scrcpy-server', 'scrcpy-server');
        if (fs.existsSync(destFile)) {
            return false; // already promoted or updater-installed
        }
        const seed = this.verifiedSeedScrcpyServer();
        if (seed === null) {
            return false; // no usable seed — autoInstallMissing will fall through to network download
        }
        this.placeScrcpyServerJar(seed.file, seed.version);
        log.info(`promoted seed scrcpy-server ${seed.version} → ${destFile}`);
        return true;
    }

    /**
     * The bundled seed and the version its SHA-256 names in SERVER_JAR_SHA256,
     * or null -- logged -- when there is no seed, it cannot be read, or its
     * hash matches no pin. Nothing is copied from a seed that has not passed
     * through here (2026-10-08): the seed directory is not the build's, it is
     * whatever was last staged into it.
     */
    private verifiedSeedScrcpyServer(): { file: string; version: string } | null {
        const file = DependencyManager.seedScrcpyServerPath();
        if (!fs.existsSync(file)) {
            return null;
        }
        let digest: string;
        try {
            digest = sha256FileSync(file);
        } catch (err) {
            log.warn(`seed scrcpy-server at ${file} could not be read; not using it: ${(err as Error).message}`);
            return null;
        }
        const version = scrcpyServerVersionForSha256(digest);
        if (version === null) {
            log.warn(
                `seed scrcpy-server at ${file} matches no pinned version (SHA-256 ${digest}); refusing to install it`,
            );
            return null;
        }
        return { file, version };
    }

    /**
     * Copies `src` in as <deps>/scrcpy-server/scrcpy-server and records
     * `version`. The old marker is deleted FIRST: a crash after the copy then
     * leaves a marker-less jar, which the boot repair and
     * `getInstalledScrcpyServerVersion` identify by its hash, instead of the new
     * jar under the old jar's marker, which nothing would ever question. The
     * copy itself is atomic (a rename), so the jar is never half-written.
     */
    private placeScrcpyServerJar(src: string, version: string): void {
        const destDir = path.join(this.depsPath, 'scrcpy-server');
        fs.mkdirSync(destDir, { recursive: true });
        removeScrcpyServerVersionMarker(this.depsPath);
        copyFileAtomicSync(src, path.join(destDir, 'scrcpy-server'));
        writeInstalledScrcpyServerVersion(this.depsPath, version);
    }

    /**
     * Gives a `<deps>/scrcpy-server/scrcpy-server` with no `.version` marker
     * one, and in a container makes the jar the image's own. Called once at
     * boot by `index.ts`, synchronously, right after the manager is built and
     * before any service starts -- so before any probe or stream reads the
     * version -- which is why it is not in `autoInstallMissing`: that runs only
     * after `checkAll`'s network lookups, by when a device may already be
     * streaming.
     *
     * Who has a marker-less jar: every install whose scrcpy-server came from
     * the seed promote before that wrote the marker (Docker's persistent
     * `/data/dependencies` included). Its version was answered by the
     * SERVER_VERSION fallback, so once an app update bumps SERVER_VERSION the
     * old jar would be started with the new version string, which the server
     * refuses ("The server version (X) does not match the client (Y)"), and the
     * panel would report the new version and offer no update.
     *
     * - Marker present, outside a container: nothing is read or written. The
     *   jar is never hashed.
     * - Jar matching a SERVER_JAR_SHA256 pin: that version is recorded. The jar
     *   keeps working, and the panel offers SERVER_VERSION as an update.
     * - In a container (2026-10-08), a jar whose marker or pin names a version
     *   other than SERVER_VERSION is replaced by the image's seed instead. The
     *   image owns scrcpy-server there: updates are refused ("Pull a newer image
     *   to update") and the panel is replaced by a note, while the promote never
     *   overwrites a jar the volume already holds -- so without this, a volume
     *   repaired to 4.1 would stay on 4.1 under every later image, and so would
     *   any volume across any later SERVER_VERSION bump.
     * - Jar matching no pin, or unreadable: the seed is copied over it and the
     *   seed's version recorded. Nothing installed it that we can name a
     *   version for, and the seed is the one jar this build is known to work
     *   with. It cannot be a newer jar from the updater: `installScrcpyServer`
     *   writes the marker in the same step as the jar, and has since 508da053
     *   (2026-05-12); one that crashed between the copy and the marker left a
     *   jar it was offered, which is capped at SERVER_VERSION and so pinned. A
     *   marker-less jar is otherwise a seed promote or an updater install from
     *   before then, and either way has been started with SERVER_VERSION ever
     *   since -- which works only for the SERVER_VERSION jar, and that one is
     *   pinned, so it lands in the case above.
     * - No usable seed (a dev tree that never ran `stage-seed`, or a seed
     *   matching no pin -- see `verifiedSeedScrcpyServer`): the jar is left
     *   alone; logged. `getInstalledScrcpyServerVersion` still identifies a
     *   pinned jar by its hash.
     *
     * Never throws: a failure here must not stop the server booting.
     */
    public repairScrcpyServerVersionMarker(): void {
        const destFile = path.join(this.depsPath, 'scrcpy-server', 'scrcpy-server');
        try {
            if (!fs.existsSync(destFile)) {
                return; // nothing installed: the promote or the download that installs it writes the marker
            }
            const marker = readScrcpyServerVersionMarker(this.depsPath);
            if (marker !== null) {
                if (this.inContainer && marker !== SERVER_VERSION) {
                    this.replaceWithImageSeed(destFile, marker);
                }
                return;
            }
            let digest: string | null = null;
            try {
                digest = sha256FileSync(destFile);
            } catch (err) {
                log.warn(
                    `scrcpy-server at ${destFile} has no version marker and could not be read: ${(err as Error).message}`,
                );
            }
            const known = digest !== null ? scrcpyServerVersionForSha256(digest) : null;
            if (known !== null) {
                if (this.inContainer && known !== SERVER_VERSION && this.replaceWithImageSeed(destFile, known)) {
                    return;
                }
                writeInstalledScrcpyServerVersion(this.depsPath, known);
                log.info(
                    `scrcpy-server at ${destFile} had no version marker; its SHA-256 is the pinned ${known} jar, ` +
                        `so ${known} is recorded`,
                );
                return;
            }
            const seed = this.verifiedSeedScrcpyServer();
            if (seed === null) {
                log.warn(
                    `scrcpy-server at ${destFile} has no version marker and matches no pinned version` +
                        `${digest !== null ? ` (SHA-256 ${digest})` : ''}, and there is no usable seed to replace it ` +
                        `with; leaving it, launched as ${SERVER_VERSION}`,
                );
                return;
            }
            this.placeScrcpyServerJar(seed.file, seed.version);
            log.warn(
                `scrcpy-server at ${destFile} had no version marker and matched no pinned version` +
                    `${digest !== null ? ` (SHA-256 ${digest})` : ''}; replaced it with the bundled seed ` +
                    `${seed.version}`,
            );
        } catch (err) {
            log.warn(`scrcpy-server version marker repair failed: ${(err as Error).message}`);
        }
    }

    /**
     * Container only: copies the image's (verified) seed over a jar that is
     * `installed`, unless the seed is that same version. Logged either way.
     *
     * @returns true when the seed was copied in.
     */
    private replaceWithImageSeed(destFile: string, installed: string): boolean {
        const seed = this.verifiedSeedScrcpyServer();
        if (seed === null) {
            log.warn(
                `scrcpy-server ${installed} at ${destFile} is not this image's ${SERVER_VERSION}, and there is no ` +
                    'usable seed to replace it with; leaving it',
            );
            return false;
        }
        if (seed.version === installed) {
            return false;
        }
        this.placeScrcpyServerJar(seed.file, seed.version);
        log.info(
            `scrcpy-server ${installed} at ${destFile} replaced with this image's bundled ${seed.version} ` +
                '(in a container the image provides scrcpy-server)',
        );
        return true;
    }

    /** `<image>/seed/scrcpy-server/scrcpy-server`; `__dirname` is always `<image>/dist/`. */
    public static seedScrcpyServerPath(): string {
        return path.join(__dirname, '..', 'seed', 'scrcpy-server', 'scrcpy-server');
    }

    public requestRestart(): void {
        writeFileAtomicSync(this.restartMarkerPath, `restart-requested-${Date.now()}`);
        log.info(`Restart requested; writing marker at ${this.restartMarkerPath} and exiting with code 75`);
        // The exit ends every open stream; close them as a deliberate stop
        // (1001) so a viewer is not told the stream failed. See liveStreams.ts.
        liveStreams.closeAllForShutdown();
        process.exit(75);
    }

    private resolveStatus(info: DependencyInfo): void {
        if (info.installedVersion === null) {
            // A first-use dependency (mkcert) that nothing has needed yet is
            // not in an unknown state: it is not installed, and the panel offers
            // to install it. Every other missing dependency keeps `Unknown`,
            // which the first-run banner reads as setup still incomplete.
            info.status = this.isDeferred(info.name) ? DependencyStatus.NotInstalled : DependencyStatus.Unknown;
            return;
        }
        if (info.latestVersion === null) {
            info.status = DependencyStatus.Unknown;
            return;
        }
        const cmp = compareVersions(info.installedVersion, info.latestVersion);
        if (this.definitions.find((d) => d.name === info.name)?.latestIsAuthoritative) {
            info.status = cmp === 0 ? DependencyStatus.UpToDate : DependencyStatus.UpdateAvailable;
            info.errorMessage = undefined;
            return;
        }
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
                // update() always fetches and provenance-checks the manifest
                // BEFORE calling install() for mkcert -- see its own call
                // site -- so this is never undefined on this branch.
                await this.installMkcert(downloadPath, version, mkcertManifest!);
                break;
            default:
                throw new Error(`No install handler for: ${name}`);
        }
    }

    /**
     * Fails closed on every download except mkcert's, whose check runs inside
     * `installMkcert` against its provenance-attested manifest. Each source is
     * the publisher's own list, fetched from the same host as the download:
     *
     *   nodejs         SHASUMS256.txt beside the archive (under nodeDistBase),
     *                  signed (SHASUMS256.txt.sig) by a pinned Node.js release key
     *   scrcpy-server  the release's SHA256SUMS.txt, signed (SHA256SUMS.txt.asc)
     *                  by scrcpy's pinned key, and cross-checked against the
     *                  repo's own SERVER_JAR_SHA256 when it pins this version
     *   adb            size + SHA-1 from repository2-3.xml, which nothing signs;
     *                  on Windows every extracted .exe and .dll's Authenticode
     *                  signature is checked too, in installAdb before anything
     *                  is stopped
     *
     * There is deliberately no way to skip or weaken any of these: a URL seam
     * (WS_SCRCPY_NODE_DIST_BASE) moves where the list is read from, never
     * whether it is checked or whose signature it needs.
     */
    private async verifyDownload(
        name: string,
        version: string,
        assetName: string,
        downloadPath: string,
    ): Promise<void> {
        switch (name) {
            case 'nodejs':
                await this.verifyNodeArchive(version, assetName, downloadPath);
                return;
            case 'scrcpy-server':
                await this.verifyScrcpyServer(version, downloadPath);
                return;
            case 'adb':
                await this.verifyAdbArchive(version, downloadPath);
                return;
            case 'mkcert':
                // Checked in installMkcert, against the attested manifest.
                return;
            default:
                throw new Error(`No checksum source for: ${name} -- refusing to install an unverified download`);
        }
    }

    /**
     * Same fetch policy as mkcert's manifest: the list is a few KB, so it gets
     * the short version-check budget rather than the download's.
     */
    private async fetchChecksumList(label: string, url: string): Promise<string> {
        const res = await fetchWithRetry(url, {
            ...VERSION_CHECK_POLICY,
            onRetry: (n) => log.warn(`${label} checksum list fetch ${n.attempt}/${n.attempts}: ${n.reason}`),
        });
        if (!res.ok) {
            throw new Error(`${label} checksum list fetch failed: HTTP ${res.status} from ${url}`);
        }
        return res.text();
    }

    /**
     * M5: a hash list and its detached signature, the signature checked
     * against `keySet` BEFORE the list is parsed or any hash compared, so a
     * list nothing pinned vouches for is never read for a hash at all. The
     * signature covers the list's exact bytes, which is why they are fetched
     * as bytes and decoded only after.
     *
     * A signature file the server does not have (404) is `missing-signature`;
     * any other non-OK answer is a fetch failure. Both refuse the install.
     */
    private async fetchSignedChecksumList(args: {
        label: string;
        listName: string;
        version: string;
        url: string;
        signatureUrl: string;
        keySet: ReleaseKeySet;
    }): Promise<string> {
        const { label, listName, version, url, signatureUrl, keySet } = args;
        const fetchBytes = async (what: string, from: string): Promise<Response> =>
            fetchWithRetry(from, {
                ...VERSION_CHECK_POLICY,
                onRetry: (n) => log.warn(`${label} ${what} fetch ${n.attempt}/${n.attempts}: ${n.reason}`),
            });

        const listRes = await fetchBytes('checksum list', url);
        if (!listRes.ok) {
            throw new Error(`${label} checksum list fetch failed: HTTP ${listRes.status} from ${url}`);
        }
        const list = new Uint8Array(await listRes.arrayBuffer());

        const what = `${label} ${listName} for v${version}`;
        const sigRes = await fetchBytes('checksum signature', signatureUrl);
        if (sigRes.status === 404) {
            throw new ReleaseSignatureError(
                'missing-signature',
                `${what} has no signature (HTTP 404 from ${signatureUrl}) -- refusing to install an unsigned list`,
            );
        }
        if (!sigRes.ok) {
            throw new Error(`${label} checksum signature fetch failed: HTTP ${sigRes.status} from ${signatureUrl}`);
        }
        const signature = new Uint8Array(await sigRes.arrayBuffer());

        const signer = await verifyDetachedSignature({ what, data: list, signature, keySet });
        log.info(
            `${what} signed by ${signer.fingerprint} (${signer.owner}) on ${signer.created.toISOString()}` +
                (signer.signingKeyFingerprint !== signer.fingerprint
                    ? ` with subkey ${signer.signingKeyFingerprint}`
                    : ''),
        );
        return new TextDecoder().decode(list);
    }

    private async verifyNodeArchive(version: string, assetName: string, downloadPath: string): Promise<void> {
        const sums = await this.fetchSignedChecksumList({
            label: 'Node.js',
            listName: 'SHASUMS256.txt',
            version,
            url: nodeChecksumsUrl(version),
            signatureUrl: nodeChecksumsSignatureUrl(version),
            keySet: this.releaseKeys.nodejs,
        });
        const expected = parseSha256Sums(sums, assetName);
        if (!expected) {
            throw new Error(
                `Node.js checksum list does not list ${assetName} -- refusing to install an unverified runtime`,
            );
        }
        if (!(await verifySha256(downloadPath, expected))) {
            throw new Error(`Node.js checksum mismatch for ${assetName} (expected ${expected}) -- refusing to install`);
        }
    }

    /**
     * Two sources, and both must agree when both speak: the release's own
     * SHA256SUMS.txt, and SERVER_JAR_SHA256, the hash this repo pins for the
     * jar it vendors. A release whose list disagrees with the pin was altered
     * after we vendored it, even if the download matches the altered list.
     */
    private async verifyScrcpyServer(version: string, downloadPath: string): Promise<void> {
        const assetName = scrcpyServerAssetName(version);
        const sums = await this.fetchSignedChecksumList({
            label: 'scrcpy-server',
            listName: 'SHA256SUMS.txt',
            version,
            url: scrcpyServerChecksumsUrl(version),
            signatureUrl: scrcpyServerChecksumsSignatureUrl(version),
            keySet: this.releaseKeys.scrcpyServer,
        });
        const expected = parseSha256Sums(sums, assetName);
        if (!expected) {
            throw new Error(
                `scrcpy-server checksum list does not list ${assetName} -- refusing to install an unverified binary`,
            );
        }
        // Own keys only: the version is a release tag from api.github.com.
        const pinned = Object.hasOwn(SERVER_JAR_SHA256, version) ? SERVER_JAR_SHA256[version]!.toLowerCase() : null;
        if (pinned !== null && pinned !== expected) {
            throw new Error(
                `scrcpy-server checksum list disagrees with the pinned SERVER_JAR_SHA256 for ${assetName} ` +
                    `(list ${expected}, pinned ${pinned}) -- refusing to install`,
            );
        }
        if (!(await verifySha256(downloadPath, expected))) {
            throw new Error(
                `scrcpy-server checksum mismatch for ${assetName} (expected ${expected}) -- refusing to install`,
            );
        }
    }

    /**
     * SHA-1 is all Google publishes for platform-tools, and it is acceptable
     * HERE: the threat is a substituted archive, which needs a second preimage
     * of a published digest -- SHA-1's known breaks are collisions, where the
     * attacker shapes BOTH files, and no second-preimage attack on it is
     * practical. The exact byte size must match too, and the index comes over
     * TLS from the same host as the archive. Size is checked first: it is free.
     */
    private async verifyAdbArchive(version: string, downloadPath: string): Promise<void> {
        const assetName = adbArchiveName(version);
        const xml = await this.fetchChecksumList('adb', ADB_REPOSITORY_XML_URL);
        const listed = parseAdbArchive(xml, assetName);
        if (!listed) {
            throw new Error(
                `adb checksum list does not list ${assetName} -- refusing to install unverified platform-tools`,
            );
        }
        const { size } = await fs.promises.stat(downloadPath);
        if (size !== listed.size) {
            throw new Error(
                `adb size mismatch for ${assetName} (expected ${listed.size} bytes, got ${size}) -- refusing to install`,
            );
        }
        if (!(await verifySha1(downloadPath, listed.sha1))) {
            throw new Error(`adb checksum mismatch for ${assetName} (expected ${listed.sha1}) -- refusing to install`);
        }
    }

    /**
     * I8: mkcert mints a CA the user then installs into their OS and phone
     * trust stores, so a tampered download does not just break the app -- it
     * becomes a trusted signing authority on every device the user set up.
     * That is the highest-consequence binary this app fetches, which is why
     * it alone also has its MANIFEST provenance-checked; the other three are
     * checked against their publishers' lists in `verifyDownload`.
     * (`UpdateService`'s Linux self-update AppImage is checked too, via the same
     * `parseSha256Sums`/`verifySha256` pair reused below -- that is a
     * different subsystem, but it is the existing pattern this follows
     * rather than inventing a second one.) Verification runs BEFORE the file
     * is copied anywhere `resolveMkcertExe` would find it; a mismatch
     * throws, `update()`'s catch records the failure, and the
     * `using`-scoped tmpDir cleanup in `update()` removes the unverified
     * download. Nothing partially-verified is ever installed.
     *
     * `manifest` arrives ALREADY provenance-checked by
     * `fetchAttestedMkcertManifest` -- this method only checks the downloaded
     * binary against it.
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
     * ITSELF for a build-provenance attestation from the fork's release
     * workflow at this exact tag -- see `mkcertProvenance.ts` for why that is
     * the anchor. Called from `update()` BEFORE the binary is downloaded at
     * all: "no download of anything else" on a manifest nothing vouches for.
     *
     * Deliberately a DIFFERENT failure than
     * `verifyMkcertBinaryAgainstManifest`'s: "nothing vouches for the
     * manifest" means the release itself is suspect, while "the binary doesn't
     * match the manifest" means a bad download or a same-release tamper.
     */
    private async fetchAttestedMkcertManifest(version: string): Promise<string> {
        const checksumsUrl = mkcertChecksumsUrl(version);
        const res = await fetchWithRetry(checksumsUrl, {
            ...VERSION_CHECK_POLICY,
            onRetry: (n) => log.warn(`mkcert checksum manifest fetch ${n.attempt}/${n.attempts}: ${n.reason}`),
        });
        if (!res.ok) {
            throw new Error(`mkcert checksum manifest fetch failed: HTTP ${res.status} from ${checksumsUrl}`);
        }
        const manifest = await res.text();
        await this.verifyMkcertManifest(manifest, version);
        return manifest;
    }

    /**
     * Checks the just-downloaded asset against an ALREADY provenance-checked
     * manifest (see `fetchAttestedMkcertManifest`). Throws on ANY failure to
     * verify -- an asset the manifest does not list, or a hash mismatch --
     * because a binary that fails verification must never be executed. This
     * is deliberately fail-closed: there is no "warn and continue" path.
     *
     * The binary itself is not attestation-checked: the attested manifest
     * already names its digest, so one attestation check covers every
     * platform asset the release carries.
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
            // resolve through $PATH. Never the archive's
            // owners: see tarExtractArgs (D16).
            await execFileAsync(resolveSystemTool('tar'), tarExtractArgs(downloadPath, ['-C', tmpDir]));
        }
        const archiveDir = fs.readdirSync(tmpDir).find((d) => d.startsWith('node-v'));
        if (!archiveDir) {
            throw new Error('Could not find Node.js directory in extracted archive');
        }
        const extractedPath = path.join(tmpDir, archiveDir);
        // D16: as root (the system service), the tree must be root's alone BEFORE it
        // is copied in -- the copy keeps each file's owner. No-op for any other user.
        await ensureRootOwnedTreeIfRoot(extractedPath);

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
            // …and check what landed, which is what the service will execute.
            await ensureRootOwnedTreeIfRoot(destDir);
        }
    }

    private async installAdb(downloadPath: string, tmpDir: string, platform: 'win32' | 'linux'): Promise<void> {
        const destDir = path.join(this.depsPath, 'adb');
        fs.mkdirSync(destDir, { recursive: true });
        const ext = platform === 'win32' ? '.exe' : '';
        const adbExe = path.join(destDir, `adb${ext}`);

        // 1. Non-destructive: extract to tmpDir. Before kill-server, so a
        // binary the checks below refuse never stops a working daemon.
        await this.extractZip(downloadPath, tmpDir);

        const platformToolsDir = path.join(tmpDir, 'platform-tools');
        if (!fs.existsSync(platformToolsDir)) {
            throw new Error('Could not find platform-tools directory in extracted archive');
        }

        // M5: on Windows every binary in the folder carries Google's
        // Authenticode signature, the one publisher signature platform-tools
        // has (the index it was checked against is unsigned). All of them are
        // checked, not just adb.exe: the whole folder is installed, and adb.exe
        // loads AdbWinApi.dll from beside itself first. Linux has no
        // equivalent, so there the size + SHA-1 check is all of it.
        if (platform === 'win32') {
            await verifyPlatformToolsAuthenticode(platformToolsDir, this.checkAuthenticode);
        }

        // Stop ADB server before replacing files
        if (fs.existsSync(adbExe)) {
            try {
                await execFileAsync(adbExe, ['kill-server'], { timeout: 5000 });
            } catch {
                // ADB may not be running
            }
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
        // scrcpy-server is a direct binary download (no archive). The marker
        // records the installed version so checkInstalled can report it back
        // accurately on subsequent calls. Without it, the bundled
        // SERVER_VERSION constant would be returned for any updater-installed
        // version, producing a "perpetual Update available" UI loop. The old
        // marker is deleted before the copy (2026-10-08), so a crash between
        // the two never leaves the new jar under the old version.
        this.placeScrcpyServerJar(downloadPath, version);
    }

    private async extractZip(zipPath: string, destDir: string): Promise<void> {
        // In-process, pure JS (src/server/zipExtract.ts). No PATH lookup and no
        // external binary, so nothing is resolved from the host — the same way
        // `ws` is: compiled into the app's own artifact.
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
let depManagerOpts: { dependenciesPath: string; restartMarkerPath?: string; inContainer?: boolean } | undefined;

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
    inContainer?: boolean;
}): DependencyManager {
    if (!depManagerInstance) {
        depManagerOpts = opts;
        depManagerInstance = new DependencyManager(opts.dependenciesPath, {
            ...(opts.restartMarkerPath !== undefined ? { restartMarkerPath: opts.restartMarkerPath } : {}),
            inContainer: opts.inContainer === true,
        });
        return depManagerInstance;
    }
    if (
        opts.dependenciesPath !== depManagerOpts!.dependenciesPath ||
        opts.restartMarkerPath !== depManagerOpts!.restartMarkerPath ||
        (opts.inContainer === true) !== (depManagerOpts!.inContainer === true)
    ) {
        throw new Error(
            'getDependencyManager() was already initialized with a different configuration ' +
                `(dependenciesPath: ${depManagerOpts!.dependenciesPath}); ` +
                `refusing to silently hand a caller expecting ${opts.dependenciesPath} a manager it did not ask for`,
        );
    }
    return depManagerInstance;
}
