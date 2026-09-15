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
        // `fetch` resolves normally for a 400 — the promise settling says only
        // that the server answered, never that it agreed. Reading the body
        // alone therefore reports a REFUSED batch as a success, and the two
        // refusal shapes below are why that is not a theoretical worry:
        //
        //   - a rejected apply -> 400 `{ ok: false, applied, failed:{id,error} }`
        //   - a non-stageable id -> a bare 400 `{ error: '…' }`, with no `ok`
        //     at all, which reads back as `ok: undefined`.
        //
        // The second one is unsurvivable without the `res.ok` check: `undefined`
        // is not `false`, so every `if (result.ok)` downstream would have to
        // guess. Normalise here, once, so callers get a real boolean.
        const body = (await readJson(res)) as Partial<BatchResult> & { error?: string };
        if (!res.ok || body.ok !== true) {
            return {
                ok: false,
                applied: body.applied ?? [],
                failed: body.failed ?? { id: '', error: body.error ?? `server refused the batch (${res.status})` },
            };
        }
        return body as BatchResult;
    } catch {
        return { ok: false, applied: [], failed: { id: '', error: "couldn't reach server" } };
    }
}

/** `res.json()` throws on an empty or non-JSON body (a proxy's HTML 502, say). */
async function readJson(res: Response): Promise<unknown> {
    try {
        return await res.json();
    } catch {
        return {};
    }
}
