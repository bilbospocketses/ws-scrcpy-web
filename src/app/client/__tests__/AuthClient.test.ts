import { afterEach, describe, expect, it, vi } from 'vitest';
import { authClient } from '../AuthClient';

function stub(handler: (url: string, init?: RequestInit) => unknown): void {
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))),
    );
}
const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;
function lastCall() {
    return fetchMock().mock.calls.at(-1) as [string, RequestInit | undefined];
}
function bodyOf(init?: RequestInit) {
    return init?.body ? JSON.parse(init.body as string) : undefined;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('AuthClient', () => {
    it('me() GETs /api/auth/me and returns the parsed body', async () => {
        stub(() => ({
            ok: true,
            json: () => Promise.resolve({ authEnabled: true, user: { username: 'bob', role: 'user' } }),
        }));
        const me = await authClient.me();
        expect(lastCall()[0]).toBe('/api/auth/me');
        expect(me).toEqual({ authEnabled: true, user: { username: 'bob', role: 'user' } });
    });
    it('login() POSTs credentials and returns res.ok', async () => {
        stub(() => ({ ok: true }));
        const ok = await authClient.login('admin', 'pw');
        const [url, init] = lastCall();
        expect(url).toBe('/api/auth/login');
        expect(init?.method).toBe('POST');
        expect(bodyOf(init)).toEqual({ username: 'admin', password: 'pw' });
        expect(ok).toBe(true);
    });
    it('login() returns false on a 401', async () => {
        stub(() => ({ ok: false, status: 401 }));
        expect(await authClient.login('admin', 'bad')).toBe(false);
    });
    it('changePassword() POSTs current+new and returns res.ok', async () => {
        stub(() => ({ ok: true }));
        const ok = await authClient.changePassword('old', 'new');
        const [url, init] = lastCall();
        expect(url).toBe('/api/auth/change-password');
        expect(bodyOf(init)).toEqual({ currentPassword: 'old', newPassword: 'new' });
        expect(ok).toBe(true);
    });
    it('listUsers() GETs /api/users and unwraps .users', async () => {
        stub(() => ({
            ok: true,
            json: () =>
                Promise.resolve({
                    users: [
                        {
                            id: 1,
                            username: 'admin',
                            role: 'admin',
                            hasPassword: true,
                            disabled: false,
                            lockedUntil: null,
                            lastLogin: null,
                        },
                    ],
                }),
        }));
        const users = await authClient.listUsers();
        expect(lastCall()[0]).toBe('/api/users');
        expect(users).toHaveLength(1);
        expect(users[0]!.username).toBe('admin');
    });
    it('createUser() POSTs to /api/users', async () => {
        stub(() => ({ ok: true, status: 201 }));
        await authClient.createUser({ username: 'carol', role: 'user', password: 'pw' });
        const [url, init] = lastCall();
        expect(url).toBe('/api/users');
        expect(init?.method).toBe('POST');
        expect(bodyOf(init)).toEqual({ username: 'carol', role: 'user', password: 'pw' });
    });
    it('lockdown() POSTs the admin creds + first user to /api/users', async () => {
        stub(() => ({ ok: true, status: 201 }));
        await authClient.lockdown({
            adminUsername: 'owner',
            adminPassword: 'ap',
            username: 'bob',
            role: 'user',
            password: 'bp',
        });
        expect(bodyOf(lastCall()[1])).toEqual({
            adminUsername: 'owner',
            adminPassword: 'ap',
            username: 'bob',
            role: 'user',
            password: 'bp',
        });
    });
    it('patchUser() PATCHes /api/users/:id', async () => {
        stub(() => ({ ok: true }));
        await authClient.patchUser(3, { disabled: true });
        const [url, init] = lastCall();
        expect(url).toBe('/api/users/3');
        expect(init?.method).toBe('PATCH');
        expect(bodyOf(init)).toEqual({ disabled: true });
    });
    it('deleteUser() DELETEs /api/users/:id', async () => {
        stub(() => ({ ok: true }));
        await authClient.deleteUser(3);
        const [url, init] = lastCall();
        expect(url).toBe('/api/users/3');
        expect(init?.method).toBe('DELETE');
    });
    it('enableAuth() POSTs /api/auth/enable (returns the Response so 409 is observable)', async () => {
        stub(() => ({ ok: false, status: 409 }));
        const res = await authClient.enableAuth();
        expect(lastCall()[0]).toBe('/api/auth/enable');
        expect(res.status).toBe(409);
    });
    it('disableAuth() POSTs /api/auth/disable', async () => {
        stub(() => ({ ok: true }));
        await authClient.disableAuth();
        expect(lastCall()[0]).toBe('/api/auth/disable');
    });
    it('logout() POSTs /api/auth/logout', async () => {
        stub(() => ({ ok: true }));
        await authClient.logout();
        expect(lastCall()[0]).toBe('/api/auth/logout');
    });
});
