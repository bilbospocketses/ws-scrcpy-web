/**
 * `fetch` with bounded retry for the transient half of the failure space.
 *
 * WHY THIS EXISTS (items 121, 124, 125). Every network call in the server was
 * one shot, and each absorbed failure differently — none of them well:
 *
 *   - `DependencyDefinitions.checkLatest` did not check `res.ok` at all. On a
 *     403 or 5xx it parsed the ERROR BODY as success, found no `tag_name`, and
 *     returned `null`. `autoInstallMissing` deliberately skips a dependency
 *     whose latest version is unknown, so the install was never attempted and
 *     `installedVersion` stayed null for the rest of that boot. That is smoke
 *     20.11's 300s flake: scrcpy-server alone is resolved through
 *     `api.github.com`, which rate-limits **per IP at 60/hour unauthenticated**
 *     — and CI runners share IPs. nodejs.org and dl.google.com do not, which is
 *     exactly why `nodejs` and `adb` hydrated in the same run that
 *     `scrcpy-server` did not. No timeout would ever have helped; nothing was
 *     retrying.
 *   - `NodePtyResolver.downloadAndOverlayPtyNode` returned `false` and degraded
 *     to `shell:false`, which is right for "no prebuilt exists for this host"
 *     and wrong for "GitHub had a bad two seconds".
 *
 * THE RETRY LIST IS DELIBERATELY NARROW: `429` and `5xx`, plus network/abort
 * errors (DNS, reset, an `AbortSignal` timeout). A `404` is a real answer — the
 * asset does not exist — and retrying it only turns a fast, clear failure into a
 * slow, identical one. `401`/`403` are the same: no amount of waiting grows a
 * permission. (A rate-limited `403` from GitHub is indistinguishable here from a
 * genuine auth failure, so it is NOT retried; `429` is the status that means
 * "try again" and is the one we honour.)
 *
 * `fetchImpl` and `sleep` are injectable so tests never touch the network and
 * never actually wait.
 */

/** Attempts per call, INCLUDING the first. 3 => first + 2 retries. */
export const DEFAULT_ATTEMPTS = 3;
/** Backoff base; the wait after attempt 1 is 2s, after attempt 2 is 4s. */
export const RETRY_BASE_DELAY_MS = 2_000;
/**
 * Default per-attempt deadline. Small payloads only — see `timeoutMs`.
 * Named for fetch specifically: `AdbClient` already exports a `DEFAULT_TIMEOUT_MS`
 * for adb command budgets, which is an unrelated concern.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export interface RetryNotice {
    url: string;
    attempt: number;
    attempts: number;
    reason: string;
}

/**
 * The budget for a "what is the latest version" query, which is NOT the budget
 * for a download.
 *
 * Boot runs `checkAll().then(() => autoInstallMissing())`, and the seed promote
 * plus every install lives inside `autoInstallMissing` — so time spent checking
 * versions is time before ANY dependency is installed. With the download policy
 * (3 attempts x 30s, plus 2s and 4s of backoff) one unreachable endpoint could
 * hold that gate for ~96s, and three of them serially for ~288s. Measured
 * 2026-09-09: that blew smoke 20.9's 180s hydrate poll and 20.12's 300s wait,
 * and left 1.9 reading `checking` where it expected `error`.
 *
 * A version check is advisory — the app runs fine not knowing the latest
 * version — so it gets a short, bounded budget and gets out of the way.
 */
export const VERSION_CHECK_POLICY = {
    attempts: 2,
    baseDelayMs: 1_000,
    timeoutMs: 10_000,
} as const;

export interface FetchWithRetryOptions {
    attempts?: number;
    /** Backoff base for `retryDelayMs`. Defaults to `RETRY_BASE_DELAY_MS` (2s). */
    baseDelayMs?: number;
    /**
     * Per-attempt deadline, via `AbortSignal.timeout`. `null` disables it.
     *
     * DISABLE IT FOR LARGE BODIES. The signal aborts the whole exchange, body
     * streaming included — so a 30s deadline on the ~110 MB Node archive would
     * kill a legitimately slow download mid-stream. Callers that stream a large
     * response pass `timeoutMs: null` and rely on retry alone.
     */
    timeoutMs?: number | null;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (notice: RetryNotice) => void;
    init?: RequestInit;
}

/** Which HTTP statuses earn another attempt. See the note above on 403. */
export function isRetryableStatus(status: number): boolean {
    return status === 429 || (status >= 500 && status <= 599);
}

/** Backoff for the wait AFTER attempt N: 2s, then 4s. */
export function retryDelayMs(attempt: number, baseMs: number = RETRY_BASE_DELAY_MS): number {
    return baseMs * 2 ** (attempt - 1);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns the LAST attempt's response as-is, so the caller still sees and
 * reports the real status. Throws only when the final attempt threw.
 */
export async function fetchWithRetry(url: string, opts: FetchWithRetryOptions = {}): Promise<Response> {
    const {
        attempts = DEFAULT_ATTEMPTS,
        baseDelayMs = RETRY_BASE_DELAY_MS,
        timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
        fetchImpl = fetch,
        sleep = defaultSleep,
        onRetry = () => {},
        init = {},
    } = opts;

    for (let attempt = 1; ; attempt++) {
        const last = attempt >= attempts;
        try {
            const signal = timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs);
            const res = await fetchImpl(url, signal ? { ...init, signal } : init);
            if (res.ok || last || !isRetryableStatus(res.status)) {
                return res;
            }
            onRetry({ url, attempt, attempts, reason: `HTTP ${res.status}` });
        } catch (err) {
            if (last) {
                throw err;
            }
            onRetry({ url, attempt, attempts, reason: err instanceof Error ? err.message : String(err) });
        }
        await sleep(retryDelayMs(attempt, baseDelayMs));
    }
}

/**
 * `fetchWithRetry` that THROWS on a non-OK final response instead of handing
 * back an error body.
 *
 * This is the one every `checkLatest` must use. Returning `null` from a failed
 * version check is what produced the silent skip described at the top of this
 * file: `DependencyManager.checkLatest` already catches a throw and turns it
 * into `DependencyStatus.Error` with the message attached, which is a state the
 * UI and the API can both report. A `null` is indistinguishable from "this
 * dependency legitimately has no known latest version" and is silently skipped.
 */
export async function fetchOkWithRetry(url: string, opts: FetchWithRetryOptions = {}): Promise<Response> {
    const res = await fetchWithRetry(url, opts);
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} from ${url}`);
    }
    return res;
}
