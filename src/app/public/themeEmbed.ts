/**
 * Public theme-embed helpers for ws-scrcpy-web.
 *
 * Exposes the same get/set semantics used internally by ThemeToggle, plus
 * postMessage helpers so a parent window (e.g., a host page embedding
 * ws-scrcpy-web in an iframe) can push theme changes across origins.
 *
 * Theme persistence has moved from localStorage to the DB (SettingsService).
 * This module is the public/embed layer — it must NOT import SettingsService.
 * All DB persistence lives in ThemeToggle.ts.
 */

export type Theme = 'dark' | 'light';

export interface ThemeEmbedOptions {
    /** Default 'ws-scrcpy-web:theme'. */
    messageType?: string;
    /**
     * Origins allowed to push theme messages. Default '*' — accepts any
     * origin. WARNING: leave as '*' only when ws-scrcpy-web is intended to be
     * embeddable by arbitrary hosts. Pass an explicit allowlist
     * (e.g., ['https://my-host.example']) for locked-down deployments.
     */
    allowedOrigins?: '*' | string[];
}

/** Returns the live DOM theme attribute — authoritative after DB apply. */
export function getTheme(): Theme {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Sets the data-theme DOM attribute only. Persistence is ThemeToggle's responsibility. */
export function setTheme(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Returns the first-paint theme based on the OS preference.
 * Pure function — usable in tests without a DOM or SettingsService.
 * ThemeToggle uses this synchronously to avoid a flash-of-wrong-colors
 * before the DB value loads.
 */
export function firstPaintTheme(prefersDark: boolean): Theme {
    return prefersDark ? 'dark' : 'light';
}

const DEFAULT_MESSAGE_TYPE = 'ws-scrcpy-web:theme';

function isTheme(value: unknown): value is Theme {
    return value === 'dark' || value === 'light';
}

/**
 * Posts a `<messageType>-ready` handshake to the parent window so the host
 * page knows ws-scrcpy-web has loaded and what its current theme is.
 *
 * No-op when not embedded (i.e., when `target === window`, which is true at
 * the top of a frame tree).
 *
 * Uses `'*'` as `targetOrigin` because at handshake time the iframe does not
 * yet know the parent's origin — discovering it is the *purpose* of the
 * handshake. The payload is the iframe's own current theme, which is
 * non-sensitive. The reverse direction (parent → iframe with a new theme)
 * should use `event.origin` from the handshake for `targetOrigin`.
 */
export function notifyThemeReady(target?: Window, opts: ThemeEmbedOptions = {}): void {
    const dest = target ?? window.parent;
    if (!dest || dest === window) return;
    const baseType = opts.messageType ?? DEFAULT_MESSAGE_TYPE;
    const readyType = `${baseType}-ready`;
    dest.postMessage({ type: readyType, theme: getTheme() }, '*');
}

export function installThemeEmbedListener(opts: ThemeEmbedOptions = {}): () => void {
    const messageType = opts.messageType ?? DEFAULT_MESSAGE_TYPE;
    const allowedOrigins = opts.allowedOrigins ?? '*';
    const requestType = `${messageType}-request`;

    const handler = (event: MessageEvent): void => {
        if (allowedOrigins !== '*' && !allowedOrigins.includes(event.origin)) {
            return;
        }
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        const type = (data as { type?: unknown }).type;

        if (type === requestType) {
            const src = event.source as Window | null;
            if (src) {
                const readyType = `${messageType}-ready`;
                src.postMessage({ type: readyType, theme: getTheme() }, event.origin);
            }
            return;
        }

        if (type !== messageType) return;
        const theme = (data as { theme?: unknown }).theme;
        if (!isTheme(theme)) return;
        // Host-pushed theme is transient (not persisted to DB) — this is
        // intentional: the iframe embed layer does not own persistence.
        setTheme(theme);
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
}

/**
 * Posts a `<messageType>-changed` notification to the parent window so the
 * host page learns that ws-scrcpy-web's own UI just changed the theme.
 *
 * Use this when the iframe's theme changed via ws-scrcpy-web's own controls
 * (e.g., the in-app theme toggle button). The host can listen for this
 * message and update its own theme to stay in sync.
 *
 * No-op when not embedded (i.e., when `target === window`).
 *
 * Uses `'*'` as `targetOrigin` for the same reason as `notifyThemeReady`:
 * at the time this fires, the iframe doesn't have a guaranteed parent
 * origin to lock to. The payload is a non-sensitive theme value.
 */
export function notifyThemeChanged(target?: Window, opts: ThemeEmbedOptions = {}): void {
    const dest = target ?? window.parent;
    if (!dest || dest === window) return;
    const baseType = opts.messageType ?? DEFAULT_MESSAGE_TYPE;
    const changedType = `${baseType}-changed`;
    dest.postMessage({ type: changedType, theme: getTheme() }, '*');
}
