import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { SERVER_VERSION } from '../common/Constants';
import { compareVersions } from '../common/DependencyTypes';
import { Logger } from './Logger';
import { isMkcertReleaseTag, mkcertUrlBases } from './mkcertProvenance';
import { loadManifest } from './NodePtyResolver';
import { getInstalledScrcpyServerVersion } from './scrcpyServerVersion';
import { fetchOkWithRetry, VERSION_CHECK_POLICY } from './util/fetchWithRetry';

const log = Logger.for('DependencyDefinitions');

const execFileAsync = promisify(execFile);

export function getPlatform(): 'win32' | 'linux' {
    return os.platform() === 'win32' ? 'win32' : 'linux';
}

export function getArch(): 'x64' | 'arm64' {
    return os.arch() === 'arm64' ? 'arm64' : 'x64';
}

// mkcert tracks the fork's LATEST release (user decision 2026-09-27). There is
// no pinned version or pinned digest any more: what vouches for a download is
// the release's Sigstore build-provenance attestation, checked against an
// identity pinned in mkcertProvenance.ts.

export function mkcertExeName(): string {
    return os.platform() === 'win32' ? 'mkcert.exe' : 'mkcert';
}

/**
 * Asset naming in bilbospocketses/mkcert releases. Darwin is included because
 * the matrix publishes it, even though ws-scrcpy-web does not ship macOS yet.
 */
export function mkcertAssetName(version: string): string {
    const plat = os.platform();
    const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
    if (plat === 'win32') return `mkcert-${version}-windows-${arch}.exe`;
    if (plat === 'darwin') return `mkcert-${version}-darwin-${arch}`;
    return `mkcert-${version}-linux-${arch}`;
}

/**
 * I8: the fork's release workflow (`.github/workflows/release.yml`) runs
 * `sha256sum mkcert-*` over every platform asset and publishes the result as
 * a single manifest per release, named exactly this. One line per asset:
 * `<64-hex-digest>  <asset filename>`.
 */
export function mkcertChecksumsAssetName(version: string): string {
    return `mkcert-${version}-SHA256SUMS.txt`;
}

export function mkcertChecksumsUrl(version: string): string {
    return `${mkcertUrlBases().web}/releases/download/${version}/${mkcertChecksumsAssetName(version)}`;
}

/**
 * A test / mirror seam for every URL Node's update path reads from nodejs.org,
 * the sibling of WS_SCRCPY_MKCERT_URL_BASE (item 167). Set, it replaces
 * `https://nodejs.org/dist` and nodejs.org's own layout stays under it:
 *
 *   <base>/index.json                                        the release index
 *   <base>/v<version>/node-v<version>-<platform>-<arch>.<ext> the archive
 *   <base>/v<version>/SHASUMS256.txt                          the archive's checksum
 *   <base>/v<version>/SHASUMS256.txt.sig                      the list's signature
 *
 * That is all the path reads there. The checksum list moves WITH the archive, and
 * the install still refuses an archive it does not list: the seam moves where the
 * list is read from, never whether it is checked. Nor who must have signed it
 * (M5): a list read through the seam must still carry a signature by one of
 * Node's own pinned release keys, so a mirror can serve Node's genuine files
 * and nothing else. The node-pty prebuilt
 * manifest the lookup also reads is this repo's own release asset, not Node's,
 * and stays where it is. Smoke row 9.12 points it at a fixture so a fast-tier
 * server is offered a Node update, the one update that needs a restart.
 */
export const NODE_DIST_BASE_ENV = 'WS_SCRCPY_NODE_DIST_BASE';

/** Read at call time, not at import, so a test can set the variable per case. */
export function nodeDistBase(override: string | undefined = process.env[NODE_DIST_BASE_ENV]): string {
    const trimmed = override?.trim().replace(/\/+$/, '');
    return trimmed || 'https://nodejs.org/dist';
}

/** nodejs.org's per-release checksum list, beside the archive under the same base. */
export function nodeChecksumsUrl(version: string): string {
    return `${nodeDistBase()}/v${version}/SHASUMS256.txt`;
}

/**
 * The binary detached signature over that list, beside it. nodejs.org also
 * publishes `SHASUMS256.txt.asc`, a clearsigned copy; the detached `.sig` is
 * read instead because it signs the exact bytes the hash is then read from.
 */
