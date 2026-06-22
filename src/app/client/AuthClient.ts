async function ok(res: Response): Promise<Response> {
    if (!res.ok) throw new Error(`auth request failed: HTTP ${res.status}`);
    return res;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export type Role = 'user' | 'admin';
export interface MeResponse {
    authEnabled: boolean;
    user: { username: string; role: Role } | null;
}
export interface UserRow {
    id: number;
    username: string;
    role: Role;
    hasPassword: boolean;
    disabled: boolean;
    lockedUntil: number | null;
    lastLogin: number | null;
}

class AuthClient {
    async me(): Promise<MeResponse> {
        const res = await ok(await fetch('/api/auth/me'));
        return (await res.json()) as MeResponse;
    }
    async login(username: string, password: string): Promise<boolean> {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ username, password }),
        });
        return res.ok;
    }
    async logout(): Promise<void> {
        await fetch('/api/auth/logout', { method: 'POST' });
    }
    async changePassword(currentPassword: string, newPassword: string): Promise<boolean> {
        const res = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ currentPassword, newPassword }),
        });
        return res.ok;
    }
    async enableAuth(): Promise<Response> {
        return fetch('/api/auth/enable', { method: 'POST' });
    }
    async disableAuth(): Promise<void> {
        await ok(await fetch('/api/auth/disable', { method: 'POST' }));
    }
    async listUsers(): Promise<UserRow[]> {
        const res = await ok(await fetch('/api/users'));
        return ((await res.json()) as { users: UserRow[] }).users;
    }
    async createUser(input: { username: string; role: Role; password: string }): Promise<Response> {
        return fetch('/api/users', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(input) });
    }
    async lockdown(input: {
        adminUsername: string;
        adminPassword: string;
        username: string;
        role: Role;
        password: string;
    }): Promise<Response> {
        return fetch('/api/users', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(input) });
    }
    async patchUser(
        id: number,
        patch: { role?: Role; password?: string; disabled?: boolean; unlock?: boolean },
    ): Promise<Response> {
        return fetch(`/api/users/${id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch) });
    }
    async deleteUser(id: number): Promise<Response> {
        return fetch(`/api/users/${id}`, { method: 'DELETE' });
    }
}

export const authClient = new AuthClient();
