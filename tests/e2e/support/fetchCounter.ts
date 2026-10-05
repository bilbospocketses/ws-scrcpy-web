import type { Page } from '@playwright/test';

/**
 * Count, in the page, every `fetch()` whose URL contains `fragment`, under
 * `window.__fetchCounts[fragment]`. Counted at CALL time, synchronously, so a
 * read straight after the action that would have caused one is exact — unlike a
 * network listener, which hears about the request later. Install before the
 * first navigation.
 */
export async function countFetches(page: Page, fragments: string[]): Promise<void> {
    await page.addInitScript((frags: string[]) => {
        const w = window as unknown as { __fetchCounts: Record<string, number> };
        w.__fetchCounts = Object.fromEntries(frags.map((f) => [f, 0]));
        const original = window.fetch.bind(window);
        window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            for (const f of frags) {
                if (url.includes(f)) w.__fetchCounts[f] = (w.__fetchCounts[f] ?? 0) + 1;
            }
            return original(input, init);
        };
    }, fragments);
}

/** The count `countFetches` kept for `fragment`, or -1 when it was never installed on this page. */
export async function fetchCount(page: Page, fragment: string): Promise<number> {
    return page.evaluate(
        (f) => (window as unknown as { __fetchCounts?: Record<string, number> }).__fetchCounts?.[f] ?? -1,
        fragment,
    );
}
