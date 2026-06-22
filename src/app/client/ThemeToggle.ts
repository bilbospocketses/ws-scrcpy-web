import { firstPaintTheme, getTheme, notifyThemeChanged, setTheme } from '../public/themeEmbed';
import { settingsService } from './SettingsService';

const MOON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M21.752 15.002A9.718 9.718 0 0112.478 3.002a9.72 9.72 0 00-7.557 11.263A9.72 9.72 0 0016.49 21.78a9.718 9.718 0 005.262-6.778z"/></svg>`;
const SUN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm0 16a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zm8.66-12.66a1 1 0 010 1.414l-.707.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM6.046 17.246a1 1 0 010 1.414l-.707.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM22 12a1 1 0 01-1 1h-1a1 1 0 110-2h1a1 1 0 011 1zM5 12a1 1 0 01-1 1H3a1 1 0 110-2h1a1 1 0 011 1zm14.66 8.66a1 1 0 01-1.414 0l-.707-.707a1 1 0 111.414-1.414l.707.707a1 1 0 010 1.414zM6.046 6.754a1 1 0 01-1.414 0l-.707-.707a1 1 0 011.414-1.414l.707.707a1 1 0 010 1.414zM12 7a5 5 0 100 10 5 5 0 000-10z"/></svg>`;

/**
 * Applies the stored DB theme after the settings cache warms.
 * On first run (no stored theme), seeds the DB from the OS reading already
 * applied by initTheme's synchronous first paint.
 */
async function applyStoredTheme(): Promise<void> {
    await settingsService.loadGlobal();
    const stored = settingsService.getGlobalCached()['theme'];
    if (stored === 'dark' || stored === 'light') {
        setTheme(stored);
    } else {
        // First run: no theme in DB yet — persist the OS reading as the initial value.
        void settingsService.patchGlobal({ theme: getTheme() }).catch(() => {});
    }
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
