// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CA_ROOT_DOWNLOAD_FILE_NAME } from '../../src/common/CaDownload';

// public/help/certificate-subject.html (0.5.3): the certificate-subject
// explainer and the per-device install guide the Local HTTPS tab links to.
// Static, so it is checked as a file: it exists, it themes before paint like
// subnets.html, every heading a link can land on has an id, every in-page link
// resolves, and nothing is loaded from anywhere else.

const PAGE = resolve(__dirname, '../../public/help/certificate-subject.html');
const SUBNETS = resolve(__dirname, '../../public/help/subnets.html');

function load(path: string): { html: string; doc: Document } {
    const html = readFileSync(path, 'utf8');
    return { html, doc: new DOMParser().parseFromString(html, 'text/html') };
}

describe('public/help/certificate-subject.html', () => {
    it('exists beside the subnet cheat sheet, which the build copies along with it', () => {
        expect(existsSync(PAGE)).toBe(true);
        expect(existsSync(SUBNETS)).toBe(true);
    });

    it("applies the app's stored theme before paint, exactly as subnets.html does", () => {
        const { html, doc } = load(PAGE);
        const bootstrap = doc.head.querySelector('script');
        expect(bootstrap, 'a script in <head>').not.toBeNull();
        expect(bootstrap!.textContent).toContain("localStorage.getItem('ws-scrcpy-web-theme')");
        expect(bootstrap!.textContent).toContain("setAttribute('data-theme'");
        // Before the stylesheet and the body, so the first paint is already themed.
        expect(html.indexOf("localStorage.getItem('ws-scrcpy-web-theme')")).toBeLessThan(html.indexOf('<style>'));
        expect(html.indexOf("localStorage.getItem('ws-scrcpy-web-theme')")).toBeLessThan(html.indexOf('<body>'));
        // The same bootstrap, byte for byte, as the page it is modeled on.
        const subnetsBootstrap = load(SUBNETS).doc.head.querySelector('script')!.textContent;
        expect(bootstrap!.textContent).toBe(subnetsBootstrap);
        // Both themes are defined, with the same tokens.
        const css = doc.head.querySelector('style')!.textContent ?? '';
        expect(css).toContain('[data-theme="dark"]');
        expect(css).toContain('[data-theme="light"]');
    });

    it('puts a stable id on every h2', () => {
        const { doc } = load(PAGE);
        const h2s = [...doc.querySelectorAll('h2')];
        expect(h2s.map((h) => h.id)).toEqual([
            '1-what-is-the-subject-name',
            '2-addresses-vs-names-the-real-world-analogy',
            '3-how-the-connection-works-step-by-step',
            '4-installing-a-certificate-establishing-trust',
            '5-key-takeaways',
        ]);
    });

    it('puts a stable id on each OS subsection of section 4, and on Firefox', () => {
        const { doc } = load(PAGE);
        const expected: Array<[string, string, string]> = [
            ['windows', 'H3', 'Windows'],
            ['macos', 'H3', 'macOS'],
            ['linux', 'H3', 'Linux'],
            ['ubuntu-debian', 'H4', 'Ubuntu / Debian'],
            ['fedora-rhel', 'H4', 'Fedora / RHEL'],
            ['android', 'H3', 'Android'],
            ['ios-ipados', 'H3', 'iOS / iPadOS'],
            ['firefox', 'H3', 'Firefox'],
        ];
        const section4 = doc.getElementById('4-installing-a-certificate-establishing-trust')!;
        const section5 = doc.getElementById('5-key-takeaways')!;
        for (const [id, tag, text] of expected) {
            const el = doc.getElementById(id);
            expect(el, id).not.toBeNull();
            expect(el!.tagName, id).toBe(tag);
            expect(el!.textContent, id).toContain(text);
            // Inside section 4: after its heading, before section 5's.
            expect(section4.compareDocumentPosition(el!) & Node.DOCUMENT_POSITION_FOLLOWING, id).toBeTruthy();
            expect(el!.compareDocumentPosition(section5) & Node.DOCUMENT_POSITION_FOLLOWING, id).toBeTruthy();
        }
        // Every h3/h4 has an id, not only the ones listed.
        for (const h of doc.querySelectorAll('h3, h4')) expect(h.id, h.textContent ?? '').not.toBe('');
    });

    it('has no duplicate ids, and every in-page link resolves to one', () => {
        const { doc } = load(PAGE);
        const ids = [...doc.querySelectorAll('[id]')].map((e) => e.id);
        expect(new Set(ids).size).toBe(ids.length);
        const hashLinks = [...doc.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')!.slice(1));
        // The explainer's own link into section 4 is among them.
        expect(hashLinks).toContain('4-installing-a-certificate-establishing-trust');
        for (const target of hashLinks) expect(ids, `#${target}`).toContain(target);
    });

    it('loads nothing from anywhere else: no external scripts, styles, images, fonts or links', () => {
        const { html, doc } = load(PAGE);
        for (const el of doc.querySelectorAll('[src], [href]')) {
            const ref = el.getAttribute('src') ?? el.getAttribute('href') ?? '';
            expect(ref, ref).not.toMatch(/^(https?:)?\/\//i);
        }
        expect(doc.querySelectorAll('link, img, iframe, object, embed')).toHaveLength(0);
        expect(html).not.toMatch(/@import|url\(/i);
        // Example addresses (https://bank.example.com) are prose inside <code>, never a link or resource.
        for (const a of doc.querySelectorAll('a')) expect(a.getAttribute('href') ?? '').not.toMatch(/:\/\//);
    });

    it('carries none of the source markdown leftovers: no LaTeX, no stray span, no escaped underscore', () => {
        const { html, doc } = load(PAGE);
        expect(html).not.toMatch(/\$\\|\\rightarrow|\\circ|\\text/);
        expect(doc.querySelectorAll('span')).toHaveLength(0);
        expect(html).not.toContain('Pop!\\_OS');
        expect(html).toContain('Pop!_OS');
        expect(doc.body.textContent).toContain('37.7749° N, 122.4194° W');
        // Code blocks carry no trailing blank line.
        for (const pre of doc.querySelectorAll('pre'))
            expect(pre.textContent, pre.textContent ?? '').toBe(pre.textContent!.trim());
    });

    it('names the file the app actually downloads in the Linux commands', () => {
        const { doc } = load(PAGE);
        const commands = [...doc.querySelectorAll('pre')].map((p) => p.textContent ?? '');
        expect(commands).toContain(`sudo cp ${CA_ROOT_DOWNLOAD_FILE_NAME} /usr/local/share/ca-certificates/`);
        expect(commands).toContain(`sudo cp ${CA_ROOT_DOWNLOAD_FILE_NAME} /etc/pki/ca-trust/source/anchors/`);
        expect(doc.body.textContent).not.toContain('your-ca.crt');
        // Windows step 1 names the .crt the app hands out.
        expect(doc.querySelector('#windows + ol > li')!.textContent).toContain('.crt');
    });
});
