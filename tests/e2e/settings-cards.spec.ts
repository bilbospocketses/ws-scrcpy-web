import { expect, type Locator, type Page, test } from '@playwright/test';
import { openSettings, openSettingsTab, type SettingsTabTitle, settingsRow } from './support/auth';
import { gotoHome } from './support/consent';
import { waitForThemeSettled } from './support/theme';
import { guardTlsWrites, stubTlsState } from './support/tlsPanel';

/**
 * Settings cards (0.5.5): every tab has the Dependencies tab's look. The unit
 * tests pin the DOM the tabs build (settingsLayout.test.ts) and the CSS text;
 * this is what a browser makes of the two -- colors, lines, sizes and where
 * things land -- which jsdom cannot tell.
 *
 * Read-only against the shared server: nothing here saves, and every
 * /api/tls write is caught in the browser.
 */

// src/style/app.css --settings-card-bg, as the browser reports a computed color.
const CARD_BG = { dark: 'rgb(37, 37, 37)', light: 'rgb(233, 237, 242)' } as const;
// app.css --button-border-color, the Dependencies table's row line.
const LINE = { dark: 'rgb(68, 68, 68)', light: 'rgb(192, 198, 204)' } as const;
// 18rem at the app's 14px root size (app.css --font-size).
const LABELS_COLUMN_PX = 18 * 14;

const CARD_TABS: SettingsTabTitle[] = ['Users', 'Embedding', 'Updates', 'Service', 'Server', 'Local HTTPS'];

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
    // The boot's own theme write (applyStoredTheme, after a settings fetch)
    // must land first, or it overwrites this one and the dark run measures the
    // light colors -- as on #961's CI (2026-10-10).
    await waitForThemeSettled(page);
    // The attribute only, nothing persisted: the shared server's theme is not this spec's to change.
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
}

/** Open a tab and wait for what it fills in after it is built. */
async function openTab(settings: Locator, title: SettingsTabTitle): Promise<Locator> {
    const section = await openSettingsTab(settings, title);
    if (title === 'Local HTTPS') await expect(section.locator('[data-tls-generate]')).toBeVisible();
    if (title === 'Service') await expect(section).not.toContainText('loading install/uninstall status…');
    if (title === 'Updates') await expect(section).not.toContainText('loading…');
    if (title === 'Dependencies') await expect(section.locator('.section-card')).toBeVisible();
    return section;
}

/** Every item of a card that is on screen, with the width of its top line. */
async function visibleItems(card: Locator): Promise<{ display: string; borderTop: string; borderColor: string }[]> {
    return card.locator(':scope > .settings-item').evaluateAll((items) =>
        items.map((item) => {
            const style = getComputedStyle(item);
            return { display: style.display, borderTop: style.borderTopWidth, borderColor: style.borderTopColor };
        }),
    );
}

