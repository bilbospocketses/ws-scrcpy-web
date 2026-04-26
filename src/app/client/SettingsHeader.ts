import { SettingsModal } from './SettingsModal';

// Hardcoded gear icon SVG (constant string, no user input). 24x24 viewBox; uses
// currentColor so it inherits the theme's text color. Mirrors the pattern in
// ThemeToggle.ts where SUN_SVG / MOON_SVG are assigned via innerHTML.
const GEAR_SVG_MARKUP = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" ',
    'viewBox="0 0 24 24" fill="currentColor">',
    '<path d="M19.14 12.94a7.99 7.99 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64',
    'l-1.92-3.32a.5.5 0 00-.6-.22l-2.39.96a7.94 7.94 0 00-1.62-.94l-.36-2.54',
    'a.5.5 0 00-.5-.42h-3.84a.5.5 0 00-.5.42l-.36 2.54a7.94 7.94 0 00-1.62.94',
    'l-2.39-.96a.5.5 0 00-.6.22L2.71 8.84a.5.5 0 00.12.64l2.03 1.58',
    'a7.99 7.99 0 000 1.88L2.83 14.52a.5.5 0 00-.12.64l1.92 3.32',
    'a.5.5 0 00.6.22l2.39-.96c.5.38 1.04.7 1.62.94l.36 2.54c.05.24.26.42.5.42',
    'h3.84c.24 0 .45-.18.5-.42l.36-2.54a7.94 7.94 0 001.62-.94l2.39.96',
    'a.5.5 0 00.6-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5',
    'a3.5 3.5 0 110-7 3.5 3.5 0 010 7z"/></svg>',
].join('');

export function createSettingsHeader(): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'settings-header';
    btn.title = 'Settings';
    btn.setAttribute('aria-label', 'Open settings');
    // Safe: GEAR_SVG_MARKUP is a hardcoded constant with no interpolation.
    btn.innerHTML = GEAR_SVG_MARKUP;

    btn.addEventListener('click', () => {
        new SettingsModal();
    });

    return btn;
}
