// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { removeSvgTitles } from './svgTitles';

describe('removeSvgTitles', () => {
    it('removes every <title>, including when there are several (no live-collection skip) (#92)', () => {
        const div = document.createElement('div');
        div.innerHTML = '<svg><title>a</title><title>b</title><title>c</title><rect></rect></svg>';
        const svg = div.children[0]!;
        removeSvgTitles(svg);
        expect(svg.getElementsByTagName('title').length).toBe(0);
    });

    it('leaves a title-free element untouched', () => {
        const div = document.createElement('div');
        div.innerHTML = '<svg><rect></rect></svg>';
        const svg = div.children[0]!;
        removeSvgTitles(svg);
        expect(svg.getElementsByTagName('rect').length).toBe(1);
    });
});
