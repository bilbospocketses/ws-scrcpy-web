import { describe, expect, it } from 'vitest';
import { mountsUpdateButton, offersSystemWideUpdate, showsWelcomeWizard } from '../containerGate';

// Each gate is pinned in both directions: false in a container even when every
// other input says "show it", and unchanged on a host (docker false or absent),
// so neither the container check nor the host behaviour can go missing alone.

describe('showsWelcomeWizard', () => {
    it('never in a container, even with first run incomplete', () => {
        expect(showsWelcomeWizard({ docker: true, firstRunComplete: false })).toBe(false);
    });

    it.each([false, undefined])('on a host (docker %s) it follows firstRunComplete', (docker) => {
        expect(showsWelcomeWizard({ docker, firstRunComplete: false })).toBe(true);
        expect(showsWelcomeWizard({ docker, firstRunComplete: true })).toBe(false);
    });
});

describe('offersSystemWideUpdate', () => {
    it('never in a container, even when an /opt update is reported', () => {
        expect(offersSystemWideUpdate({ docker: true, optUpdateAvailable: true })).toBe(false);
    });

    it.each([false, undefined])('on a host (docker %s) it follows optUpdateAvailable', (docker) => {
        expect(offersSystemWideUpdate({ docker, optUpdateAvailable: true })).toBe(true);
        expect(offersSystemWideUpdate({ docker, optUpdateAvailable: false })).toBe(false);
        expect(offersSystemWideUpdate({ docker })).toBe(false);
    });
});

describe('mountsUpdateButton', () => {
    it('not in a container', () => {
        expect(mountsUpdateButton({ docker: true })).toBe(false);
    });

    it('on a host, an old server without the flag, and a failed config read', () => {
        expect(mountsUpdateButton({ docker: false })).toBe(true);
        expect(mountsUpdateButton({})).toBe(true);
        expect(mountsUpdateButton(null)).toBe(true);
    });
});