export function nodeChecksumsSignatureUrl(version: string): string {
    return `${nodeChecksumsUrl(version)}.sig`;
}

/**
 * Google's SDK repository index. `checkLatest` reads platform-tools' version
 * from it, and the install reads the archive's size and SHA-1 from it.
 */
export const ADB_REPOSITORY_XML_URL = 'https://dl.google.com/android/repository/repository2-3.xml';

/**
 * The VERSIONED platform-tools archive, exactly as repository2-3.xml names it.
 * Never `platform-tools-latest-<os>.zip`: that name floats, so it can drift from
 * the version just looked up, and the index lists no checksum for it.
 */
export function adbArchiveName(version: string): string {
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error(
            `adb version ${JSON.stringify(version)} is not a platform-tools release number -- ` +
                'refusing to download an unversioned archive',
        );
    }
    return `platform-tools_r${version}-${getPlatform() === 'win32' ? 'win' : 'linux'}.zip`;
}

/**
 * Size and SHA-1 of `archiveName` from repository2-3.xml, read only inside the
 * `platform-tools` package -- a same-named archive elsewhere in the index is not
 * this one. Null when the package does not list it with both fields.
 */
export function parseAdbArchive(xml: string, archiveName: string): { size: number; sha1: string } | null {
    const pkg = xml.match(/<remotePackage\s+path="platform-tools">([\s\S]*?)<\/remotePackage>/)?.[1];
    if (pkg === undefined) return null;
    for (const [, archive] of pkg.matchAll(/<complete>([\s\S]*?)<\/complete>/g)) {
        if (archive?.match(/<url>\s*([^<]+?)\s*<\/url>/)?.[1] !== archiveName) continue;
        const size = archive.match(/<size>\s*(\d+)\s*<\/size>/)?.[1];
        const sha1 = archive.match(/<checksum\s+type="sha1">\s*([0-9a-fA-F]{40})\s*<\/checksum>/)?.[1];
        if (size === undefined || sha1 === undefined) return null;
        return { size: Number(size), sha1: sha1.toLowerCase() };
    }
    return null;
}

/** The scrcpy-server asset name in a Genymobile/scrcpy release, and in its SHA256SUMS.txt. */
export function scrcpyServerAssetName(version: string): string {
    return `scrcpy-server-v${version}`;
}

/** The release's own `sha256sum` list, published beside the assets. */
export function scrcpyServerChecksumsUrl(version: string): string {
    return `https://github.com/Genymobile/scrcpy/releases/download/v${version}/SHA256SUMS.txt`;
}

/** The armored detached signature over that list, which every release since v2.0 carries. */
export function scrcpyServerChecksumsSignatureUrl(version: string): string {
    return `${scrcpyServerChecksumsUrl(version)}.asc`;
}

/**
 * Node major version → ABI number (`process.versions.modules`).
 * ABI is stable within a major; it changes only across majors.
 * Keys are Node major numbers; values are string-form ABI numbers
 * so they can be compared directly against Manifest.coveredAbis.
 *
 * Add new LTS majors here as they are released AND as our node-pty
 * prebuilt matrix ships a release for them.
 */
export const NODE_LTS_ABI: Record<number, string> = {
    20: '115',
    22: '127',
    24: '137',
};

/** Parses the leading major number from a Node version string like "v24.14.1". */
export function parseNodeMajor(version: string): number {
    const m = version.match(/^v?(\d+)\./);
    return m ? Number.parseInt(m[1]!, 10) : Number.NaN;
}

