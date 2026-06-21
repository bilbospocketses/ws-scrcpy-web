import type { DatabaseSync } from 'node:sqlite';
import { AppSettingsStore } from '../AppSettingsStore';
import { UserSettingsStore } from '../UserSettingsStore';
import { IMPLICIT_ADMIN_ID } from '../constants';

export interface BootTrio {
    installMode: string | null;
    webPort: number | undefined;
    firstRunComplete: boolean;
}

export const GLOBAL_KEYS = [
    'autoUpdate',
    'updateCheckIntervalMinutes',
    'channel',
    'githubOwner',
    'adbPath',
    'dependenciesPath',
    'scanConcurrency',
    'scanTcpTimeoutMs',
    'scanAdbConnectTimeoutMs',
    'scanProgressInterval',
] as const;

export const PROMPT_KEYS = ['bookmarkDismissedForPort', 'bookmarkDismissedGlobally', 'serviceFirstRunSeen'] as const;

export function importConfigJson(db: DatabaseSync, legacy: Record<string, unknown>): BootTrio {
    const app = new AppSettingsStore(db);
    const userSettings = new UserSettingsStore(db);

    for (const k of GLOBAL_KEYS) {
        if (legacy[k] !== undefined) app.set(k, legacy[k]);
    }
    for (const k of PROMPT_KEYS) {
        if (legacy[k] !== undefined) userSettings.set(IMPLICIT_ADMIN_ID, k, legacy[k]);
    }

    return {
        installMode: (legacy['installMode'] as string | undefined) ?? null,
        webPort: legacy['webPort'] as number | undefined,
        firstRunComplete: (legacy['firstRunComplete'] as boolean | undefined) ?? false,
    };
}
