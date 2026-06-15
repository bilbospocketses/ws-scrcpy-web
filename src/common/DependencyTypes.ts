export enum DependencyStatus {
    Unknown = 'unknown',
    UpToDate = 'up-to-date',
    UpdateAvailable = 'update-available',
    Checking = 'checking',
    Updating = 'updating',
    Error = 'error',
}

export interface DependencyInfo {
    name: string;
    displayName: string;
    installedVersion: string | null;
    latestVersion: string | null;
    status: DependencyStatus;
    description: string;
    errorMessage?: string | undefined;
    requiresRestart: boolean;
    pairedWith?: string | undefined;
    canUpdate: boolean;
}

export interface UpdateResult {
    success: boolean;
    newVersion?: string | undefined;
    errorMessage?: string | undefined;
    requiresRestart: boolean;
    reason?: 'launcher-required' | undefined;
}

interface ParsedVersion {
    /** Numeric release segments, e.g. 1.2.3 → [1, 2, 3]. */
    release: number[];
    /** Dot-separated prerelease identifiers, e.g. beta.4 → ['beta', '4']; [] for a stable release. */
    pre: string[];
}

function parseVersion(v: string): ParsedVersion {
    const cleaned = v.replace(/^v/, '');
    const dash = cleaned.indexOf('-');
    const core = dash === -1 ? cleaned : cleaned.slice(0, dash);
    const preRaw = dash === -1 ? '' : cleaned.slice(dash + 1);
    const release = core.split('.').map((s) => Number(s) || 0);
    const pre = preRaw === '' ? [] : preRaw.split('.');
    return { release, pre };
}

/**
 * Compare two prerelease identifier lists per SemVer §11: numeric identifiers
 * have lower precedence than alphanumeric ones, numeric compare numerically,
 * alphanumeric compare in ASCII order, and a larger set of fields wins when all
 * preceding fields are equal.
 */
function comparePrerelease(a: string[], b: string[]): number {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
        if (i >= a.length) return -1; // a ran out of identifiers first → lower precedence
        if (i >= b.length) return 1;
        const ai = a[i]!;
        const bi = b[i]!;
        const an = /^\d+$/.test(ai) ? Number(ai) : null;
        const bn = /^\d+$/.test(bi) ? Number(bi) : null;
        if (an !== null && bn !== null) {
            if (an !== bn) return an < bn ? -1 : 1;
        } else if (an !== null) {
            return -1; // numeric < alphanumeric
        } else if (bn !== null) {
            return 1;
        } else if (ai !== bi) {
            return ai < bi ? -1 : 1;
        }
    }
    return 0;
}

/**
 * Compare two version strings. Returns -1 if a < b, 1 if a > b, 0 if equal.
 *
 * Handles SemVer prerelease tags (e.g. `1.0.0-beta.2`): the release core is
 * compared numerically, a stable release outranks its prerelease
 * (`1.0.0 > 1.0.0-beta`), and prerelease identifiers compare per SemVer §11
 * (so `beta.2 < beta.10`, not string order). `null` is the lowest version (no
 * version present): both null → equal; one null → it is the older side.
 */
export function compareVersions(a: string | null, b: string | null): number {
    if (a === null && b === null) return 0;
    if (a === null) return -1;
    if (b === null) return 1;

    const va = parseVersion(a);
    const vb = parseVersion(b);

    const len = Math.max(va.release.length, vb.release.length);
    for (let i = 0; i < len; i++) {
        const na = va.release[i] ?? 0;
        const nb = vb.release[i] ?? 0;
        if (na < nb) return -1;
        if (na > nb) return 1;
    }

    // Equal release cores: a stable build (no prerelease) outranks a prerelease.
    if (va.pre.length === 0 && vb.pre.length === 0) return 0;
    if (va.pre.length === 0) return 1;
    if (vb.pre.length === 0) return -1;
    return comparePrerelease(va.pre, vb.pre);
}