export interface DependencyDefinition {
    name: string;
    displayName: string;
    description: string;
    requiresRestart: boolean;
    pairedWith?: string;
    checkInstalled: (depsPath: string) => Promise<string | null>;
    checkLatest: () => Promise<string | null>;
    getDownloadUrl: (version: string) => string;
    /**
     * A version this build already knows how to install, used when
     * `checkLatest` cannot answer.
     *
     * Without it, a first-run install is hostage to a version LOOKUP: nothing
     * installs unless `latestVersion` is known, and scrcpy-server's lookup goes
     * through `api.github.com`, which rate-limits per IP at 60/hour
     * unauthenticated. A rate-limited runner therefore installed nothing and
     * said nothing — smoke 9.4's 120s poll on 2026-09-09.
     *
     * Only meaningful where the repo ships a known-good version. The ASSET
     * download is not the API and is not rate-limited the same way, so falling
     * back genuinely works while the lookup is refused.
     */
    fallbackVersion?: string;
    /**
     * M2: skip this dependency in `autoInstallMissing()`'s boot-time loop.
     * The spec is deliberate for mkcert specifically — "fetched on first use
     * rather than at install time, so a user who never enables HTTPS never
     * downloads it" — a ~4.5 MB fetch on every fresh boot for a feature the
     * user may never turn on is a cost with no consent. `checkInstalled` /
     * `checkLatest` still run at boot (so the dependency panel shows accurate
     * status); only the DOWNLOAD is deferred. `update(name)` remains directly
     * callable on demand — see `createCertService.ts`'s lazy-install wrapper
     * around `run`, which is what actually triggers it on first use.
     */
    deferInstall?: boolean;
    /**
     * Compare installed against latest by IDENTITY rather than by order: any
     * installed version other than latest reports `UpdateAvailable`.
     *
     * The default "installed is newer than latest, stay put" guard exists for
     * a FILTERED latest (Option D's prebuilt gating can report one older than
     * what is installed). mkcert's latest is unfiltered, and the fork restarted
     * its numbering on 2026-09-27 (v1.4.4-bt.2 → v0.1.0), so ordered comparison
     * would call the retired build "newer" and keep it forever.
     */
    latestIsAuthoritative?: boolean;
    /**
     * Managed on a host install only, so
     * `getDependencyDefinitions(…, { inContainer: true })` leaves it out
     * entirely. Two definitions carry it: Node.js, which the image provides
     * itself, and mkcert, whose only job (Local HTTPS) does not exist in a
     * container.
     */
    hostOnly?: boolean;
}

async function runVersionCommand(exe: string, args: string[], pattern: RegExp): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync(exe, args, { timeout: 5000 });
        const match = stdout.match(pattern);
        return match?.[1] ?? null;
    } catch {
        return null;
    }
}

/**
 * `inContainer` (← Config.dockerMode) drops every `hostOnly` definition (Node.js,
 * which the image supplies itself, and mkcert, which a container has no use
 * for), so the container never lists, checks, downloads or offers to update them.
 */