test.describe('settings cards (0.5.5)', () => {
    test.beforeEach(async ({ page }) => {
        await guardTlsWrites(page);
        await page.setViewportSize({ width: 1280, height: 1000 });
        await gotoHome(page);
    });

    for (const theme of ['dark', 'light'] as const) {
        test(`every tab puts its settings in a card of the Dependencies card's color (${theme})`, async ({ page }) => {
            await setTheme(page, theme);
            const settings = await openSettings(page);
            for (const title of CARD_TABS) {
                const section = await openTab(settings, title);
                const cards = section.locator('.settings-card:visible');
                expect(await cards.count(), title).toBeGreaterThan(0);
                for (const card of await cards.all()) {
                    await expect(card, title).toHaveCSS('background-color', CARD_BG[theme]);
                    await expect(card, title).toHaveCSS('border-radius', '8px');
                    await expect(card, title).toHaveCSS('padding', '4px 16px');
                }
                // Every setting and note is inside a card: none on screen outside one.
                // (Labels, not rows: a row is display:contents and has no box. And
                // notes: a dev build's Updates tab is one note and no setting.)
                const lines = '.settings-label:visible, .settings-status:visible, .settings-stub-note:visible';
                const shown = await section.locator(lines).count();
                expect(shown, title).toBeGreaterThan(0);
                expect(await section.locator('.settings-card').locator(lines).count(), title).toBe(shown);
                // No divider of the section's own any more.
                await expect(section, title).toHaveCSS('border-bottom-width', '0px');
            }
            // The Dependencies panel's own card is painted from the same token.
            const deps = await openTab(settings, 'Dependencies');
            await expect(deps.locator('.section-card')).toHaveCSS('background-color', CARD_BG[theme]);
        });

        test(`a line runs between two showing items, never after the last, in the table's row color (${theme})`, async ({
            page,
        }) => {
            await setTheme(page, theme);
            const settings = await openSettings(page);
            for (const title of CARD_TABS) {
                const section = await openTab(settings, title);
                for (const card of await section.locator('.settings-card:visible').all()) {
                    const items = await visibleItems(card);
                    const shown = items.filter((i) => i.display !== 'none');
                    expect(shown.length, title).toBeGreaterThan(0);
                    // No line above the first, one above each after it -- so none after the last.
                    expect(shown[0]!.borderTop, `${title}: first item`).toBe('0px');
                    for (const item of shown.slice(1)) {
                        expect(item.borderTop, title).toBe('1px');
                        expect(item.borderColor, title).toBe(LINE[theme]);
                    }
                }
            }
        });
    }

    test('an item with nothing showing takes no space: the Server tab hides the rows that do not apply', async ({
        page,
    }) => {
        const settings = await openSettings(page);
        const server = await openTab(settings, 'Server');
        await expect(settingsRow(server, 'http port').locator('input')).not.toHaveValue('');
        const application = server.locator('.settings-card', {
            has: page.locator('.settings-label', { hasText: 'stop the server and close the app' }),
        });
        // "install for all users" is Linux only, and built everywhere; where it is
        // hidden its item is display:none, and the stop item is then the first showing.
        const install = application.locator('.settings-item', {
            has: page.locator('.settings-label', { hasText: 'install for all users' }),
        });
        const installShown = await settingsRow(server, 'install for all users').locator('.settings-label').isVisible();
        await expect(install).toHaveCSS('display', installShown ? 'grid' : 'none');
        const stop = application.locator('.settings-item', {
            has: page.locator('.settings-label', { hasText: 'stop the server and close the app' }),
        });
        await expect(stop).toHaveCSS('border-top-width', installShown ? '1px' : '0px');
    });

    test('split tabs show each card under its own heading at the title size; the tab title is hidden from the eye', async ({
        page,
    }) => {
        const settings = await openSettings(page);
        const expected: [SettingsTabTitle, string[]][] = [
            ['Server', ['Settings', 'Ports', 'Application']],
            ['Local HTTPS', ['Certificate', 'Trust', 'Exposure']],
        ];
        for (const [title, headings] of expected) {
            const section = await openTab(settings, title);
            const cardHeadings = section.locator('h4.settings-card-heading');
            await expect(cardHeadings).toHaveText(headings);
            for (const h of await cardHeadings.all()) await expect(h).toHaveCSS('font-size', '18px');
            await expect(cardHeadings.first()).toHaveCSS('margin-top', '0px');
            await expect(cardHeadings.nth(1)).toHaveCSS('margin-top', `${1.25 * 14}px`);
            // The title stays a heading for a screen reader, drawn as nothing.
            const titleBox = await section.locator('h3.settings-section-heading').boundingBox();
            expect(titleBox!.width, `${title} title`).toBeLessThanOrEqual(1);
            await expect(section.getByRole('heading', { name: title, exact: true, level: 3 })).toHaveCount(1);
        }
        // A single-card tab keeps its title, at the Dependencies h2 size.
        const users = await openTab(settings, 'Users');
        const usersTitle = users.locator('h3.settings-section-heading');
        await expect(usersTitle).toBeVisible();
        await expect(usersTitle).toHaveCSS('font-size', '18px');
        await expect(users.locator('h4')).toHaveCount(0);
    });

    test('the labels column is 18rem and the controls line up across tabs', async ({ page }) => {
        const settings = await openSettings(page);
        const left = async (l: Locator): Promise<number> => (await l.boundingBox())?.x ?? Number.NaN;
        const users = await openTab(settings, 'Users');
        const usersControl = settingsRow(users, 'user accounts').locator('.settings-control');
        const usersLabel = settingsRow(users, 'user accounts').locator('.settings-label');
        expect((await usersLabel.boundingBox())!.width).toBeCloseTo(LABELS_COLUMN_PX, 0);
        const x = await left(usersControl);

        const server = await openTab(settings, 'Server');
        expect(await left(settingsRow(server, 'reset all my settings').locator('.settings-control'))).toBeCloseTo(x, 0);
        expect(await left(settingsRow(server, 'http port').locator('.settings-control'))).toBeCloseTo(x, 0);
        const embedding = await openTab(settings, 'Embedding');
        expect(await left(settingsRow(embedding, 'add an embedder').locator('.settings-control'))).toBeCloseTo(x, 0);
        const https = await openTab(settings, 'Local HTTPS');
        expect(await left(settingsRow(https, 'certificate subject').locator('.settings-control'))).toBeCloseTo(x, 0);
    });

    test('plain notes are regular weight and italic; warnings and errors stay bold', async ({ page }) => {
        await stubTlsState(page, {
            status: 'none',
            candidateIps: ['192.168.50.10'],
            httpExposure: 'open',
            httpsListener: { bound: false },
            httpsPort: 8443,
        });
        const settings = await openSettings(page);
        const https = await openTab(settings, 'Local HTTPS');
        const guide = https.locator('[data-tls-subject-guide]');
        await expect(guide).toHaveCSS('font-weight', '400');
        await expect(guide).toHaveCSS('font-style', 'italic');
        await expect(https.locator('[data-tls-trust-help]')).toHaveCSS('font-weight', '400');
        // A warning keeps the weight (and its color).
        const unavailable = https.locator('[data-exposure-unavailable-notice]');
        await expect(unavailable).toBeVisible();
        await expect(unavailable).toHaveCSS('font-weight', '600');

        const server = await openTab(settings, 'Server');
        const restart = server.locator('[data-port-restart-note]');
        await expect(restart).toBeVisible();
        await expect(restart).toHaveCSS('font-weight', '400');
    });

    test('Embedding: the add row is one line at 1280px, even with "http & https" chosen, inside its card; the empty-list line spans both columns', async ({
        page,
    }) => {
        const settings = await openSettings(page);
        const embedding = await openTab(settings, 'Embedding');
        const address = embedding.getByRole('textbox', { name: 'embedder address' });
        const port = embedding.getByRole('textbox', { name: 'embedder port' });
        const scheme = embedding.getByRole('combobox', { name: 'embedder scheme' });
        const add = embedding.locator('[data-embed-add-button]');
        await expect(add).toBeVisible();
        await scheme.selectOption('both');

        const middle = async (l: Locator): Promise<number> => {
            const box = await l.boundingBox();
            return box ? box.y + box.height / 2 : Number.NaN;
        };
        const line = await middle(address);
        for (const [name, l] of [
            ['port', port],
            ['scheme', scheme],
            ['add', add],
        ] as const) {
            expect(Math.abs((await middle(l)) - line), `${name} on the address's line`).toBeLessThan(2);
        }
        // Inside the card, not spilling past its padding.
        const card = (await embedding.locator('.settings-card').boundingBox())!;
        const addBox = (await add.boundingBox())!;
        expect(addBox.x + addBox.width).toBeLessThanOrEqual(card.x + card.width - 16 + 1);
        // The scheme list shows its longest option whole.
        expect((await scheme.boundingBox())!.width).toBeGreaterThan(100);

        // The empty-state line is text, not a setting: it spans both columns.
        const empty = embedding.locator('[data-embed-list] .settings-label');
        if ((await empty.textContent()) === 'No other origins may embed this app.') {
            expect((await empty.boundingBox())!.width).toBeGreaterThan(LABELS_COLUMN_PX + 100);
        }
    });
});
