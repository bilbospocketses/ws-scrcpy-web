// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CA_ROOT_DOWNLOAD_FILE_NAME } from '../CaDownload';

// public/help/certificate-subject.html (0.5.3): the certificate-subject
// explainer and the per-device install guide the Local HTTPS tab links to.
// Static, so it is checked as a file: it exists, it themes before paint like
// subnets.html, every heading a link can land on has an id, every in-page link
// resolves, and nothing is loaded from anywhere else.

const PAGE = resolve(__dirname, '../../../public/help/certificate-subject.html');
const SUBNETS = resolve(__dirname, '../../../public/help/subnets.html');

function load(path: string): { html: string; doc: Document } {
    const html = readFileSync(path, 'utf8');
    return { html, doc: new DOMParser().parseFromString(html, 'text/html') };
}

describe('public/help/certificate-subject.html', () => {
    it('exists beside the subnet cheat sheet, which the build copies along with it', () => {
        expect(existsSync(PAGE)).toBe(true);
        expect(existsSync(SUBNETS)).toBe(true);
    });

    it("applies the theme the app's link names before paint, exactly as subnets.html does", () => {
        const { html, doc } = load(PAGE);
        const bootstrap = doc.head.querySelector('script');
        expect(bootstrap, 'a script in <head>').not.toBeNull();
        // 0.5.5: from `?theme=` (src/app/client/helpLink.ts), else the OS. Not
        // from localStorage: nothing writes that key since the app moved its
        // theme to the server's settings, which is why every guide opened dark.
        expect(bootstrap!.textContent).toContain("new URLSearchParams(location.search).get('theme')");
        expect(bootstrap!.textContent).toContain("matchMedia('(prefers-color-scheme: light)')");
        expect(bootstrap!.textContent).not.toContain('localStorage');
        expect(bootstrap!.textContent).toContain("setAttribute('data-theme'");
        // Before the stylesheet and the body, so the first paint is already themed.
        expect(html.indexOf('location.search')).toBeLessThan(html.indexOf('<style>'));
        expect(html.indexOf('location.search')).toBeLessThan(html.indexOf('<body>'));
        // The same bootstrap, byte for byte, as the page it is modeled on.
        const subnetsBootstrap = load(SUBNETS).doc.head.querySelector('script')!.textContent;
        expect(bootstrap!.textContent).toBe(subnetsBootstrap);
        // Both themes are defined, with the same tokens.
        const css = doc.head.querySelector('style')!.textContent ?? '';
        expect(css).toContain('[data-theme="dark"]');
        expect(css).toContain('[data-theme="light"]');
    });

    // The head script, run against a stand-in page for each way it can be opened.
    describe.each([
        ['certificate-subject.html', PAGE],
        ['subnets.html', SUBNETS],
    ])('%s picks its theme', (_name, path) => {
        function themeFor(search: string, osLight: boolean): string | null {
            const script = load(path).doc.head.querySelector('script')!.textContent ?? '';
            const root = document.createElement('html');
            const fakeDocument = { documentElement: root };
            const fakeMatchMedia = (query: string) => ({
                matches: query === '(prefers-color-scheme: light)' && osLight,
            });
            new Function('document', 'location', 'matchMedia', 'localStorage', script)(
                fakeDocument,
                { search },
                fakeMatchMedia,
                // A stored theme that the page must ignore: nothing writes the key any more.
                { getItem: () => 'light' },
            );
            return root.getAttribute('data-theme');
        }

        it.each([
            ['?theme=light', false, 'light'],
            ['?theme=dark', true, 'dark'],
        ])('from the link (%s, OS light: %s): %s', (search, osLight, expected) => {
            expect(themeFor(search, osLight)).toBe(expected);
        });

        it.each([
            ['', true, 'light'],
            ['', false, 'dark'],
            ['?theme=purple', true, 'light'],
        ])('from the OS without a usable ?theme= (%j, OS light: %s): %s', (search, osLight, expected) => {
            expect(themeFor(search, osLight)).toBe(expected);
        });
    });

    it.each([
        ['certificate-subject.html', PAGE],
        ['subnets.html', SUBNETS],
    ])("%s links the app's favicon", (_name, path) => {
        const icon = load(path).doc.head.querySelector('link[rel="icon"]');
        expect(icon?.getAttribute('type')).toBe('image/png');
        // The page is served from /help/, the favicon from the root beside index.html.
        expect(icon?.getAttribute('href')).toBe('../favicon.png');
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
        // The one <link> is the app's own favicon, from this server (0.5.5).
        const links = [...doc.querySelectorAll('link')].map((l) => `${l.rel} ${l.getAttribute('href')}`);
        expect(links).toEqual(['icon ../favicon.png']);
        expect(doc.querySelectorAll('img, iframe, object, embed')).toHaveLength(0);
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

    // 0.5.3 review (M1): the handler used to cancel the link and call
    // window.close() only, so a tab the browser would not close (opened
    // directly, or after following an in-page link) went nowhere at all.
    describe('the "← Close tab" link', () => {
        function wire(closes: boolean) {
            const { doc } = load(PAGE);
            const script = [...doc.body.querySelectorAll('script')].map((s) => s.textContent ?? '').join('\n');
            expect(script).toContain('.back');
            const timers: Array<{ cb: () => void; ms: number }> = [];
            const fakeWindow = {
                closed: false,
                close: vi.fn(() => {
                    if (closes) fakeWindow.closed = true;
                }),
                setTimeout: (cb: () => void, ms: number) => timers.push({ cb, ms }),
                location: { href: 'http://localhost:8000/help/certificate-subject.html' },
            };
            // The page's own script, run against the parsed page with a stand-in window.
            new Function('window', 'document', script)(fakeWindow, doc);
            const back = doc.querySelector<HTMLAnchorElement>('a.back')!;
            return { back, fakeWindow, timers };
        }

        it('points at ../ and closes the tab when the browser allows it, without navigating', () => {
            const { back, fakeWindow, timers } = wire(true);
            expect(back.getAttribute('href')).toBe('../');
            const click = new MouseEvent('click', { bubbles: true, cancelable: true });
            back.dispatchEvent(click);
            expect(click.defaultPrevented).toBe(true);
            expect(fakeWindow.close).toHaveBeenCalledOnce();
            expect(timers).toHaveLength(1);
            timers[0]!.cb();
            expect(fakeWindow.location.href).toBe('http://localhost:8000/help/certificate-subject.html');
        });

        it('follows the link to ../ when the browser ignores window.close()', () => {
            const { back, fakeWindow, timers } = wire(false);
            back.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            expect(fakeWindow.close).toHaveBeenCalledOnce();
            // Not before the close has had its chance.
            expect(fakeWindow.location.href).toBe('http://localhost:8000/help/certificate-subject.html');
            expect(timers[0]!.ms).toBeGreaterThan(0);
            timers[0]!.cb();
            expect(fakeWindow.location.href).toBe('../');
        });
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
