import { compareVersions } from '../common/DependencyTypes';
import { Logger } from './Logger';
import { fetchWithRetry, HttpStatusError, VERSION_CHECK_POLICY } from './util/fetchWithRetry';

const log = Logger.for('UpdateFeedResolver');

/**
 * Finds the release an update check should read: the newest GitHub release of
 * this repo that carries the selected channel's Velopack feed file
 * (`releases.<channel>.json`).
 *
 * WHY THIS EXISTS. The check used to hand Velopack the bare repo URL. Velopack
 * maps a github.com URL to its GithubSource (velopack 1.2.161
 * `sources/mod.rs:64-69`), and GithubSource makes ONE request for the 10 newest
 * releases (`sources/github.rs:77-89`, `per_page=10&page=1`), merging whatever
 * `releases.<channel>.json` it finds among those ten. Every beta is a full
 * release, and betas ship many a day -- so once ten betas came after a stable
 * release, a stable-channel install could no longer see it, and nothing
 * reported anything: an empty feed reads as "no update". The channel itself was
 * never gated anywhere; only that ten-release window was.
 *
 * So the lookup is done here: the whole listing is read (`per_page=100`, to its
 * end or {@link MAX_RELEASE_PAGES}), the highest version among the published,
 * non-prerelease releases carrying the feed is chosen, and Velopack is given
 * THAT release's download folder as a plain HTTP source. Velopack's HttpSource
 * reads `<folder>/releases.<channel>.json` and downloads `<folder>/<FileName>`
 * (`sources/http.rs:38-66`), and our release workflow publishes both into the
 * same release.
 *
 * Calls follow the app's other api.github.com lookups (scrcpy-server and mkcert
 * in DependencyDefinitions.ts): unauthenticated, `User-Agent: ws-scrcpy-web`,
 * `VERSION_CHECK_POLICY`, a refusal thrown as `HttpStatusError`. Each page is
 * cached with its own ETag and asked for conditionally next time, so an
 * unchanged page is answered `304` and not re-parsed. A refusal (403/429) when
 * this owner + channel was answered before keeps that answer instead of
 * failing the check. Callers resolve once per update check, never per status
 * poll.
 */

/** Releases asked for per page; GitHub's maximum. */
export const RELEASES_PER_PAGE = 100;

/**
 * Pages walked before giving up: 1,000 releases, several times what this repo
 * has ever published. Only a bound, so a misbehaving listing cannot loop.
 */
export const MAX_RELEASE_PAGES = 10;

const REPO = 'ws-scrcpy-web';

/** The release Velopack should read, and the folder its assets download from. */
export interface ResolvedReleaseFeed {
    tag: string;
    url: string;
}

export interface ReleaseFeedResolver {
    /**
     * The highest-versioned published, non-prerelease release carrying
     * `releases.<channel>.json`, or `null` when no release does -- a channel
     * with nothing published, which is "no update", not a failure. Throws when
     * GitHub could not be reached, or refused with no earlier answer for this
     * owner + channel to fall back on.
     */
    resolve(owner: string, channel: string): Promise<ResolvedReleaseFeed | null>;
    /** Drop any cached answer, so the next resolve walks the listing again. */
    forget?(): void;
}

/** A release's download folder, with the trailing slash Velopack's HttpSource joins file names onto. */
export function releaseFeedUrl(owner: string, tag: string): string {
    return `https://github.com/${encodeURIComponent(owner)}/${REPO}/releases/download/${encodeURIComponent(tag)}/`;
}

interface GithubReleaseSummary {
    tag_name?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    assets?: unknown;
}

/**
 * A release an update may come from: published (not a draft), NOT marked
 * prerelease, and carrying the channel's feed file.
 *
 * The prerelease skip is the rollback lever. release.yml never sets the flag
 * (docs/RELEASING.md, "Cutting a beta release"), so a prerelease is a release
 * someone retracted with `gh release edit vX.Y.Z --prerelease` -- the first
 * step of the rollback procedure -- and no install may be offered it.
 */
function carriesFeed(r: GithubReleaseSummary, feedName: string): boolean {
    if (r.draft === true || r.prerelease === true) return false;
    if (typeof r.tag_name !== 'string' || r.tag_name.length === 0) return false;
    if (!Array.isArray(r.assets)) return false;
    return r.assets.some(
        (a: unknown) =>
            typeof a === 'object' &&
            a !== null &&
            typeof (a as { name?: unknown }).name === 'string' &&
            (a as { name: string }).name.toLowerCase() === feedName,
    );
}

/** One page of the listing as last read: its ETag, and the tags on it that carry the feed. */
interface PageScan {
    etag: string;
    /** Releases on the page, matching or not; a short page is the last one. */
    count: number;
    matches: string[];
}

/** HTTP statuses that mean GitHub answered and refused (rate limit or permission). */
function isRefusal(err: unknown): err is HttpStatusError {
    return err instanceof HttpStatusError && (err.status === 403 || err.status === 429);
}

