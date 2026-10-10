// @vitest-environment jsdom

/**
 * A refused admin read is not a network failure (0.5.6). Until then Updates and
 * Service showed any failed status read as "couldn't reach server" with a
 * retry, a 403 included, and Local HTTPS built its panel as if there were no
 * certificate when its own state read failed. A refusal now says why, with no
 * retry (a retry can only be refused again), and an operator refusal tells the
 * dialog; a network failure or a server error keeps its retry.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_REFUSAL_ERROR } from '../../../../common/remoteAdmin';
import { ADMIN_ONLY_NOTE, ADMIN_UNREACHABLE_NOTE, adminRefusal } from '../../adminGate';
import { StagedSettingsStore } from '../StagedSettingsStore';
import { askUnbound, type TabContext } from '../tabs/EmbeddingTab';
import {
    applyLocalHttpsServiceStatus,
    applyLocalHttpsServiceStatusRefused,
    buildLocalHttpsPanel,
    buildLocalHttpsTab,
    TlsStateReadError,
} from '../tabs/LocalHttpsTab';
import { buildServiceTab, refreshService, type ServiceTabCallbacks } from '../tabs/ServiceTab';
import { buildUpdatesTab, refreshUpdates } from '../tabs/UpdatesTab';
import { applyUsersAdminUnreachable, applyUsersConfig, buildUsersTab } from '../tabs/UsersTab';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const respond = (status: number, body: unknown): Response =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: () => (body === undefined ? Promise.reject(new SyntaxError('no body')) : Promise.resolve(body)),
    }) as unknown as Response;

const OPERATOR_403 = (): Response => respond(403, { error: OPERATOR_REFUSAL_ERROR });
const ROLE_403 = (): Response => respond(403, { error: 'forbidden' });
const SERVER_500 = (): Response => respond(500, { error: 'boom' });

function context(onAdminRefused = vi.fn()): TabContext & { onAdminRefused: ReturnType<typeof vi.fn> } {
    return {
        role: 'admin',
        authEnabled: false,
        reload: () => undefined,
        askChild: askUnbound,
        openChild: <T>(open: () => T) => open(),
        onAdminRefused,
    };
}

/** Every `GET url` answers `answer()`; anything else hangs. */
function stubRead(url: string, answer: () => Response | Promise<Response>): ReturnType<typeof vi.fn> {
    const f = vi.fn((u: string) => (u === url ? Promise.resolve(answer()) : new Promise(() => undefined)));
    vi.stubGlobal('fetch', f);
    return f;
}

const buttonsIn = (el: HTMLElement): string[] =>
    [...el.querySelectorAll<HTMLButtonElement>('.settings-card button')].map((b) => b.textContent ?? '');

describe('adminRefusal', () => {
    it('reads an operator refusal from the 403 body', async () => {
        expect(await adminRefusal(OPERATOR_403())).toBe('operator');
    });

    it('reads any other 403 as a role refusal, a body it cannot parse included', async () => {
        expect(await adminRefusal(ROLE_403())).toBe('role');
        expect(await adminRefusal(respond(403, undefined))).toBe('role');
    });

    it('is null for anything but a 403', async () => {
        expect(await adminRefusal(SERVER_500())).toBeNull();
        expect(await adminRefusal(respond(401, { error: OPERATOR_REFUSAL_ERROR }))).toBeNull();
        expect(await adminRefusal(respond(200, {}))).toBeNull();
    });
});