export function getDependencyDefinitions(
    depsPath: string,
    opts: { inContainer?: boolean } = {},
): DependencyDefinition[] {
    const platform = getPlatform();
    const arch = getArch();

    const defs: DependencyDefinition[] = [
        {
            name: 'nodejs',
            displayName: 'Node.js',
            description: 'JavaScript runtime that runs the ws-scrcpy-web server',
            requiresRestart: true,
            pairedWith: 'node-pty',
            // The image runs its own interpreter (the Dockerfile links
            // seed/node/node to /usr/local/bin/node): Node is the image's
            // execution environment there, not an app dependency. A copy on the
            // volume was ~50 MB downloaded on every fresh volume and never run —
            // the Linux tarball lands at node/bin/node, and start.sh only looks
            // for node/node.
            hostOnly: true,
            checkInstalled: async (depsPath) => {
                const ext = platform === 'win32' ? '.exe' : '';
                // Linux tarball extracts with bin/ subdirectory; Windows zip is flat.
                const binPath = path.join(depsPath, 'node', 'bin', `node${ext}`);
                const flatPath = path.join(depsPath, 'node', `node${ext}`);
                const exe = fs.existsSync(binPath) ? binPath : flatPath;
                return runVersionCommand(exe, ['--version'], /v([\d.]+)/);
            },
            checkLatest: async () => {
                const res = await fetchOkWithRetry(`${nodeDistBase()}/index.json`, {
                    ...VERSION_CHECK_POLICY,
                    onRetry: (n) => log.warn(`node latest check ${n.attempt}/${n.attempts}: ${n.reason}`),
                });
                const releases = (await res.json()) as { version: string; lts: string | false }[];
                const ltsReleases = releases.filter((r) => r.lts !== false);
                if (ltsReleases.length === 0) return null;

                const manifest = await loadManifest(depsPath);
                if (!manifest) {
                    log.warn('Prebuilt manifest unavailable; Node update gating skipped');
                    return ltsReleases[0]!.version.replace(/^v/, '');
                }

                const covered = new Set(manifest.coveredAbis);
                const candidates = ltsReleases.filter((r) => {
                    const major = parseNodeMajor(r.version);
                    const abi = NODE_LTS_ABI[major];
                    return abi !== undefined && covered.has(abi);
                });
                if (candidates.length === 0) return null;

                const filteredLatest = candidates[0]!;
                const unfilteredLatest = ltsReleases[0]!;
                if (filteredLatest.version !== unfilteredLatest.version) {
                    log.warn(
                        `Node ${unfilteredLatest.version.replace(/^v/, '')} available but no matching ` +
                            `node-pty prebuilt; staying on filter max ${filteredLatest.version.replace(/^v/, '')}`,
                    );
                }
                return filteredLatest.version.replace(/^v/, '');
            },
            getDownloadUrl: (version) => {
                if (platform === 'win32') {
                    return `${nodeDistBase()}/v${version}/node-v${version}-win-${arch}.zip`;
                }
                return `${nodeDistBase()}/v${version}/node-v${version}-linux-${arch}.tar.gz`;
            },
        },
        {
            name: 'adb',
            displayName: 'ADB (Android Debug Bridge)',
            description: 'Communicates with Android devices (push, shell, tunnel)',
            requiresRestart: false,
            checkInstalled: async (depsPath) => {
                const ext = platform === 'win32' ? '.exe' : '';
                const exe = path.join(depsPath, 'adb', `adb${ext}`);
                return runVersionCommand(exe, ['--version'], /Version ([\d.]+)/);
            },
            checkLatest: async () => {
                const res = await fetchOkWithRetry(ADB_REPOSITORY_XML_URL, {
                    ...VERSION_CHECK_POLICY,
                    onRetry: (n) => log.warn(`adb latest check ${n.attempt}/${n.attempts}: ${n.reason}`),
                });
                const xml = await res.text();
                const match = xml.match(
                    /path="platform-tools"[\s\S]*?<major>(\d+)<\/major>\s*<minor>(\d+)<\/minor>\s*<micro>(\d+)<\/micro>/,
                );
                return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
            },
            getDownloadUrl: (version) => `https://dl.google.com/android/repository/${adbArchiveName(version)}`,
        },
        {
            name: 'scrcpy-server',
            displayName: 'scrcpy-server',
            description: 'Runs on Android device to capture screen, audio, and accept input',
            requiresRestart: false,
            // The version this build ships in `assets/scrcpy-server`, with a
            // pinned hash in common/Constants.ts. If api.github.com will not say
            // what the newest release is, installing the one we already vouch
            // for beats installing nothing.
            fallbackVersion: SERVER_VERSION,
            checkInstalled: async (depsPath) => {
                // The JAR file presence gates "installed at all"; the actual version
                // comes from the .version marker (or SERVER_VERSION as fallback for
                // legacy seed installs that predate the marker). Pre-fix this
                // returned SERVER_VERSION unconditionally even when the on-disk
                // binary had been replaced by an updater download — UI showed
                // "Update available" forever in a loop. See scrcpyServerVersion.ts.
                const file = path.join(depsPath, 'scrcpy-server', 'scrcpy-server');
                if (!fs.existsSync(file)) return null;
                return getInstalledScrcpyServerVersion(depsPath);
            },
            checkLatest: async () => {
                // `fetchOkWithRetry`, not `fetch`. This call used to ignore
                // `res.ok` entirely, so a 403 or 5xx got its ERROR BODY parsed
                // as success, yielded no `tag_name`, and returned null —
                // whereupon autoInstallMissing skipped scrcpy-server for the
                // whole boot with no trace. That is smoke 20.11's 300s flake,
                // and this endpoint is why: api.github.com rate-limits per IP
                // at 60/hour unauthenticated, and CI runners share IPs. The
                // other two dependencies resolve through nodejs.org and
                // dl.google.com, which do not rate-limit — which is exactly why
                // they hydrated in the run where this one did not.
                const res = await fetchOkWithRetry('https://api.github.com/repos/Genymobile/scrcpy/releases/latest', {
                    init: { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ws-scrcpy-web' } },
                    ...VERSION_CHECK_POLICY,
                    onRetry: (n) => log.warn(`scrcpy-server latest check ${n.attempt}/${n.attempts}: ${n.reason}`),
                });
                const data = (await res.json()) as { tag_name: string };
                const tag = data.tag_name?.replace(/^v/, '') ?? null;
                if (tag === null) return null;
                // Offer only what this build speaks. ScrcpyConnection launches
                // whichever version is installed, and the stream parser is
                // written and tested against SERVER_VERSION; a newer release is
                // reached through an app release that bumps it after testing
                // (scrcpy v5.0 shipped 2026-10-05 against a 4.1 build). The
                // lookup itself still runs, so refused / failed lookups keep
                // their meaning for the fallback install and Settings.
                return compareVersions(tag, SERVER_VERSION) > 0 ? SERVER_VERSION : tag;
            },
            // Authoritative, so a server installed ABOVE the supported version
            // (someone who took v5.0 before the cap) is offered the supported
            // one back, instead of "newer than latest, stay put".
            latestIsAuthoritative: true,
            getDownloadUrl: (version) => {
                return `https://github.com/Genymobile/scrcpy/releases/download/v${version}/${scrcpyServerAssetName(version)}`;
            },
        },
        {
            name: 'mkcert',
            displayName: 'mkcert',
            description: 'Issues the local certificate that lets browsers stream over HTTPS on a LAN',
            requiresRestart: false,
            // Our own hardened fork, NOT FiloSottile/mkcert. Upstream has been dormant
            // since 2024-08 and its last release is from 2022; the fork carries five
            // dependency bumps, 28 tests where upstream has none, and fixes for four
            // review findings including an argument-controlled path escape that wrote
            // outside the working directory and still exited 0.
            //
            // No fallbackVersion, unlike scrcpy-server: an install also needs the
            // attestation lookup, which is api.github.com too, so a refused
            // version lookup would be refused again one step later. A fixed tag
            // here would also go stale: the last one, v1.4.4-bt.2, was deleted on 2026-09-27.
            latestIsAuthoritative: true,
            // M2: fetched on first use (see the field's own doc comment), not at
            // boot -- this is the highest-consequence binary the app fetches
            // (it mints a CA the user installs into their OS and phone trust
            // stores), so a download nobody asked for yet is a cost with no
            // consent, unlike the other three which the app needs unconditionally.
            deferInstall: true,
            // mkcert only issues the Local HTTPS certificate, and Local HTTPS is
            // not supported in a container (D8): a reverse proxy is the only
            // HTTPS there, and every /api/tls route refuses. So a container
            // never lists it, never looks up its latest release on
            // api.github.com, and never reports it in Error when that lookup
            // fails (the row 20.9 failure on #819's CI, 2026-10-01).
            hostOnly: true,
            checkInstalled: async (depsPath) => {
                const exe = path.join(depsPath, 'mkcert', mkcertExeName());
                if (!fs.existsSync(exe)) return null;
                // Still parses the retired `-bt.N` suffix: releases no longer carry
                // it, but an installed v1.4.4-bt.2 binary does, and reading it is
                // what lets the panel offer that machine the update to v0.1.0.
                return runVersionCommand(exe, ['-version'], /v?([\d.]+(?:-bt\.\d+)?)/);
            },
            checkLatest: async () => {
                const res = await fetchOkWithRetry(`${mkcertUrlBases().api}/releases/latest`, {
                    init: { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ws-scrcpy-web' } },
                    ...VERSION_CHECK_POLICY,
                    onRetry: (n) => log.warn(`mkcert latest check ${n.attempt}/${n.attempts}: ${n.reason}`),
                });
                const data = (await res.json()) as { tag_name?: string };
                if (data.tag_name === undefined) return null;
                // The tag becomes part of a download URL and of the signer
                // identity the attestation must match, so refuse an odd one here.
                if (!isMkcertReleaseTag(data.tag_name)) {
                    throw new Error(`unexpected mkcert release tag ${JSON.stringify(data.tag_name)}`);
                }
                return data.tag_name;
            },
            getDownloadUrl: (version) =>
                `${mkcertUrlBases().web}/releases/download/${version}/${mkcertAssetName(version)}`,
        },
    ];
    return opts.inContainer ? defs.filter((d) => !d.hostOnly) : defs;
}
