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

export function compareVersions(a: string | null, b: string | null): number {
    if (a === null || b === null) return -1;
    const pa = a.replace(/^v/, '').split('.').map(Number);
    const pb = b.replace(/^v/, '').split('.').map(Number);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const na = pa[i] ?? 0;
        const nb = pb[i] ?? 0;
        if (na < nb) return -1;
        if (na > nb) return 1;
    }
    return 0;
}
