import { afterEach, describe, expect, it, vi } from 'vitest';
import { SERVER_VERSION } from '../../common/Constants';
import { getDependencyDefinitions } from '../DependencyDefinitions';

/**
 * Settings offers scrcpy-server only up to the version this build speaks
 * (SERVER_VERSION). ScrcpyConnection launches whichever version is installed,
 * and the stream parser is written and tested against SERVER_VERSION, so an
 * untested newer release must not be one click away. scrcpy v5.0 shipped on
 * 2026-10-05 against a 4.1 build and was offered as an update.
 */
describe('scrcpy-server dependency definition: the offered version', () => {
    const def = () => getDependencyDefinitions('').find((d) => d.name === 'scrcpy-server')!;

    let fetchSpy: ReturnType<typeof vi.spyOn>;
    afterEach(() => fetchSpy?.mockRestore());

    const answer = (tag: string) => {
        fetchSpy = vi
            .spyOn(global, 'fetch')
            .mockImplementation(async () => new Response(JSON.stringify({ tag_name: tag }), { status: 200 }));
    };

    it('reports SERVER_VERSION when GitHub has a newer release', async () => {
        answer('v99.0');
        await expect(def().checkLatest()).resolves.toBe(SERVER_VERSION);
    });

    it('reports the release itself when it is not newer than SERVER_VERSION', async () => {
        answer(`v${SERVER_VERSION}`);
        await expect(def().checkLatest()).resolves.toBe(SERVER_VERSION);
        answer('v1.0');
        await expect(def().checkLatest()).resolves.toBe('1.0');
    });

    it('still answers null when the reply holds no tag', async () => {
        fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
        await expect(def().checkLatest()).resolves.toBeNull();
    });

    it('is authoritative, so a server installed above the supported version is offered it back', () => {
        // With the default ordered comparison an installed v5.0 would read as
        // "newer than latest, stay put" and keep running untested.
        expect(def().latestIsAuthoritative).toBe(true);
    });
});
