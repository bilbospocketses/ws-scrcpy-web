import { describe, expect, it } from 'vitest';
import { escapeHtml } from './htmlEscape';

describe('escapeHtml', () => {
    it('escapes angle brackets and ampersands (text-context XSS)', () => {
        expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe(
            '&lt;img src=x onerror=alert(1)&gt;',
        );
        expect(escapeHtml('a&b')).toBe('a&amp;b');
    });

    it('escapes quotes so attribute interpolation cannot break out', () => {
        expect(escapeHtml('x" onmouseover="alert(1)')).toBe('x&quot; onmouseover=&quot;alert(1)');
        expect(escapeHtml("a'b")).toBe('a&#039;b');
    });

    it('leaves safe text unchanged', () => {
        expect(escapeHtml('OMX.qcom.video.encoder.avc')).toBe('OMX.qcom.video.encoder.avc');
    });
});
