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
