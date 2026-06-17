/**
 * Run `cleanup` when the page is being torn down. Registers BOTH `pagehide`
 * (fires on navigation away + bfcache eviction — the reliable modern hook) and
 * `beforeunload` (classic unload), so page-lifetime singletons (e.g. the
 * dependency / first-run panels and their polling intervals) get a chance to
 * release. `cleanup` may run more than once (both events can fire), so it MUST
 * be idempotent. (#36)
 */
export function onPageTeardown(cleanup: () => void): void {
    window.addEventListener('pagehide', cleanup);
    window.addEventListener('beforeunload', cleanup);
}