describe('Updates: the status read', () => {
    async function mount(answer: () => Response | Promise<Response>) {
        stubRead('/api/updates/status', answer);
        const ctx = context();
        const el = buildUpdatesTab(ctx, new StagedSettingsStore());
        await refreshUpdates(el);
        return { el, ctx };
    }

    it('an operator refusal says why, offers no retry, and tells the dialog', async () => {
        const { el, ctx } = await mount(OPERATOR_403);
        const note = el.querySelector<HTMLElement>('.settings-card [data-admin-unreachable-note]')!;
        expect(note.hidden).toBe(false);
        expect(note.textContent).toBe(ADMIN_UNREACHABLE_NOTE);
        expect(buttonsIn(el)).toEqual([]);
        expect(el.textContent).not.toContain("couldn't reach server");
        expect(ctx.onAdminRefused).toHaveBeenCalledTimes(1);
    });

    it('a role refusal says only an admin can change these, with no retry, and does not tell the dialog', async () => {
        const { el, ctx } = await mount(ROLE_403);
        expect(el.querySelector('[data-admin-only-note]')?.textContent).toBe(ADMIN_ONLY_NOTE);
        expect(el.querySelector('[data-admin-unreachable-note]')).toBeNull();
        expect(buttonsIn(el)).toEqual([]);
        expect(ctx.onAdminRefused).not.toHaveBeenCalled();
    });

    it.each([
        ['a server error', SERVER_500],
        ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
    ])('%s keeps "couldn\'t reach server" and its retry', async (_label, answer) => {
        const { el, ctx } = await mount(answer as () => Response);
        expect(el.querySelector('.settings-card')!.textContent).toContain("couldn't reach server");
        expect(buttonsIn(el)).toEqual(['retry']);
        expect(ctx.onAdminRefused).not.toHaveBeenCalled();
    });
});

describe('Service: the status read', () => {
    async function mount(answer: () => Response | Promise<Response>) {
        stubRead('/api/service/status', answer);
        const ctx = context();
        const el = buildServiceTab(ctx, new StagedSettingsStore());
        const callbacks = {
            onServiceStatus: vi.fn(),
            onServiceStatusFailed: vi.fn(),
            onServiceStatusRefused: vi.fn(),
        } satisfies ServiceTabCallbacks;
        await refreshService(el, callbacks);
        return { el, ctx, callbacks };
    }

    it('an operator refusal says why, offers no retry, and tells Local HTTPS and the dialog', async () => {
        const { el, ctx, callbacks } = await mount(OPERATOR_403);
        expect(el.querySelector('.settings-card [data-admin-unreachable-note]')?.textContent).toBe(
            ADMIN_UNREACHABLE_NOTE,
        );
        expect(buttonsIn(el)).toEqual([]);
        expect(callbacks.onServiceStatusRefused).toHaveBeenCalledWith('operator');
        expect(callbacks.onServiceStatusFailed).not.toHaveBeenCalled();
        expect(ctx.onAdminRefused).toHaveBeenCalledTimes(1);
    });

    it('a role refusal says only an admin can change these, and tells Local HTTPS but not the dialog', async () => {
        const { el, ctx, callbacks } = await mount(ROLE_403);
        expect(el.querySelector('[data-admin-only-note]')?.textContent).toBe(ADMIN_ONLY_NOTE);
        expect(buttonsIn(el)).toEqual([]);
        expect(callbacks.onServiceStatusRefused).toHaveBeenCalledWith('role');
        expect(ctx.onAdminRefused).not.toHaveBeenCalled();
    });

    it('a server error keeps "couldn\'t reach server" and its retry', async () => {
        const { el, ctx, callbacks } = await mount(SERVER_500);
        expect(el.querySelector('.settings-card')!.textContent).toContain("couldn't reach server");
        expect(buttonsIn(el)).toEqual(['retry']);
        expect(callbacks.onServiceStatusFailed).toHaveBeenCalledTimes(1);
        expect(callbacks.onServiceStatusRefused).not.toHaveBeenCalled();
        expect(ctx.onAdminRefused).not.toHaveBeenCalled();
    });
});

