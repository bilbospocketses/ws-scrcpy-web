import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsService } from '../../../client/SettingsService';
import { bindDeviceSettings } from '../deviceSettingsBinding';

// M11 fix 1, m6: the device list binds each card's stream settings to the
// serial its descriptor carries (`DeviceTracker.buildDeviceRow` calls this).
const SERIAL = 'R5CN30ABCDE';
const WIFI = '10.0.0.5:5555';

function recordingFetch(): string[] {
    const urls: string[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
            urls.push(url);
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response);
        }),
    );
    return urls;
}

const asked = (key: string) => `/api/settings/device?udid=${encodeURIComponent(key)}`;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('bindDeviceSettings', () => {
    it("maps the card's udid to the descriptor's serial", async () => {
        const svc = new SettingsService();
        const urls = recordingFetch();

        bindDeviceSettings(svc, { udid: WIFI, 'ro.serialno': SERIAL });
        await svc.getDevice(WIFI);

        expect(urls).toEqual([asked(SERIAL)]);
    });

    it('an empty serial unbinds, so the transport is asked for', async () => {
        const svc = new SettingsService();
        const urls = recordingFetch();

        bindDeviceSettings(svc, { udid: WIFI, 'ro.serialno': SERIAL });
        bindDeviceSettings(svc, { udid: WIFI, 'ro.serialno': '' });
        await svc.getDevice(WIFI);

        expect(urls).toEqual([asked(WIFI)]);
    });

    it('a placeholder serial many devices share unbinds too (m4)', async () => {
        const svc = new SettingsService();
        const urls = recordingFetch();

        bindDeviceSettings(svc, { udid: WIFI, 'ro.serialno': SERIAL });
        bindDeviceSettings(svc, { udid: WIFI, 'ro.serialno': '0123456789ABCDEF' });
        await svc.getDevice(WIFI);

        expect(urls).toEqual([asked(WIFI)]);
    });
});
