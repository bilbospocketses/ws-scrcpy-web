import { expect, test } from '@playwright/test';
import { gotoHome } from './support/consent';
import {
    cssVar,
    currentTheme,
    readUserSettings,
    recordThemeChanges,
    resetUserSettings,
    restoreHarnessPrompts,
    themeFrames,
    waitForThemeSettled,
} from './support/theme';

/**
 * Smoke module 16 — accessibility and theming (rows 16.1–16.6).
 *
 * Six `[Both]` rows of pure browser behaviour, which is why they are the first
 * batch automated: they need no device, no credential and no new isolation
 * machinery, and three of them map onto Playwright primitives that exist for
 * exactly this (`emulateMedia`, `colorScheme`, `:focus-visible`).
 *
 * Every spec here reads or writes the theme, which the app also writes
 * asynchronously at boot. `waitForThemeSettled()` is the barrier that keeps
 * those two writers from racing; an assertion made before it is a coin toss
 * that blames the stylesheet when it loses.
 */
test.describe('accessibility and theming', () => {
    test.afterEach(async ({ page }) => {
        // Every spec here owns its state. 16.1 persists a theme choice and 16.4
        // sets the attribute by hand (which the fresh-install seed would then
        // write to the DB); without this a later spec inherits whichever theme
        // ran last and either false-fails or passes against the wrong reading.
        //
        // 16.6 drives its own browser context and never navigates the fixture
        // page, so that page holds no token cookie and both calls below would be
        // refused with 403 -- which Playwright then reports as 16.6 failing at
        // resetUserSettings(), pointing nowhere near this hook. Mint the cookie
        // first when the page was never used.
        if (page.url() === 'about:blank') await page.goto('/');
        await resetUserSettings(page);
        await restoreHarnessPrompts(page);
    });

    test('16.1 the theme toggle recolors the UI and survives a reload', async ({ page }) => {
        await gotoHome(page);
        await waitForThemeSettled(page);
        const toggle = page.locator('button.theme-toggle');

        const before = await currentTheme(page);
        expect(before === 'dark' || before === 'light').toBe(true);
        // A rendered colour, not just the attribute: a broken theme block or a
        // 404'd stylesheet flips the attribute exactly as a working one does.
        const bgBefore = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

        await toggle.click();
        const after = await currentTheme(page);
        expect(after).not.toBe(before);
        const bgAfter = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        expect(bgAfter).not.toBe(bgBefore);

        // The row's real claim is the WRITE: the choice is persisted, so it comes
        // back after a reload rather than the OS reading initTheme() applies
        // first. Prove the write landed before reloading — the click's PATCH is
        // fire-and-forget, and a reload that wins that race would pass on a
        // build whose toggle never persists anything, simply because initTheme
        // happened to agree.
        await expect.poll(async () => (await readUserSettings(page))['theme']).toBe(after);

        await page.reload();
        await waitForThemeSettled(page);
        expect(await currentTheme(page)).toBe(after);
    });

    test('16.2 a keyboard focus ring appears on Tab and NOT on a mouse click', async ({ page }) => {
        await gotoHome(page);
        await waitForThemeSettled(page);
        const toggle = page.locator('button.theme-toggle');

        // Negative half FIRST, because it is the half that discriminates. And it
        // must read the PAINTED outline, not `:focus-visible`: that pseudo-class
        // reports the browser's input-modality heuristic, which no stylesheet
        // can change, so a build painting a ring on every mouse click still
        // answers false to it. The row's regression is a rule like
        // `:focus { outline: ... }`, and only the computed outline sees that.
        //
        // Strictly mouse — no key may be pressed before this reads. Any
        // keystroke (an Escape to close a modal, say) flips the browser into
        // keyboard mode and makes the subsequent focus match. The theme toggle
        // is used because clicking it opens nothing that would need dismissing.
        await toggle.click();
        const afterMouse = await toggle.evaluate((el) => ({
            hasFocus: document.activeElement === el,
            focusVisible: el.matches(':focus-visible'),
            outlineStyle: getComputedStyle(el).outlineStyle,
        }));
        expect(afterMouse.hasFocus, 'the click must have focused the toggle, or the negative measures nothing').toBe(
            true,
        );
        expect(afterMouse.focusVisible).toBe(false);
        expect(afterMouse.outlineStyle).toBe('none');

        // Positive half: Shift+Tab from the toggle lands on the settings button
        // beside it — asserted by identity, so the subject is not whatever the
        // async render state made first-focusable. The ring must be the app's
        // own 2px accent rule, not the UA default that :focus-visible paints
        // anyway: a deleted or transparent app rule passes "some outline".
        await page.keyboard.press('Shift+Tab');
        const focused = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            if (!el) return null;
            const probe = document.createElement('span');
            probe.style.color = 'var(--accent-color)';
            document.body.appendChild(probe);
            const accent = getComputedStyle(probe).color;
            probe.remove();
            const cs = getComputedStyle(el);
            return {
                isSettingsHeader: el.matches('button.settings-header'),
                className: el.className,
                focusVisible: el.matches(':focus-visible'),
                outlineStyle: cs.outlineStyle,
                outlineWidth: cs.outlineWidth,
                outlineColor: cs.outlineColor,
                accent,
            };
        });
        expect(focused?.isSettingsHeader, `expected button.settings-header, got .${focused?.className}`).toBe(true);
        expect(focused?.focusVisible).toBe(true);
        expect(focused?.outlineStyle).toBe('solid');
        expect(focused?.outlineWidth).toBe('2px');
        expect(focused?.outlineColor).toBe(focused?.accent);
    });

    test('16.3 reduced motion collapses transitions AND animations to near-instant', async ({ page }) => {
        // Both halves of the global reset are probed, because the row names
        // spinners and every spinner in the app is a CSS animation. A probe of
        // transition-duration alone stays green with the animation lines
        // deleted, while the service-op spinner loops at full speed under
        // `reduce`. Computed values reflect the declarations even without a
        // matching @keyframes.
        const probe = () =>
            page.evaluate(() => {
                const el = document.createElement('div');
                el.style.transition = 'opacity 300ms linear';
                el.style.animation = 'probe 800ms linear infinite';
                document.body.appendChild(el);
                const cs = getComputedStyle(el);
                const out = {
                    transitionDuration: cs.transitionDuration,
                    animationDuration: cs.animationDuration,
                    animationIterationCount: cs.animationIterationCount,
                };
                el.remove();
                return out;
            });

        // Control half: with the preference OFF the declarations stand as written.
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await gotoHome(page);
        const normal = await probe();
        expect(normal.transitionDuration).toBe('0.3s');
        expect(normal.animationDuration).toBe('0.8s');
        expect(normal.animationIterationCount).toBe('infinite');

        // With it ON the reset clamps them. 0.01ms, not 0 — app.css collapses
        // rather than removes, so state changes stay legible; a `none` would
        // read as 0s and is asserted against as well.
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.reload();
        const reduced = await probe();
        for (const v of [reduced.transitionDuration, reduced.animationDuration]) {
            expect(v).not.toBe('0.3s');
            expect(v).not.toBe('0.8s');
            expect(Number.parseFloat(v)).toBeLessThan(0.01);
            expect(Number.parseFloat(v)).toBeGreaterThan(0);
        }
        expect(reduced.animationIterationCount).toBe('1');
    });

    test('16.4 light mode resolves the status tints to their light channel values', async ({ page }) => {
        await gotoHome(page);
        // Settle first: the hand-set attribute below would otherwise race the
        // boot-time DB apply, producing intermittent false failures that blame
        // app.css.
        await waitForThemeSettled(page);

        // The subject is the --danger-rgb / --success-rgb channel triplets, NOT
        // --danger-color. The commit the row was written after (36c0fb4) added
        // exactly those four lines; the hex colours already existed and were
        // never the bug. The tinted backgrounds consume the triplets through
        // rgba(var(--danger-rgb), …), so a dark triplet in the light block is
        // the realistic regression — and a spec reading --danger-color passes
        // on it. The consumer probe proves the token actually feeds a paint.
        const read = () =>
            page.evaluate(() => {
                const el = document.createElement('div');
                el.style.background = 'rgba(var(--danger-rgb), 0.1)';
                document.body.appendChild(el);
                const consumer = getComputedStyle(el).backgroundColor;
                el.remove();
                const root = getComputedStyle(document.documentElement);
                return {
                    dangerRgb: root.getPropertyValue('--danger-rgb').trim(),
                    successRgb: root.getPropertyValue('--success-rgb').trim(),
                    consumer,
                };
            });

        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
        const light = await read();
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
        const dark = await read();

        expect(light.dangerRgb).not.toBe(dark.dangerRgb);
        expect(light.successRgb).not.toBe(dark.successRgb);
        expect(light.dangerRgb).toBe('185, 28, 28');
        expect(light.successRgb).toBe('21, 128, 61');
        expect(light.consumer).toBe('rgba(185, 28, 28, 0.1)');
        expect(dark.consumer).toBe('rgba(240, 108, 117, 0.1)');
        // The hex tokens too — they are what --danger-color consumers see.
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
        expect((await cssVar(page, '--danger-color')).toLowerCase()).toBe('#b91c1c');

        // NOT covered here, and said so: the file-row and delete-hover tints the
        // row names live in listfiles.css, which is loaded only with the file
        // browser modal — a device-tier surface.
    });

    test('16.5 the embed page declares a lang, matching the app shell', async ({ page, request }) => {
        await gotoHome(page);
        const shellLang = await page.evaluate(() => document.documentElement.getAttribute('lang'));
        expect(shellLang).toBeTruthy();

        // Fetched rather than navigated: embed.html is a static copy served
        // beside embed.js, and the assertion is about the markup as shipped.
        const [embedRes, shellRes] = await Promise.all([request.get('/embed.html'), request.get('/')]);
        expect(embedRes.ok()).toBe(true);
        const html = await embedRes.text();
        const m = html.match(/<html[^>]*\slang="([^"]+)"/i);
        expect(m, 'embed.html <html> has no lang attribute').not.toBeNull();
        expect(m?.[1]).toBe(shellLang);
        // A discriminator: any 200 HTML with lang="en" would satisfy the regex
        // alone (a login page, for instance). The embed page must be its own
        // document, not the shell served under another path.
        expect(html).not.toBe(await shellRes.text());
    });

    for (const scheme of ['dark', 'light'] as const) {
        test(`16.6 the first paint matches a ${scheme} OS scheme with no flash of the other theme`, async ({
            browser,
        }) => {
            // BOTH schemes, and light is the one that matters: the stylesheet's
            // attribute-less default is the dark block, so under a dark OS a
            // missing or late initTheme() paints correctly by accident. Only a
            // light OS turns "no attribute yet" into a wrong paint.
            const wrong = scheme === 'dark' ? 'light' : 'dark';
            const ctx = await browser.newContext({ colorScheme: scheme });
            const page = await ctx.newPage();
            try {
                // The row's premise is "no saved theme". A stored choice
                // legitimately wins over the OS reading, so establish the premise
                // rather than inherit whatever ran before. A real navigation is
                // needed to mint the API token cookie (one minted by an
                // APIRequestContext GET is refused with 403) — but that boots the
                // app, whose fresh-install seed writes the theme FIRE-AND-FORGET,
                // so a reset issued straight away can race the seed and lose.
                // Wait for the seed to land, THEN wipe it, then prove it is gone.
                await page.goto('/');
                await waitForThemeSettled(page);
                await expect.poll(async () => (await readUserSettings(page))['theme']).not.toBeUndefined();
                await resetUserSettings(page);
                expect((await readUserSettings(page))['theme']).toBeUndefined();

                // Only now arm the recorder, and load: addInitScript must be in
                // place before the first paint of the load being measured.
                await recordThemeChanges(page);
                await page.goto('/');
                // Let the boot-time DB apply finish before reading, so the
                // "then your saved choice takes over once loaded" clause is
                // observed rather than assumed.
                await waitForThemeSettled(page);
                const frames = await themeFrames(page);
                const finalTheme = await currentTheme(page);
                const seeded = (await readUserSettings(page))['theme'];

                // Put the harness's prompt dismissal back BEFORE asserting, so a
                // failing assertion cannot skip it. Not only in the finally: a
                // throw there would mask the assertion that actually failed.
                await restoreHarnessPrompts(page);

                // Something must have been recorded, or the observer never armed
                // and an empty array satisfies every filter below trivially.
                expect(frames.length).toBeGreaterThan(0);
                // No frame at any readyState may be the OTHER theme.
                expect(frames.filter((f) => f.theme === wrong)).toEqual([]);
                // And once the parser-blocking bundle has run — i.e. from
                // 'interactive' onward — the attribute must already be the OS
                // theme. '(none)' there is the FOUC the row exists to catch.
                const painted = frames.filter((f) => f.state !== 'loading');
                expect(painted.length).toBeGreaterThan(0);
                expect(painted.filter((f) => f.theme !== scheme)).toEqual([]);
                expect(finalTheme).toBe(scheme);
                // The fresh-install seed persisted the OS reading.
                expect(seeded).toBe(scheme);
            } finally {
                // Safety net for the reset-to-restore window above: a goto
                // timeout or an evaluate throw must not leave every later file
                // with the port-change <dialog> over its clicks. Idempotent.
                await restoreHarnessPrompts(page).catch((e) => console.error('[16.6] restore failed', e));
                await ctx.close();
            }
        });
    }
});
