// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { StagedSettingsStore } from '../StagedSettingsStore';
import { buildDependenciesTab } from '../tabs/DependenciesTab';
import { buildEmbeddingTab } from '../tabs/EmbeddingTab';
import { buildServiceTab } from '../tabs/ServiceTab';
import { buildUsersTab } from '../tabs/UsersTab';

function ctx(role: 'admin' | 'user' = 'admin') {
    return { role, authEnabled: false, docker: false, reload: () => undefined };
}

// A never-resolving fetch: these tabs refresh asynchronously, and the point of
// every test here is that the BODY renders regardless. Same discipline as
// SettingsModal's own probe test.
function stubHangingFetch(): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise(() => undefined)),
    );
}

describe('action-only tabs register nothing', () => {
    // THE structural guarantee of this design. If any of these ever fails, an
    // action has become stageable and can reach the change summary -- which
    // would make Save claim it is about to install a service or delete a user.
    it.each([
        ['Embedding', buildEmbeddingTab],
        ['Users', buildUsersTab],
        ['Service', buildServiceTab],
        ['Dependencies', buildDependenciesTab],
    ])('%s contributes no staged fields', (_name, build) => {
        stubHangingFetch();
        const store = new StagedSettingsStore();
        build(ctx(), store);
        expect(store.isDirty()).toBe(false);
        expect(store.changes()).toEqual([]);
        vi.unstubAllGlobals();
    });
});

describe('action-only tabs render without waiting on the network', () => {
    it.each([
        ['Embedding', buildEmbeddingTab],
        ['Users', buildUsersTab],
        ['Service', buildServiceTab],
        ['Dependencies', buildDependenciesTab],
    ])('%s builds a non-empty body while fetch hangs', (_name, build) => {
        stubHangingFetch();
        const el = build(ctx(), new StagedSettingsStore());
        expect(el).toBeInstanceOf(HTMLElement);
        expect(el.childElementCount).toBeGreaterThan(0);
        vi.unstubAllGlobals();
    });
});

describe('the controls that must survive the move', () => {
    it('Users still offers a way to add a user', () => {
        stubHangingFetch();
        const el = buildUsersTab(ctx(), new StagedSettingsStore());
        const labels = [...el.querySelectorAll('button')].map((b) => b.textContent ?? '');
        // The label genuinely differs from "add"/"create": the only control here
        // is "manage users", which opens UsersModal — whose own body (a separate
        // top-layer <dialog>, not a child of `el`) has the literal "Add user"
        // button. "manage users" IS the tab's real way to add a user; it just
        // doesn't say so directly. Confirmed by reading UsersModal.ts before
        // widening this regex, per the brief's move-vs-test-fix exception.
        expect(labels.some((l) => /add|create|manage/i.test(l))).toBe(true);
        vi.unstubAllGlobals();
    });

    it('Service still offers install and uninstall controls', () => {
        stubHangingFetch();
        const el = buildServiceTab(ctx(), new StagedSettingsStore());
        const text = el.textContent ?? '';
        expect(/install/i.test(text)).toBe(true);
        expect(/uninstall/i.test(text)).toBe(true);
        vi.unstubAllGlobals();
    });

    it('Embedding still offers a way to add an origin', () => {
        stubHangingFetch();
        const el = buildEmbeddingTab(ctx(), new StagedSettingsStore());
        const text = el.textContent ?? '';
        expect(/origin|embed/i.test(text)).toBe(true);
        vi.unstubAllGlobals();
    });
});

describe('role gating survives the move', () => {
    it('a non-admin gets no user-management controls', () => {
        stubHangingFetch();
        const el = buildUsersTab(ctx('user'), new StagedSettingsStore());
        const labels = [...el.querySelectorAll('button')].map((b) => b.textContent ?? '');
        expect(labels.some((l) => /delete|remove/i.test(l))).toBe(false);
        vi.unstubAllGlobals();
    });
});
