import { expect, test } from '@playwright/test';
import { gotoHome } from './support/consent';
import {
    cssVar,
    currentTheme,
    recordThemeChanges,
    resetUserSettings,
    restoreHarnessPrompts,
    themeChanges,
} from './support/theme';

/**
 * Smoke module 16 — accessibility and theming (rows 16.1–16.6).
 *
 * Six `[Both]` rows of pure browser behaviour, which is why they are the first
 * batch automated: they need no device, no credential and no new isolation
 * machinery, and three of them map onto Playwright primitives that exist for
 * exactly this (`emulateMedia`, `colorScheme`, `:focus-visible`).
 *
 * The theme lives in the `data-theme` attribute on <html>. `initTheme()` sets it
 * synchronously from the OS preference, then `applyStoredTheme()` overwrites it
 * from the DB — the two-step that row 16.6 is about.
 */
test.describe('accessibility and theming', () => {
    test('16.1 the theme toggle recolors the UI and survives a reload', async ({ page }) => {
        await gotoHome(page);
        const before = await currentTheme(page);
        expect(before === 'dark' || before === 'light').toBe(true);

        await page.locator('button.theme-toggle').click();
        const after = await currentTheme(page);
        expect(after).not.toBe(before);

        // The row's real claim is persistence, not the attribute flip: the
        // choice is written to the DB, so a reload must come back to it rather
        // than to the OS reading initTheme() applies first.
        await page.reload();
        await expect.poll(() => currentTheme(page)).toBe(after);
    });

    test('16.2 a keyboard focus ring appears on Tab and NOT on a mouse click', async ({ page }) => {
        await gotoHome(page);

        // Negative half FIRST, because it is the half that discriminates: a spec
        // asserting only the positive passes both on a good build and on one
        // where every element carries a permanent ring.
        //
        // Strictly mouse — no key may be pressed before this reads. :focus-visible
        // is modality-sensitive, so ANY keystroke (an Escape to close a modal, for
        // instance) flips the browser into keyboard mode and makes the subsequent
        // focus match. That measures the test's own input, not the app's CSS.
        // The theme toggle is used because clicking it opens nothing that would
        // need dismissing.
        const toggle = page.locator('button.theme-toggle');
        await toggle.click();
        const afterMouse = await toggle.evaluate((el) => el.matches(':focus-visible'));
        expect(afterMouse).toBe(false);

        // Positive half: keyboard focus does match :focus-visible, and the rule
        // that paints it is live (the old global `:focus{outline:none}` is gone).
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            if (!el) return null;
            return {
                focusVisible: el.matches(':focus-visible'),
                outlineWidth: getComputedStyle(el).outlineWidth,
                outlineStyle: getComputedStyle(el).outlineStyle,
            };
        });
        expect(focused?.focusVisible).toBe(true);
        expect(focused?.outlineStyle).not.toBe('none');
        expect(focused?.outlineWidth).not.toBe('0px');
    });

    test('16.3 reduced motion collapses animations to near-instant', async ({ page }) => {
        // With the preference OFF, transitions have a real duration...
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await gotoHome(page);
        const normal = await page.evaluate(() => {
            const el = document.createElement('div');
            el.style.transition = 'opacity 300ms linear';
            document.body.appendChild(el);
            const d = getComputedStyle(el).transitionDuration;
            el.remove();
            return d;
        });
        expect(normal).toBe('0.3s');

        // ...and with it ON the global reset clamps them. 0.01ms, not 0 —
        // app.css collapses rather than removes, so state changes stay legible.
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.reload();
        const reduced = await page.evaluate(() => {
            const el = document.createElement('div');
            el.style.transition = 'opacity 300ms linear';
            document.body.appendChild(el);
            const d = getComputedStyle(el).transitionDuration;
            el.remove();
            return d;
        });
        expect(reduced).not.toBe('0.3s');
        expect(Number.parseFloat(reduced)).toBeLessThan(0.01);
    });

    test('16.4 light mode resolves the status tints to their light values', async ({ page }) => {
        await gotoHome(page);

        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
        const lightDanger = await cssVar(page, '--danger-color');
        const lightSuccess = await cssVar(page, '--success-color');

        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
        const darkDanger = await cssVar(page, '--danger-color');
        const darkSuccess = await cssVar(page, '--success-color');

        // The row exists because these used to render as off-shade DARK channel
        // values in light mode. Asserting they merely "have a value" would pass
        // in exactly that broken state, so assert they DIFFER by theme.
        expect(lightDanger).not.toBe(darkDanger);
        expect(lightSuccess).not.toBe(darkSuccess);
        expect(lightDanger.toLowerCase()).toBe('#b91c1c');
        expect(lightSuccess.toLowerCase()).toBe('#15803d');
    });

    test('16.5 the embed page declares a lang, matching the app shell', async ({ page, request }) => {
        await gotoHome(page);
        const shellLang = await page.evaluate(() => document.documentElement.getAttribute('lang'));
        expect(shellLang).toBeTruthy();

        // Fetched rather than navigated: embed.html is a static copy served
        // beside embed.js, and the assertion is about the markup as shipped.
        const res = await request.get('/embed.html');
        expect(res.ok()).toBe(true);
        const html = await res.text();
        const m = html.match(/<html[^>]*\slang="([^"]+)"/i);
        expect(m, 'embed.html <html> has no lang attribute').not.toBeNull();
        expect(m?.[1]).toBe(shellLang);
    });

    test('16.6 the first paint matches the OS scheme with no flash of the wrong theme', async ({ browser }) => {
        const ctx = await browser.newContext({ colorScheme: 'dark' });
        const page = await ctx.newPage();
        try {
            // The row's premise is "no saved theme (fresh profile / right after a
            // reset)". A stored choice legitimately wins over the OS reading, so
            // without clearing it this spec measures whatever theme an earlier
            // spec in this serial run happened to persist — which is how it first
            // reported three light frames on a dark load and looked like a FOUC.
            // Establish the premise rather than inherit one.
            await page.goto('/');
            await resetUserSettings(page);

            // Only now arm the recorder, and load again: addInitScript must be in
            // place before the first paint of the load being measured.
            await recordThemeChanges(page);
            await page.goto('/');
            const flashes = await themeChanges(page);
            const finalTheme = await currentTheme(page);

            // Put the harness's prompt dismissal back BEFORE asserting, so a
            // failing assertion cannot skip it. The reset above cleared it, and
            // without this every later spec in the run inherits the port-change
            // <dialog> over its clicks — nine specs in three unrelated files, the
            // first time it was missed. Not in the finally: a throw there would
            // mask the assertion that actually failed.
            await restoreHarnessPrompts(page);

            // Something must have been recorded, or the observer never armed and
            // an empty array would satisfy the filter below trivially.
            expect(flashes.length).toBeGreaterThan(0);
            // No recorded state may be the LIGHT theme at any point in a dark load.
            expect(flashes.filter((f) => /light/.test(f))).toEqual([]);
            expect(finalTheme).toBe('dark');
        } finally {
            await ctx.close();
        }
    });
});
