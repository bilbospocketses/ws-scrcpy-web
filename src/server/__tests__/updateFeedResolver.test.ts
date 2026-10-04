import { describe, expect, it, vi } from 'vitest';
import { GithubReleaseFeedResolver, RELEASES_PER_PAGE, releaseFeedUrl } from '../updateFeedResolver';
import { HttpStatusError } from '../util/fetchWithRetry';
import { betas, fakeGithubApi, release } from './helpers/fakeGithubReleases';

// The update check used to hand Velopack the bare repo URL, which its
// GithubSource turns into ONE request for the 10 newest releases
// (velopack 1.2.161 sources/github.rs:77-89) -- so a channel whose newest
// release sat further back than that was invisible. The resolver pages the
// releases list itself until it finds the newest release that carries the
// selected channel's feed file.

const noSleep = async (): Promise<void> => undefined;

describe('GithubReleaseFeedResolver', () => {
    it('asks for 100 releases a page', () => {
        expect(RELEASES_PER_PAGE).toBe(100);
    });

    it('finds a stable release with 15 newer betas published after it', async () => {
        const api = fakeGithubApi([...betas(15, 30), release('v0.1.30', ['stable', 'linux-stable']), ...betas(5, 15)]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        const got = await r.resolve('bilbospocketses', 'stable');
        expect(got).toEqual({
            tag: 'v0.1.30',
            url: 'https://github.com/bilbospocketses/ws-scrcpy-web/releases/download/v0.1.30/',
        });
        expect(api.calls[0]!.url).toBe(
            'https://api.github.com/repos/bilbospocketses/ws-scrcpy-web/releases?per_page=100&page=1',
        );
    });

    it('beta resolves to the newest beta', async () => {
        const api = fakeGithubApi([...betas(15, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        expect((await r.resolve('bilbospocketses', 'beta'))?.tag).toBe('v0.1.30-beta.30');
    });

    it('matches the platform channel exactly: linux-stable is not stable', async () => {
        const api = fakeGithubApi([
            release('v0.1.31', ['stable']), // a Windows-only stable
            release('v0.1.30', ['stable', 'linux-stable']),
        ]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        expect((await r.resolve('bilbospocketses', 'linux-stable'))?.tag).toBe('v0.1.30');
        expect((await r.resolve('bilbospocketses', 'stable'))?.tag).toBe('v0.1.31');
    });

    it('pages past a full page of the other channel', async () => {
        const api = fakeGithubApi([...betas(RELEASES_PER_PAGE, 200), release('v0.1.30', ['stable', 'linux-stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        expect((await r.resolve('bilbospocketses', 'stable'))?.tag).toBe('v0.1.30');
        expect(api.calls.map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2']);
    });

    it('no release carries the channel: null, and it stops at the last page', async () => {
        const api = fakeGithubApi(betas(14, 166));
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        expect(await r.resolve('bilbospocketses', 'stable')).toBeNull();
        // 14 < 100, so page 1 was the last one: no request for page 2.
        expect(api.calls).toHaveLength(1);
    });

    it('skips drafts', async () => {
        const draft = { ...release('v0.1.31', ['stable']), draft: true };
        const api = fakeGithubApi([draft, release('v0.1.30', ['stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        expect((await r.resolve('bilbospocketses', 'stable'))?.tag).toBe('v0.1.30');
    });

    it('a refused lookup (403) throws HttpStatusError, it does not answer "no release"', async () => {
        const api = fakeGithubApi(betas(3, 10));
        api.refuse(403);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        const err = await r.resolve('bilbospocketses', 'beta').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(HttpStatusError);
        expect((err as HttpStatusError).status).toBe(403);
    });

    it.each([429, 503])('a %i is retried, then reported as HttpStatusError', async (status) => {
        const api = fakeGithubApi(betas(3, 10));
        api.refuse(status);
        const sleep = vi.fn(noSleep);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep });
        const err = await r.resolve('bilbospocketses', 'beta').catch((e: unknown) => e);
        expect((err as HttpStatusError).status).toBe(status);
        expect(api.calls.length).toBeGreaterThan(1);
        expect(sleep).toHaveBeenCalled();
    });

    it('caches the answer: an unchanged listing costs one conditional request (304)', async () => {
        const api = fakeGithubApi([...betas(3, 10), release('v0.1.30', ['stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        const first = await r.resolve('bilbospocketses', 'stable');
        const second = await r.resolve('bilbospocketses', 'stable');
        expect(second).toEqual(first);
        expect(api.calls).toHaveLength(2);
        expect(api.calls[0]!.ifNoneMatch).toBeNull();
        expect(api.calls[1]!.ifNoneMatch).toBe('"v1-p1"');
    });

    it('caches "none" too, and notices when the channel gets its first release', async () => {
        const api = fakeGithubApi(betas(3, 10));
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        expect(await r.resolve('bilbospocketses', 'stable')).toBeNull();
        expect(await r.resolve('bilbospocketses', 'stable')).toBeNull();
        api.set([release('v0.1.30', ['stable']), ...betas(3, 10)]);
        expect((await r.resolve('bilbospocketses', 'stable'))?.tag).toBe('v0.1.30');
    });

    it('refreshes the cached tag when a newer release of the channel appears', async () => {
        const older = [...betas(3, 10), release('v0.1.30', ['stable'])];
        const api = fakeGithubApi(older);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        expect((await r.resolve('bilbospocketses', 'stable'))?.tag).toBe('v0.1.30');
        api.set([release('v0.1.31', ['stable']), ...older]);
        expect((await r.resolve('bilbospocketses', 'stable'))?.tag).toBe('v0.1.31');
    });

    it('a different channel or owner is a different cache entry', async () => {
        const api = fakeGithubApi([...betas(3, 10), release('v0.1.30', ['stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        await r.resolve('bilbospocketses', 'stable');
        expect((await r.resolve('bilbospocketses', 'beta'))?.tag).toBe('v0.1.30-beta.10');
        expect(api.calls[1]!.ifNoneMatch).toBeNull();
        await r.resolve('forky', 'beta');
        expect(api.calls[2]!.ifNoneMatch).toBeNull();
        expect(api.calls[2]!.url).toContain('/repos/forky/ws-scrcpy-web/releases');
    });

    it('forget() drops the cache, so the next lookup walks the listing again', async () => {
        const api = fakeGithubApi([release('v0.1.30', ['stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        await r.resolve('bilbospocketses', 'stable');
        r.forget();
        await r.resolve('bilbospocketses', 'stable');
        expect(api.calls[1]!.ifNoneMatch).toBeNull();
    });

    it('releaseFeedUrl is the release download folder, with a trailing slash', () => {
        expect(releaseFeedUrl('bilbospocketses', 'v0.1.30-beta.166')).toBe(
            'https://github.com/bilbospocketses/ws-scrcpy-web/releases/download/v0.1.30-beta.166/',
        );
    });
});
