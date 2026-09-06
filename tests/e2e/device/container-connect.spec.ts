import { expect, test } from '@playwright/test';
import { gotoHome } from '../support/consent';
import { connectDevice, deviceAddress, disconnectIfConnected, waitForDeviceRow } from '../support/device';

/**
 * Smoke row 20.10 — wireless connect from a container. The device tier already
 * runs against the container subject (qa-harness puts the image and the
 * emulator on one network), so the row's claim is two things the connect rows
 * do not state: that the subject under test IS the container, and that a
 * wireless connect and the device list work through the container's own adb.
 *
 * Authored here, run only under qa-harness like every `@device` spec
 * (tests/e2e/README.md). Written 2026-09-06 without a run: the emulator is not
 * reachable from the dev box. If it fails there, the first suspect is this
 * file, not the product.
 */
test.describe('wireless connect from a container (smoke §20.10)', () => {
    test('@device 20.10 the subject is the container, and a wireless connect lists the device through its adb', async ({
        page,
    }) => {
        test.setTimeout(120_000);
        const address = deviceAddress();
        const ctx = page.request;

        await gotoHome(page);
        // The container-specific half of the claim, first: `/api/config`'s
        // runtime envelope carries `docker: true` only when WS_SCRCPY_DOCKER=1
        // reached the server — the same probe the Settings modal gates on.
        const cfg = (await (await ctx.get('/api/config')).json()) as { runtime: { docker?: boolean } };
        expect(cfg.runtime.docker, 'the device tier must be pointed at the container subject').toBe(true);

        try {
            await connectDevice(ctx, address);
            await waitForDeviceRow(page, address, 30_000);
        } finally {
            await disconnectIfConnected(ctx, address);
        }
    });
});