export interface GithubReleaseFeedResolverOptions {
    /** Defaults to the global fetch. */
    fetchFn?: typeof fetch;
    /** Backoff sleep between retries; injectable so tests never wait. */
    sleep?: (ms: number) => Promise<void>;
}

export class GithubReleaseFeedResolver implements ReleaseFeedResolver {
    private readonly fetchFn: typeof fetch | undefined;
    private readonly sleep: ((ms: number) => Promise<void>) | undefined;
    /** The last complete scan for one owner + channel: every page read, and the answer drawn from them. */
    private cache: { key: string; pages: PageScan[]; result: ResolvedReleaseFeed | null } | null = null;

    constructor(opts: GithubReleaseFeedResolverOptions = {}) {
        this.fetchFn = opts.fetchFn;
        this.sleep = opts.sleep;
    }

    public forget(): void {
        this.cache = null;
    }

    public async resolve(owner: string, channel: string): Promise<ResolvedReleaseFeed | null> {
        const key = `${owner}\n${channel}`;
        const feedName = `releases.${channel}.json`.toLowerCase();
        const cached = this.cache?.key === key ? this.cache : null;

        let pages: PageScan[];
        try {
            pages = await this.scan(owner, feedName, cached?.pages ?? []);
        } catch (err) {
            // GitHub refused (a rate limit is a 403 or 429 unauthenticated) but
            // this owner + channel was answered before: keep that answer rather
            // than fail the check. Releases change rarely next to a check
            // interval, and the next check asks again.
            if (cached && isRefusal(err)) {
                log.info(
                    `release lookup refused (HTTP ${err.status}); keeping the last answer for channel ${channel}: ` +
                        `${cached.result?.tag ?? 'no release'}`,
                );
                return cached.result;
            }
            throw err;
        }

        // The highest version among every match on every page read. GitHub's
        // listing is ordered neither by publication nor by version (measured
        // 2026-10-04: beta.92 listed above beta.102), so neither the first
        // match nor the newest `published_at` is reliably the newest version.
        let tag: string | null = null;
        for (const t of pages.flatMap((p) => p.matches)) {
            if (tag === null || compareVersions(t, tag) > 0) tag = t;
        }
        const result: ResolvedReleaseFeed | null = tag === null ? null : { tag, url: releaseFeedUrl(owner, tag) };
        this.cache = { key, pages, result };
        if (tag === null) {
            if (!cached || cached.result !== null) log.info(`channel ${channel}: no release carries ${feedName}`);
        } else if (cached?.result?.tag !== tag) {
            log.info(`channel ${channel}: newest release is ${tag}`);
        }
        return result;
    }

    /**
     * Read the listing to its end (or {@link MAX_RELEASE_PAGES}). Every page is
     * asked for conditionally with the ETag it had last time, and a `304`
     * reuses that page's earlier reading.
     *
     * Every page, not just page 1: a later page can change while page 1 does
     * not -- a release further back edited (assets added or removed, marked
     * prerelease to roll it back) or deleted -- so page 1's ETag alone cannot
     * vouch for the whole answer. The cost is one request per page per check
     * (two pages today), against the unauthenticated limit of 60 an hour.
     */
    private async scan(owner: string, feedName: string, previous: PageScan[]): Promise<PageScan[]> {
        const pages: PageScan[] = [];
        for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
            const url =
                `https://api.github.com/repos/${encodeURIComponent(owner)}/${REPO}/releases` +
                `?per_page=${RELEASES_PER_PAGE}&page=${page}`;
            const headers: Record<string, string> = {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'ws-scrcpy-web',
            };
            const prior = previous[page - 1];
            if (prior?.etag) headers['If-None-Match'] = prior.etag;

            const res = await fetchWithRetry(url, {
                init: { headers },
                ...VERSION_CHECK_POLICY,
                ...(this.fetchFn ? { fetchImpl: this.fetchFn } : {}),
                ...(this.sleep ? { sleep: this.sleep } : {}),
                onRetry: (n) => log.warn(`release lookup ${n.attempt}/${n.attempts}: ${n.reason}`),
            });

            let scanned: PageScan;
            if (res.status === 304 && prior) {
                scanned = prior;
            } else {
                if (!res.ok) throw new HttpStatusError(res.status, res.statusText, url);
                const list: unknown = await res.json();
                if (!Array.isArray(list)) {
                    throw new Error(`unexpected answer from ${url}: not a list of releases`);
                }
                const releases = list as GithubReleaseSummary[];
                scanned = {
                    etag: res.headers.get('ETag') ?? '',
                    count: releases.length,
                    matches: releases.filter((r) => carriesFeed(r, feedName)).map((r) => r.tag_name as string),
                };
            }
            pages.push(scanned);
            if (scanned.count < RELEASES_PER_PAGE) break;
        }
        return pages;
    }
}
