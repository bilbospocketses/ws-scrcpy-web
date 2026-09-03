import type { Page } from '@playwright/test';

/**
 * Helpers for the theming, accessibility and settings-prompt specs.
 *
 * The theme lives in ONE place at runtime: the `data-theme` attribute on
 * <html>. `initTheme()` sets it synchronously from `prefers-color-scheme` so
 * the first paint is right, then `applyStoredTheme()` overwrites it from the
 * DB once that loads. Both facts matter to row 16.6, which is about the window
 * between them — and to every other theme spec, which must not read the
 * attribute while that second write is still pending.
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
 * Wait until the app has finished its boot-time theme write.
 *
 * The theme toggle is appended to the header strictly AFTER the awaited
 * `applyStoredTheme()` in the boot sequence, so its presence proves no further
 * writer to `data-theme` is pending. Any spec that reads the attribute, or sets
 * it by hand, without this barrier is racing a deferred fetch and will
 * intermittently fail while blaming the stylesheet.
 *
 * Deliberately not `networkidle` (the device pollers keep the page busy) and
 * not an `expect.poll` on the attribute (a value read can be overwritten after
 * it was read).
 */
export async function waitForThemeSettled(page: Page): Promise<void> {
    await page.locator('button.theme-toggle').waitFor();
}

/**
 * Record every value `data-theme` takes, tagged with the document's
 * readyState at the time, starting BEFORE the page's own scripts run.
 *
 * addInitScript runs in each fresh document ahead of anything the app loads,
 * so the observer is live for the first style recalculation — which is the
 * moment row 16.6 is about. Asserting after `goto()` resolves would be too
 * late: the flash it exists to catch would already be over.
 *
 * The readyState tag is what makes '(none)' meaningful. The app's bundle is a
 * parser-blocking script, so a synchronous `initTheme()` MUST have run by the
 * time the document is 'interactive'; an attribute still absent at that point
 * is a wrong paint (the stylesheet's attribute-less default is dark), not an
 * innocent early frame.
 */
export async function recordThemeChanges(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const w = window as unknown as { __themeFlashes: string[] };
        w.__themeFlashes = [];
        const record = () => {
            // documentElement can still be null this early — an init script runs
            // before the parser has built <html>. Reading it unguarded threw, the
            // script aborted before the observer was attached, and __themeFlashes
            // stayed empty. An empty array then satisfies "no wrong frames"
            // trivially, so the spec asserts a length as well.
            const el = document.documentElement as HTMLElement | null;
            if (!el) return;
            w.__themeFlashes.push(`${document.readyState}:${el.getAttribute('data-theme') ?? '(none)'}`);
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
        // And sample at every readyState transition, so a frame exists for
        // 'interactive' and 'complete' even if the attribute never changed.
        document.addEventListener('readystatechange', record);
    });
}

/** The recorded frames, in order, as { state, theme } pairs. */
export async function themeFrames(page: Page): Promise<{ state: string; theme: string }[]> {
    const raw = await page.evaluate(() => (window as unknown as { __themeFlashes: string[] }).__themeFlashes);
    return raw.map((f) => {
        const i = f.indexOf(':');
        return { state: f.slice(0, i), theme: f.slice(i + 1) };
    });
}

/**
 * Clear this caller's stored settings and device labels.
 *
 * Needed because `global-setup.ts` pre-dismisses the bookmark reminder for the
 * whole run. Rows 13.1 and 13.2 are ABOUT that flag, so a spec that inherits
 * the harness's pre-arranged state is asserting against something it did not
 * establish — a test that cannot fail. Every caller MUST pair this with
 * restoreHarnessPrompts() before it can throw.
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
 * Idempotent, so calling it again from a `finally` is safe.
 */
export async function restoreHarnessPrompts(page: Page): Promise<void> {
    const res = await page.request.patch('/api/settings', {
        data: { bookmarkDismissedGlobally: true, serviceFirstRunSeen: true },
    });
    if (!res.ok()) {
        throw new Error(`could not restore the harness prompt state: ${res.status()} ${await res.text()}`);
    }
}

/**
 * Mark first run complete again. The seed config the fast tier boots with says
 * so already; a spec that flips it to false (13.2 exercises the post-reset
 * reload that re-shows the welcome modal) must put it back, or every later spec
 * inherits that <dialog> over its clicks exactly as with the bookmark one.
 */
export async function restoreFirstRun(page: Page): Promise<void> {
    const res = await page.request.patch('/api/config', { data: { firstRunComplete: true } });
    if (!res.ok()) {
        throw new Error(`could not restore firstRunComplete: ${res.status()} ${await res.text()}`);
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
