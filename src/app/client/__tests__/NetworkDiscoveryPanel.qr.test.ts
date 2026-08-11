// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkDiscoveryPanel } from '../NetworkDiscoveryPanel';

const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('NetworkDiscoveryPanel QR pairing', () => {
    it('generates and completes a Tailscale QR session', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(
                response({
                    id: 'qr-1',
                    mode: 'tailscale',
                    state: 'waiting',
                    message: 'Waiting',
                    expiresAt: Date.now() + 60_000,
                    qrSvg: '<svg data-qr="1"></svg>',
                }),
            )
            .mockResolvedValueOnce(
                response({
                    id: 'qr-1',
                    mode: 'tailscale',
                    state: 'complete',
                    message: 'Connected',
                    expiresAt: Date.now() + 59_000,
                    address: '100.64.1.20:33001',
                }),
            );
        const root = new NetworkDiscoveryPanel().getElement();
        document.body.appendChild(root);
        (root.querySelector('.discovery-qr-btn') as HTMLButtonElement).click();
        const mode = root.querySelector('.discovery-qr-mode') as HTMLSelectElement;
        mode.value = 'tailscale';
        mode.dispatchEvent(new Event('change'));
        (root.querySelector('.discovery-qr-host') as HTMLInputElement).value = '100.64.1.20';
        (root.querySelector('.discovery-qr-generate') as HTMLButtonElement).click();
        await flush();

        expect(fetch).toHaveBeenNthCalledWith(
            1,
            '/api/devices/pair/qr',
            expect.objectContaining({
                body: JSON.stringify({ mode: 'tailscale', host: '100.64.1.20' }),
            }),
        );
        expect(root.querySelector('.discovery-qr-code svg')).not.toBeNull();

        await vi.advanceTimersByTimeAsync(1_000);
        await flush();
        expect((root.querySelector('.discovery-info') as HTMLElement).textContent).toContain('100.64.1.20:33001');
    });
});
