/**
 * Escape a string for safe interpolation into HTML — both text content and
 * (because the quotes are escaped) attribute values. Use this anywhere
 * untrusted data (device names, file names, server-supplied strings) is built
 * into an HTML string before being assigned to innerHTML.
 */
export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
