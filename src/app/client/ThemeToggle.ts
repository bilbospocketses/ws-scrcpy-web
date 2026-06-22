import { firstPaintTheme, getTheme, notifyThemeChanged, setTheme } from '../public/themeEmbed';
import { LEGACY_KEYS } from './migrateLocalStorage';
import { settingsService } from './SettingsService';

const MOON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M21.752 15.002A9.718 9.718 0 0112.478 3.002a9.72 9.72 0 00-7.557 11.263A9.72 9.72 0 0016.49 21.78a9.718 9.718 0 005.262-6.778z"/></svg>`;
const SUN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm0 16a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zm8.66-12.66a1 1 0 010 1.414l-.707.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM6.046 17.246a1 1 0 010 1.414l-.707.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM22 12a1 1 0 01-1 1h-1a1 1 0 110-2h1a1 1 0 011 1zM5 12a1 1 0 01-1 1H3a1 1 0 110-2h1a1 1 0 011 1zm14.66 8.66a1 1 0 01-1.414 0l-.707-.707a1 1 0 111.414-1.414l.707.707a1 1 0 010 1.414zM6.046 6.754a1 1 0 01-1.414 0l-.707-.707a1 1 0 011.414-1.414l.707.707a1 1 0 010 1.414zM12 7a5 5 0 100 10 5 5 0 000-10z"/></svg>`;

/**
 * Pure helper: should we seed the DB with the OS-derived theme?
 *
 * We seed ONLY when all of:
 *   (a) there is no stored theme in the DB yet, AND
 *   (b) the localStorage→DB migration has already completed.
 *
 * The gate on (b) is critical: `initTheme()` runs at module-eval, before
 * `window.onload`. The migration runs later in `window.onload` and also
 * PATCHes the `theme` key (with the user's saved legacy value). If we seeded
 * unconditionally, the OS-derived write could land AFTER the migration write
 * and silently overwrite the user's saved theme (data loss). Deferring until
 * the migration flag is present means: if the flag is absent we skip the seed
 * this session — the migration will write the correct value, and a subsequent
 * load will reach the seed branch only on a genuinely fresh install.
 */
export function shouldSeedTheme(hasStoredTheme: boolean, migrationDone: boolean): boolean {
    return !hasStoredTheme && migrationDone;
}

/**
 * Applies the stored DB theme after the settings cache warms.
 * On first run (no stored theme AND migration complete), seeds the DB from
 * the OS reading already applied by initTheme's synchronous first paint.
 *
 * The seed is gated on migration completion to avoid a race with the
 * localStorage→DB migration that runs later in window.onload: if migration is
 * still pending, it will write the user's saved theme, and the next load will
 * seed correctly if the install is genuinely fresh.
 */
async function applyStoredTheme(): Promise<void> {
    await settingsService.loadGlobal();
    const stored = settingsService.getGlobalCached()['theme'];
    if (stored === 'dark' || stored === 'light') {
        setTheme(stored);
    } else if (shouldSeedTheme(false, localStorage.getItem(LEGACY_KEYS.migratedFlag) !== null)) {
        // Fresh install (migration complete, no stored theme): persist the OS reading.
        void settingsService.patchGlobal({ theme: getTheme() }).catch(() => {});
    }
    // If migration is pending: do nothing — migration will write the user's theme.
}

export function initTheme(): void {
    // Synchronous first paint from OS preference — no await, no flash-to-blank.
    setTheme(firstPaintTheme(window.matchMedia('(prefers-color-scheme: dark)').matches));
    // Async: DB becomes authoritative once the cache is warm.
    void applyStoredTheme();
}

export function createThemeToggle(): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'theme-toggle';

    const refresh = (): void => {
        const theme = getTheme();
        btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
        btn.innerHTML = theme === 'dark' ? SUN_SVG : MOON_SVG;
    };

    refresh();

    btn.addEventListener('click', () => {
        const next = getTheme() === 'dark' ? 'light' : 'dark';
        setTheme(next);
        notifyThemeChanged();
        // Persist the user's choice to the DB (fire-and-forget).
        void settingsService.patchGlobal({ theme: next }).catch(() => {});
        // refresh() is called by the MutationObserver below — no need to call inline.
    });

    const observer = new MutationObserver(() => {
        // Lazy self-disconnect: if our button is no longer in the DOM
        // (e.g., the modal that hosted it was closed), stop observing.
        // Bounded: at worst the observer survives until the next theme
        // change; theme changes are rare so the leak is small even in
        // the pathological case.
        if (!document.body.contains(btn)) {
            observer.disconnect();
            return;
        }
        refresh();
    });
    observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
    });

    return btn;
}
