// @vitest-environment jsdom
// src/app/client/settings/__tests__/localHttpsPanel.test.ts
import { describe, expect, it, vi } from 'vitest';
import { buildLocalHttpsPanel } from '../tabs/ServerTab';

const state = (over = {}) => ({ status: 'none', ...over });

describe('local https panel', () => {
    it('offers the machine IP prefilled, so the common case is one click', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        const input = el.querySelector<HTMLInputElement>('[data-tls-subject]')!;
        expect(input.value).toBe('192.168.86.3');
    });

    it('warns that a sub-1024 port needs privileges on linux', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'linux',
        });
        const port = el.querySelector<HTMLInputElement>('[data-tls-port]')!;
        port.value = '443';
        port.dispatchEvent(new Event('input'));
        expect(el.textContent).toMatch(/elevated privileges/i);
    });

    it('promises no lockout when a narrowed mode is selected', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready' })))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        el.querySelector<HTMLInputElement>('[data-exposure="httpsOnly"]')!.click();
        expect(el.textContent).toMatch(/cannot lock yourself out/i);
        expect(el.textContent).toMatch(/server will restart/i);
    });

    it('tells the user streaming ALREADY works when the CA is untrusted', async () => {
        // The measured fact that makes this panel honest: a click-through cert
        // warning is still a secure context. Someone seeing a browser warning
        // assumes it is broken and stops; this is where that gets corrected.
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state({ status: 'ready' })))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
            caTrusted: false,
        });
        expect(el.textContent).toMatch(/streaming already works/i);
    });

    it('says a hostname must resolve on every client', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(JSON.stringify(state({ status: 'ready', kind: 'hostname', subject: 'devices.lan' }))),
            ),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(el.textContent).toMatch(/must resolve on every machine/i);
    });

    it('uses textContent for the subject — it is user input echoed back', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(
                async () =>
                    new Response(JSON.stringify(state({ status: 'ready', subject: '<img src=x onerror=alert(1)>' }))),
            ),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(el.querySelector('img')).toBeNull();
    });
});

describe('local https panel — transient alert convention', () => {
    // This repo's rule: transient outcomes get ONE bottom-of-panel alert
    // (5s success / 10s error), never a status line scattered next to
    // whichever control caused it. Each test below pins both that the alert
    // fires with the right text AND that it stops existing at the wrong
    // moment — a version with no timer (always visible) or an immediate hide
    // (never visible) each fail one of the two assertions.

    it('uses a single shared alert element, not one per control', async () => {
        const el = await buildLocalHttpsPanel({
            fetchFn: vi.fn(async () => new Response(JSON.stringify(state()))),
            candidateIps: ['192.168.86.3'],
            platform: 'win32',
        });
        expect(el.querySelectorAll('[data-tls-alert]')).toHaveLength(1);
    });

    it('shows a success alert after generate, and auto-hides at 5s but not a moment before', async () => {
        vi.useFakeTimers();
        try {
            const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
                if (url === '/api/tls/generate') {
                    return new Response(JSON.stringify({ status: 'ready', kind: 'ip', subject: '192.168.86.3' }));
                }
                return new Response(JSON.stringify(state()));
            });
            const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
            el.querySelector<HTMLButtonElement>('[data-tls-generate]')!.click();
            await vi.advanceTimersByTimeAsync(0);

            const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
            expect(alert.hidden).toBe(false);
            expect(alert.textContent).toMatch(/certificate generated/i);

            await vi.advanceTimersByTimeAsync(4_999);
            expect(alert.hidden).toBe(false);
            await vi.advanceTimersByTimeAsync(2);
            expect(alert.hidden).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('names the allowedHosts edit in the same alert, echoing the subject via textContent', async () => {
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            if (url === '/api/tls/generate') {
                return new Response(
                    JSON.stringify({
                        status: 'ready',
                        kind: 'hostname',
                        subject: 'devices.lan',
                        allowedHostAdded: true,
                    }),
                );
            }
            return new Response(JSON.stringify(state()));
        });
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
        el.querySelector<HTMLButtonElement>('[data-tls-generate]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
        expect(alert.textContent).toMatch(/added devices\.lan to allowedhosts/i);
        expect(alert.querySelector('img')).toBeNull();
    });

    it('shows the server-provided 429 body text on a rate-limited CA download, and holds it for 10s not 5s', async () => {
        vi.useFakeTimers();
        try {
            const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
                if (url === '/api/tls/ca-root') {
                    return new Response(
                        JSON.stringify({ error: 'too many CA downloads; wait a moment and try again' }),
                        { status: 429 },
                    );
                }
                return new Response(JSON.stringify(state({ status: 'ready', kind: 'ip', subject: '192.168.86.3' })));
            });
            const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
            el.querySelector<HTMLButtonElement>('[data-tls-download]')!.click();
            await vi.advanceTimersByTimeAsync(0);

            const alert = el.querySelector<HTMLElement>('[data-tls-alert]')!;
            expect(alert.textContent).toMatch(/too many ca downloads/i);

            // Errors get the LONGER window (10s), not the success window (5s) --
            // this is the assertion that would catch a copy-paste of the wrong
            // constant into the error branch.
            await vi.advanceTimersByTimeAsync(5_000);
            expect(alert.hidden).toBe(false);
            await vi.advanceTimersByTimeAsync(4_999);
            expect(alert.hidden).toBe(false);
            await vi.advanceTimersByTimeAsync(2);
            expect(alert.hidden).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('tells the user plain-http exposure saving is not supported yet, when the route 404s', async () => {
        const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
            if (url === '/api/tls/exposure') {
                return new Response(JSON.stringify({ error: 'no such tls route' }), { status: 404 });
            }
            return new Response(JSON.stringify(state({ status: 'ready' })));
        });
        const el = await buildLocalHttpsPanel({ fetchFn, candidateIps: ['192.168.86.3'], platform: 'win32' });
        el.querySelector<HTMLButtonElement>('[data-exposure-ok]')!.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(el.textContent).toMatch(/does not support saving this setting yet/i);
    });

    it('keeps a persistent condition (notification 4) visible well past the transient alert’s 10s window', async () => {
        vi.useFakeTimers();
        try {
            const el = await buildLocalHttpsPanel({
                fetchFn: vi.fn(
                    async () =>
                        new Response(JSON.stringify(state({ status: 'ready', kind: 'ip', subject: '10.0.0.9' }))),
                ),
                // Deliberately excludes 10.0.0.9, so the mismatch notice (4) fires.
                candidateIps: ['192.168.86.3'],
                platform: 'win32',
            });
            expect(el.textContent).toMatch(/no longer an address of this machine/i);
            await vi.advanceTimersByTimeAsync(15_000);
            expect(el.textContent).toMatch(/no longer an address of this machine/i);
        } finally {
            vi.useRealTimers();
        }
    });
});
