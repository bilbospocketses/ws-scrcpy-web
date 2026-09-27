import { expect, test } from '@playwright/test';
import { gotoHome } from './support/consent';

/**
 * WCAG 1.4.10 Reflow: at 320 CSS px wide, a phone held upright, the home page
 * must not need sideways scrolling.
 *
 * Two layouts broke it, both only below ~480 px, so nothing wider notices. The
 * Network Discovery header kept its title and three buttons on one row (#747),
 * and the device grid's `minmax(340px, 1fr)` held a column wider than the
 * screen. The device grid renders its tracker header with no device attached,
 * which is why this can run in the fast tier.
 *
 * NOT covered, and said so: the scan-result grid is only populated by a scan
 * hit, which the fast tier cannot produce. css-a11y.test.ts guards its floor.
 */
test.describe('responsive reflow', () => {
    for (const width of [320, 375]) {
        test(`the home page needs no sideways scrolling at ${width} CSS px`, async ({ page }) => {
            await page.setViewportSize({ width, height: 800 });
            await gotoHome(page);
            // Both layouts must have rendered, or a half-built page passes trivially.
            await expect(page.locator('#discovery-panel .discovery-header-actions button')).toHaveCount(3);
            await expect(page.locator('#devices .tracker-name')).toBeVisible();

            const measured = await page.evaluate(() => {
                const vw = document.documentElement.clientWidth;
                const wide: string[] = [];
                for (const el of document.querySelectorAll<HTMLElement>('body *')) {
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.right <= vw + 0.5) continue;
                    // Name only the outermost offender; its children follow it out.
                    const parent = el.parentElement;
                    if (parent && parent.getBoundingClientRect().right > vw + 0.5) continue;
                    const id = el.id ? `#${el.id}` : '';
                    const cls = el.classList.length ? `.${[...el.classList].join('.')}` : '';
                    wide.push(`${el.tagName.toLowerCase()}${id}${cls} (+${Math.round(r.right - vw)}px)`);
                }
                return { vw, scrollWidth: document.documentElement.scrollWidth, wide };
            });
            expect(measured.wide, 'elements extending past the right edge of the viewport').toEqual([]);
            expect(measured.scrollWidth).toBeLessThanOrEqual(measured.vw);
        });
    }
});
