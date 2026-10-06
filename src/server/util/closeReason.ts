/** RFC 6455 caps a close reason at 123 bytes, and `ws` throws past that. */
export const MAX_CLOSE_REASON_BYTES = 123;

/**
 * Cut `text` to a valid close reason: at most 123 bytes of UTF-8, never splitting
 * a character. `String.slice(0, 123)` counts UTF-16 units, so a multi-byte
 * message could still exceed the limit.
 *
 * `ws` throws a RangeError for a longer reason BEFORE the socket leaves OPEN, so
 * the close never happens. Use this at every close site whose reason carries
 * variable text (an error message, an interpolated value).
 */
export function closeReason(text: string): string {
    const bytes = Buffer.from(text, 'utf-8');
    if (bytes.length <= MAX_CLOSE_REASON_BYTES) return text;
    let end = MAX_CLOSE_REASON_BYTES;
    // Back off any continuation bytes (10xxxxxx) so the cut lands on a character start.
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString('utf-8');
}
