import type { Page } from '@playwright/test';

/**
 * Helpers for the theming, accessibility and settings-prompt specs.
 *
 * The theme lives in ONE place at runtime: the `data-theme` attribute on
 * <html>. `initTheme()` sets it synchronously from `prefers-color-scheme` so
 * the first paint is right, then `applyStoredTheme()` overwrites it from the
 * DB once that loads. Both facts matter to row 16.6, which is about the window
 * between them.
 */
export type Theme = 'dark' | 'light';

/** The live theme, read the same way the app's own getTheme() reads it. */
export async function currentTheme(page: Page): Promise<string | null> {
    return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

/** Resolve a CSS custom property off :root, after the cascade has run. */
export async function cssVar(page: Page, name: string): Promise<string> {
    return page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
}

/**
 * Record every value `data-theme` takes, starting BEFORE the page's own
 * scripts run.
 *
 * addInitScript runs in each fresh document ahead of anything the app loads,
 * so the observer is live for the first style recalculation — which is the
 * moment row 16.6 is about. Asserting after `goto()` resolves would be too
 * late: the flash it exists to catch would already be over.
 */
export async function recordThemeChanges(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const w = window as unknown as { __themeFlashes: string[] };
        w.__themeFlashes = [];
        const record = () => {
            // documentElement can still be null this early — an init script runs
            // before the parser has built <html>. Reading it unguarded threw, the
            // script aborted before the observer was attached, and __themeFlashes
            // stayed empty. An empty array then satisfies "no light frames"
            // trivially, so the spec asserts a length as well.
            const el = document.documentElement as HTMLElement | null;
            if (!el) return;
            w.__themeFlashes.push(el.getAttribute('data-theme') ?? '(none)');
        };
        record();
        // Observe `document` with subtree rather than documentElement directly:
        // document always exists at this point, and attribute mutations on <html>
        // are still delivered.
        new MutationObserver(record).observe(document, {
            attributes: true,
            subtree: true,
            attributeFilter: ['data-theme', 'class'],
        });
        // And catch the very first value once the parser has produced <html>,
        // in case the call above ran too early to see it.
        document.addEventListener('readystatechange', record);
    });
}

/** The values `data-theme` took, in order, since the document was created. */
export async function themeChanges(page: Page): Promise<string[]> {
    return page.evaluate(() => (window as unknown as { __themeFlashes: string[] }).__themeFlashes);
}

/**
 * Clear this caller's stored settings and device labels.
 *
 * Needed because `global-setup.ts` pre-dismisses the bookmark reminder for the
 * whole run. Rows 13.1 and 13.2 are ABOUT that flag, so a spec that inherits
 * the harness's pre-arranged state is asserting against something it did not
 * establish — a test that cannot fail. Call this in beforeEach for those specs
 * only; the other files rely on the global dismissal to keep the modal from
 * swallowing their clicks.
 */
export async function resetUserSettings(page: Page): Promise<void> {
    const res = await page.request.post('/api/settings/reset');
    if (!res.ok()) {
        throw new Error(`settings reset failed: ${res.status()} ${await res.text()}`);
    }
}

/**
 * Put back what `global-setup.ts` arranged: the bookmark reminder and the
 * service first-run prompt dismissed.
 *
 * Anything that calls resetUserSettings() MUST call this afterwards, before
 * the spec can throw. The reset clears the dismissal, and without the restore
 * every later spec in the serial run inherits the port-change <dialog> over its
 * clicks and fails with "intercepts pointer events" — nine specs across three
 * unrelated files, the first time it was missed. That failure names the wrong
 * file, which is why the restore is a named helper rather than an inline PATCH.
 */
export async function restoreHarnessPrompts(page: Page): Promise<void> {
    const res = await page.request.patch('/api/settings', {
        data: { bookmarkDismissedGlobally: true, serviceFirstRunSeen: true },
    });
    if (!res.ok()) {
        throw new Error(`could not restore the harness prompt state: ${res.status()} ${await res.text()}`);
    }
}

/** Read the caller's stored settings. */
export async function readUserSettings(page: Page): Promise<Record<string, unknown>> {
    const res = await page.request.get('/api/settings');
    if (!res.ok()) {
        throw new Error(`settings read failed: ${res.status()}`);
    }
    return (await res.json()) as Record<string, unknown>;
}
