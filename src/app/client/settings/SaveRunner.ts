import type { Change } from './StagedSettingsStore';

export interface BatchResult {
    ok: boolean;
    applied: string[];
    failed?: { id: string; error: string };
    restartRequired?: boolean;
    redirectPort?: number;
}

/**
 * Send a staged batch. A thin client over ONE endpoint by design.
 *
 * Ordering, the write-ahead log and the apply sequence all live server-side
 * (SettingsBatchApi). Doing them here would put the "webPort last" guarantee in
 * browser JavaScript and spread the WAL transitions across separate round
 * trips, which makes the mark-completed-before-restart rule a race rather than
 * a fact.
 */
export async function runSave(changes: Change[]): Promise<BatchResult> {
    try {
        const res = await fetch('/api/settings/batch', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ changes }),
        });
        return (await res.json()) as BatchResult;
    } catch {
        return { ok: false, applied: [], failed: { id: '', error: "couldn't reach server" } };
    }
}
