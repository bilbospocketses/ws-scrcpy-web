/**
 * Build a DOM id fragment from a human label: lowercase, with every run of
 * whitespace collapsed to a single underscore. The previous `replace(' ', '_')`
 * (no `/g`) only replaced the first space, so a multi-word label like
 * "Switch To TV" produced a malformed id with embedded spaces. (#89)
 */
export function toInputId(title: string): string {
    return title.toLowerCase().replace(/\s+/g, '_');
}
