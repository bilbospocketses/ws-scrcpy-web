import { getTheme, type Theme } from '../public/themeEmbed';

/**
 * Links from the app to its help pages (`public/help/*.html`) carry the app's
 * current theme, so a guide opens in the theme the user is looking at (0.5.5).
 *
 * The help pages are static files with no access to the server's settings DB,
 * where the app keeps its theme since it stopped using localStorage
 * (`ThemeToggle.ts`). Their head script read `ws-scrcpy-web-theme` from
 * localStorage, which nothing writes any more, so every guide opened dark. They
 * read `?theme=light|dark` now, falling back to the OS preference.
 */

/** The subnet cheat sheet, linked from the scan and add-subnet dialogs. Relative, so it follows the app's own path. */
export const SUBNETS_HELP_HREF = 'help/subnets.html';

/**
 * `href` with `theme=<theme>` in its query, ahead of any `#hash`, replacing a
 * theme it already names. Other query parameters are kept.
 */
export function withHelpTheme(href: string, theme: Theme = getTheme()): string {
    const hashAt = href.indexOf('#');
    const hash = hashAt === -1 ? '' : href.slice(hashAt);
    const beforeHash = hashAt === -1 ? href : href.slice(0, hashAt);
    const queryAt = beforeHash.indexOf('?');
    const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
    const params = new URLSearchParams(queryAt === -1 ? '' : beforeHash.slice(queryAt + 1));
    params.set('theme', theme);
    return `${path}?${params.toString()}${hash}`;
}

/**
 * The pointer and keyboard events after which a browser follows a link, or
 * offers to: a click (or Enter), a middle click, and the context menu's "open
 * in new tab".
 */
const FOLLOW_EVENTS = ['click', 'auxclick', 'contextmenu'] as const;

/**
 * Make `link` (to a help page at `href`) carry the app's theme.
 *
 * The theme is decided when the link is followed, not when it is built: the
 * theme can change while the dialog holding the link stays open (the toggle
 * sits in the page header), and a link built in dark mode must still open the
 * guide light if the user has switched since. Each of the events a browser
 * follows a link after rewrites `href` before the browser reads it.
 */
export function themeHelpLink(link: HTMLAnchorElement, href: string): void {
    link.href = withHelpTheme(href);
    for (const type of FOLLOW_EVENTS) {
        link.addEventListener(type, () => {
            link.href = withHelpTheme(href);
        });
    }
}
