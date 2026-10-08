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
            channel: 'stable',
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

    it('caches the answer: an unchanged listing costs one conditional request per page (304)', async () => {
        const api = fakeGithubApi([...betas(3, 10), release('v0.1.30', ['stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        const first = await r.resolve('bilbospocketses', 'stable');
        const second = await r.resolve('bilbospocketses', 'stable');
        expect(second).toEqual(first);
        expect(api.calls).toHaveLength(2);
        expect(api.calls[0]!.ifNoneMatch).toBeNull();
        expect(api.calls[1]!.ifNoneMatch).toMatch(/^"p1-/);
    });

    it('a two-page listing that has not changed is revalidated page by page, all 304', async () => {
        const api = fakeGithubApi([...betas(RELEASES_PER_PAGE, 200), release('v0.1.30', ['stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        expect((await r.resolve('bilbospocketses', 'stable'))?.tag).toBe('v0.1.30');
        expect((await r.resolve('bilbospocketses', 'stable'))?.tag).toBe('v0.1.30');
        expect(api.calls).toHaveLength(4);
        expect(api.calls[2]!.ifNoneMatch).toMatch(/^"p1-/);
        expect(api.calls[3]!.ifNoneMatch).toMatch(/^"p2-/);
    });

    // ── Which release wins: the highest version, wherever it is listed ──
    //
    // GitHub's list is not ordered by publication or by version (measured
    // 2026-10-04: beta.92 listed above beta.102), so neither "first match" nor
    // "newest published_at" is the newest version.

    it('picks the highest version, not the one listed first or published last', async () => {
        const api = fakeGithubApi([
            release('v0.1.30-beta.92', ['beta']),
            release('v0.1.30-beta.102', ['beta']),
            release('v0.1.30-beta.101', ['beta']),
        ]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        expect((await r.resolve('bilbospocketses', 'beta'))?.tag).toBe('v0.1.30-beta.102');
    });

    it('a match on page 2 with a higher version than page 1 wins', async () => {
        const api = fakeGithubApi([
            release('v0.1.30-beta.10', ['beta']),
            ...Array.from({ length: RELEASES_PER_PAGE - 1 }, (_, i) => release(`v0.0.${i}`, ['stable'])),
            release('v0.1.30-beta.200', ['beta']),
        ]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        expect((await r.resolve('bilbospocketses', 'beta'))?.tag).toBe('v0.1.30-beta.200');
        expect(api.calls.map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2']);
    });

    it('an edit on page 2 is noticed though page 1 did not change', async () => {
        const page1 = betas(RELEASES_PER_PAGE, 200);
        const api = fakeGithubApi([...page1, release('v0.1.30', ['stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        expect((await r.resolve('bilbospocketses', 'stable'))?.tag).toBe('v0.1.30');
        // The rollback lever, pulled on a release that sits on page 2.
        api.set([...page1, { ...release('v0.1.30', ['stable']), prerelease: true }]);
        expect(await r.resolve('bilbospocketses', 'stable')).toBeNull();
    });

    // ── The rollback lever: a prerelease is never offered ──
    //
    // docs/RELEASING.md's rollback step 1 is `gh release edit vX.Y.Z
    // --prerelease`. release.yml never sets the flag, so it marks exactly the
    // releases someone has pulled.

    it('skips prereleases, so marking a bad release prerelease retracts it', async () => {
        const api = fakeGithubApi([release('v0.1.31', ['stable']), release('v0.1.30', ['stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        expect((await r.resolve('bilbospocketses', 'stable'))?.tag).toBe('v0.1.31');
        api.set([{ ...release('v0.1.31', ['stable']), prerelease: true }, release('v0.1.30', ['stable'])]);
        expect((await r.resolve('bilbospocketses', 'stable'))?.tag).toBe('v0.1.30');
    });

    // ── A refusal with an answer already in hand ──

    it.each([403, 429])(
        'a %i with a cached answer for the same owner and channel serves that answer',
        async (status) => {
            const api = fakeGithubApi([...betas(3, 10), release('v0.1.30', ['stable'])]);
            const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
            expect((await r.resolve('bilbospocketses', 'stable'))?.tag).toBe('v0.1.30');
            api.refuse(status);
            expect((await r.resolve('bilbospocketses', 'stable'))?.tag).toBe('v0.1.30');
        },
    );

    it('a refusal answers any channel from the owner listing already read', async () => {
        // The cache is the listing, not one channel's answer: every feed each
        // release carries was recorded, so a channel never asked for before is
        // answered from it as well as the one that was.
        const api = fakeGithubApi([...betas(3, 10), release('v0.1.30', ['stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        await r.resolve('bilbospocketses', 'stable');
        api.refuse(403);
        expect((await r.resolve('bilbospocketses', 'beta'))?.tag).toBe('v0.1.30-beta.10');
        expect(await r.resolve('bilbospocketses', ['beta', 'stable'])).toMatchObject({
            tag: 'v0.1.30',
            channel: 'stable',
        });
    });

    it('a refusal with only another owner cached still throws', async () => {
        const api = fakeGithubApi([...betas(3, 10), release('v0.1.30', ['stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        await r.resolve('bilbospocketses', 'stable');
        api.refuse(403);
        const err = await r.resolve('forky', 'stable').catch((e: unknown) => e);
        expect((err as HttpStatusError).status).toBe(403);
    });

    it('a 503 with a cached answer still throws: only a refusal falls back', async () => {
        const api = fakeGithubApi([release('v0.1.30', ['stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        await r.resolve('bilbospocketses', 'stable');
        api.refuse(503);
        const err = await r.resolve('bilbospocketses', 'stable').catch((e: unknown) => e);
        expect((err as HttpStatusError).status).toBe(503);
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

    it('a different channel reuses the owner listing (304); a different owner is a different cache entry', async () => {
        const api = fakeGithubApi([...betas(3, 10), release('v0.1.30', ['stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        await r.resolve('bilbospocketses', 'stable');
        expect((await r.resolve('bilbospocketses', 'beta'))?.tag).toBe('v0.1.30-beta.10');
        expect(api.calls[1]!.ifNoneMatch).toMatch(/^"p1-/);
        await r.resolve('forky', 'beta');
        expect(api.calls[2]!.ifNoneMatch).toBeNull();
        expect(api.calls[2]!.url).toContain('/repos/forky/ws-scrcpy-web/releases');
    });

    // ── Several feeds at once: the beta channel is a superset of stable ──
    //
    // A beta-channel check asks for ['beta', 'stable'] (or the linux- pair) and
    // gets the higher version of the two, with the feed it came from.

    it('several channels: the higher version wins, whichever feed carries it', async () => {
        const api = fakeGithubApi([...betas(15, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        // A plain 0.1.30 outranks 0.1.30-beta.30.
        expect(await r.resolve('bilbospocketses', ['beta', 'stable'])).toEqual({
            tag: 'v0.1.30',
            url: 'https://github.com/bilbospocketses/ws-scrcpy-web/releases/download/v0.1.30/',
            channel: 'stable',
        });
        expect(await r.resolve('bilbospocketses', ['linux-beta', 'linux-stable'])).toMatchObject({
            tag: 'v0.1.30',
            channel: 'linux-stable',
        });
        api.set([release('v0.1.31-beta.1', ['beta', 'linux-beta']), ...betas(15, 30), release('v0.1.30', ['stable'])]);
        expect(await r.resolve('bilbospocketses', ['beta', 'stable'])).toMatchObject({
            tag: 'v0.1.31-beta.1',
            channel: 'beta',
        });
    });

    it('several channels: one with no release at all leaves the other answering alone', async () => {
        const api = fakeGithubApi(betas(14, 166));
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        expect(await r.resolve('bilbospocketses', ['beta', 'stable'])).toMatchObject({
            tag: 'v0.1.30-beta.166',
            channel: 'beta',
        });
        expect(await r.resolve('bilbospocketses', ['stable'])).toBeNull();
    });

    it('several channels: on equal versions the channel listed first wins', async () => {
        const api = fakeGithubApi([release('v0.1.30', ['beta', 'stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        expect((await r.resolve('bilbospocketses', ['beta', 'stable']))?.channel).toBe('beta');
        expect((await r.resolve('bilbospocketses', ['stable', 'beta']))?.channel).toBe('stable');
    });

    it('several channels: answered from ONE walk of the listing, re-checked with one 304 per page', async () => {
        const api = fakeGithubApi([...betas(RELEASES_PER_PAGE, 200), release('v0.1.31', ['stable'])]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        expect((await r.resolve('bilbospocketses', ['beta', 'stable']))?.tag).toBe('v0.1.31');
        expect(api.calls).toHaveLength(2);
        expect((await r.resolve('bilbospocketses', ['beta', 'stable']))?.tag).toBe('v0.1.31');
        expect(api.calls).toHaveLength(4);
        expect(api.calls[2]!.ifNoneMatch).toMatch(/^"p1-/);
        expect(api.calls[3]!.ifNoneMatch).toMatch(/^"p2-/);
    });

    it('several channels: a prerelease-flagged stable is skipped, so the beta answers', async () => {
        const api = fakeGithubApi([
            { ...release('v0.1.31', ['stable']), prerelease: true },
            release('v0.1.31-beta.4', ['beta']),
            release('v0.1.30', ['stable']),
        ]);
        const r = new GithubReleaseFeedResolver({ fetchFn: api.fetchFn, sleep: noSleep });
        expect(await r.resolve('bilbospocketses', ['beta', 'stable'])).toMatchObject({
            tag: 'v0.1.31-beta.4',
            channel: 'beta',
        });
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