describe('Local HTTPS: its own certificate-state read', () => {
    const serviceStatus = { supported: true, platform: 'win32' } as unknown as Parameters<
        typeof applyLocalHttpsServiceStatus
    >[1];

    /** The tab, handed a service status so it builds its panel; /api/tls/state answers `answer()`. */
    async function mount(answer: () => Response | Promise<Response>) {
        let state = answer;
        const f = vi.fn((u: string) => {
            if (u === '/api/tls/state') return Promise.resolve(state());
            if (u === '/api/dependencies') return Promise.resolve(respond(200, []));
            return new Promise(() => undefined);
        });
        vi.stubGlobal('fetch', f);
        const ctx = context();
        const el = buildLocalHttpsTab(ctx);
        document.body.appendChild(el);
        applyLocalHttpsServiceStatus(el, serviceStatus);
        await flush();
        return { el, ctx, f, answerNext: (next: () => Response) => (state = next) };
    }

    it('the panel build rejects with a TlsStateReadError instead of showing "no certificate"', async () => {
        for (const [answer, refusal] of [
            [SERVER_500, null],
            [ROLE_403, 'role'],
            [OPERATOR_403, 'operator'],
        ] as const) {
            const fetchFn = vi.fn(async (u: RequestInfo | URL) =>
                u === '/api/tls/state' ? answer() : respond(200, []),
            ) as unknown as typeof fetch;
            const err = await buildLocalHttpsPanel({ fetchFn, candidateIps: [] }).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(TlsStateReadError);
            expect((err as TlsStateReadError).refusal).toBe(refusal);
        }
    });

    it('a failed read shows "couldn\'t reach server" with a retry, and the retry builds the panel', async () => {
        const { el, answerNext } = await mount(SERVER_500);
        expect(el.textContent).toContain("couldn't reach server");
        expect(el.querySelector('[data-tls-generate]')).toBeNull();
        const retry = el.querySelector<HTMLButtonElement>('[data-local-https-retry]')!;
        expect(retry).not.toBeNull();

        answerNext(() => respond(200, { status: 'none' }));
        retry.click();
        await flush();
        expect(el.querySelector('[data-tls-generate]')).not.toBeNull();
        expect(el.textContent).not.toContain("couldn't reach server");
    });

    it('a role refusal says only an admin can change these, with no retry', async () => {
        const { el, ctx } = await mount(ROLE_403);
        expect(el.querySelector('[data-admin-only-note]')?.textContent).toBe(ADMIN_ONLY_NOTE);
        expect(el.querySelector('[data-local-https-retry]')).toBeNull();
        expect(el.querySelector('[data-tls-generate]')).toBeNull();
        expect(ctx.onAdminRefused).not.toHaveBeenCalled();
    });

    it('an operator refusal says why, with no retry, and tells the dialog', async () => {
        const { el, ctx } = await mount(OPERATOR_403);
        expect(el.querySelector('[data-admin-unreachable-note]')?.textContent).toBe(ADMIN_UNREACHABLE_NOTE);
        expect(el.querySelector('[data-local-https-retry]')).toBeNull();
        expect(ctx.onAdminRefused).toHaveBeenCalledTimes(1);
    });

    it('a refused service-status read says why, with no retry, and a later status builds nothing over it', async () => {
        const f = vi.fn(() => Promise.resolve(respond(200, { status: 'none' })));
        vi.stubGlobal('fetch', f);
        const el = buildLocalHttpsTab(context());
        applyLocalHttpsServiceStatusRefused(el, 'role');
        expect(el.querySelector('[data-admin-only-note]')?.textContent).toBe(ADMIN_ONLY_NOTE);
        expect(el.querySelector('[data-local-https-retry]')).toBeNull();

        applyLocalHttpsServiceStatus(el, serviceStatus);
        await flush();
        expect(el.querySelector('[data-tls-generate]')).toBeNull();
        expect(f).not.toHaveBeenCalled();
    });
});

describe('Users: held back after the fact', () => {
    it('disables every control and shows the note, and a later envelope does not re-enable the box', () => {
        const el = buildUsersTab(context(), new StagedSettingsStore());
        applyUsersAdminUnreachable(el);
        applyUsersConfig(el, {
            config: { allowRemoteAdmin: false },
            runtime: { adminScope: 'local', callerIsLocal: true },
        } as unknown as Parameters<typeof applyUsersConfig>[1]);

        for (const b of el.querySelectorAll<HTMLButtonElement>('.settings-card button')) {
            expect(b.disabled, b.textContent ?? '').toBe(true);
        }
        expect(el.querySelector<HTMLInputElement>('input[data-remote-admin]')!.disabled).toBe(true);
        expect(el.querySelector<HTMLElement>('[data-admin-unreachable-note]')!.hidden).toBe(false);
    });
});
