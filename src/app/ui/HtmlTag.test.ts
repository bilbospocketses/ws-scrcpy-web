// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { html } from './HtmlTag';

describe('html tag', () => {
    it('escapes a value interpolated into an attribute so it cannot break out', () => {
        const udid = 'x" onmouseover="alert(1)';
        const tpl = html`<button data-udid="${udid}">go</button>`;
        const btn = tpl.content.querySelector('button');
        expect(btn).not.toBeNull();
        // The attribute holds the literal value; no event-handler attribute injected.
        expect(btn?.getAttribute('data-udid')).toBe(udid);
        expect(btn?.hasAttribute('onmouseover')).toBe(false);
    });

    it('escapes a value interpolated into text content', () => {
        const name = '<img src=x onerror=alert(1)>';
        const tpl = html`<div>${name}</div>`;
        const div = tpl.content.querySelector('div');
        expect(div?.textContent).toBe(name);
        expect(div?.querySelector('img')).toBeNull();
    });
});
