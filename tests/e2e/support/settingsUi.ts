import { type APIRequestContext, expect, type Locator, type Page } from '@playwright/test';

/**
 * The Settings dialog's staged save (smoke 13.4-13.9) and the first-run cards
 * (1.11, 13.10), as the browser sees them: the review and unsaved-changes
 * dialogs, typing the way a user does, a record of every write the page sends,
 * and an Updates tab that believes it is an installed build.
 *
 * The dialog plumbing that every settings row shares (opening the dialog, a
 * tab, a row) stays in auth.ts; this is what the staged-save rows add to it.
 */

// ---------------------------------------------------------------------------
// Network observation and stubs
// ---------------------------------------------------------------------------

export interface SeenRequest {
    method: string;
    path: string;
    body: unknown;
}

/**
 * The boot-time theme persist: a user with no stored theme has the OS reading
 * written back on EVERY page load (`applyStoredTheme` in ThemeToggle.ts), so a
 * fresh or reset user sends `PATCH /api/settings {"theme": …}` whatever else
 * happens on the page. No row that records writes is about it.
 */
export function isThemePersist(w: SeenRequest): boolean {
    return (
        w.method === 'PATCH' &&
        w.path === '/api/settings' &&
        typeof w.body === 'object' &&
        w.body !== null &&
        Object.keys(w.body).join(',') === 'theme'
    );
}

/** The per-user flags the reminder cards and the welcome modal write. */
export const PROMPT_FLAGS = ['bookmarkDismissedForPort', 'bookmarkDismissedGlobally', 'serviceFirstRunSeen'] as const;

/**
 * Record every NON-GET request the page sends to `/api/`. "Nothing is written"
 * is asserted against this: a write has to be a non-GET.
 *
 * Everything is recorded except the boot-time theme persist
 * (`isThemePersist`), which a user with no stored theme sends on load
 * regardless of what the row does, and which lands at a time no spec controls.
 */
export function recordApiWrites(page: Page): SeenRequest[] {
    const seen: SeenRequest[] = [];
    page.on('request', (req) => {
        const url = new URL(req.url());
        if (req.method() === 'GET' || !url.pathname.startsWith('/api/')) return;
        let body: unknown = null;
        try {
            body = req.postDataJSON();
        } catch {
            body = req.postData();
        }
        const write = { method: req.method(), path: url.pathname, body };
        if (!isThemePersist(write)) seen.push(write);
    });
    return seen;
}

export const INSTALLED_VERSION = '0.0.0-e2e';

/**
 * Make the Updates tab render its controls on a build that is not installed.
 *
 * The fast tier runs `node dist/index.js`, which is not a Velopack install, so
 * GET /api/updates/status answers `isInstalled: false` and the tab shows only
 * the dev-mode note (13.9's second half asserts exactly that, unstubbed). The
 * staged fields the rows are about exist only on the installed branch, so this
 * fetches the REAL status and flips that one flag. The four staged values
 * therefore stay the server's own, and Save still goes to the real
 * POST /api/settings/batch — only the GET is touched.
 */
export async function stubInstalledUpdates(page: Page): Promise<void> {
    await page.route('**/api/updates/status', async (route) => {
        // The rows that change the web port end the server mid-test, and the
        // pill keeps polling; a dead upstream is a failed request, not a
        // handler that throws into the test.
        let res: Awaited<ReturnType<typeof route.fetch>>;
        try {
            res = await route.fetch();
        } catch {
            await route.abort('connectionrefused');
            return;
        }
        const real = (await res.json()) as Record<string, unknown>;
        await route.fulfill({
            response: res,
            json: { ...real, isInstalled: true, currentVersion: INSTALLED_VERSION, status: 'idle' },
        });
    });
}

export interface UpdatesState {
    channel: string;
    autoUpdate: boolean;
    updateCheckIntervalMinutes: number;
    githubOwner: string;
}

/** The four staged values as the SERVER holds them (an unrouted request context). */
export async function serverUpdatesState(ctx: APIRequestContext): Promise<UpdatesState> {
    const res = await ctx.get('/api/updates/status');
    expect(res.status(), 'GET /api/updates/status').toBe(200);
    const s = (await res.json()) as UpdatesState;
    return {
        channel: s.channel,
        autoUpdate: s.autoUpdate,
        updateCheckIntervalMinutes: s.updateCheckIntervalMinutes,
        githubOwner: s.githubOwner,
    };
}

// ---------------------------------------------------------------------------
// Dialog locators and input
// ---------------------------------------------------------------------------

/**
 * The OPEN modal with this title. `Modal.close()` drops `open` at once but
 * leaves the element in the DOM for its exit transition (up to 250 ms,
 * src/app/ui/Modal.ts), so a prompt reopened inside that window would
 * otherwise match twice — the closing one and the new one — and fail strict
 * mode. A closed dialog is hidden either way, so `toBeHidden` still holds.
 */
function modalTitled(page: Page, title: string): Locator {
    return page
        .locator('dialog.modal[open]')
        .filter({ has: page.locator('.modal-title', { hasText: new RegExp(`^${title}$`) }) });
}

/** SettingsSummaryModal: "Review changes". */
export function reviewDialog(page: Page): Locator {
    return modalTitled(page, 'Review changes');
}

/** SettingsDirtyCloseModal: "Unsaved changes". */
export function unsavedDialog(page: Page): Locator {
    return modalTitled(page, 'Unsaved changes');
}

/** The review's lines, exactly as rendered. */
export function reviewLines(review: Locator): Locator {
    return review.locator('.settings-summary__list > li');
}

/** The dialog-level footer Save (lowercase `save`, `button.settings-save`). */
export function footerSave(settings: Locator): Locator {
    return settings.locator('button.settings-save');
}

/**
 * Type a value the way a user does, then leave the field.
 *
 * Typed, not `fill()`ed: the web-port guard hangs off `change`, and a
 * programmatic fill leaves the field un-dirtied so no blur commits it (13.3
 * measured this). The Updates fields commit on blur too.
 */
export async function typeAndLeave(input: Locator, value: string): Promise<void> {
    await input.click();
    await input.press('ControlOrMeta+a');
    await input.press('Delete');
    if (value.length > 0) await input.pressSequentially(value);
    await input.press('Tab');
}
