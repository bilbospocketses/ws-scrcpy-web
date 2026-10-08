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
 * SEVERAL FEEDS, ONE WALK (2026-10-07). The beta channel is a superset of
 * stable: a beta-channel check asks for the newest release carrying EITHER the
 * beta or the stable feed, and takes whichever version is higher. Both are
 * answered from one walk of the listing -- each page is read once and
 * remembered with every feed file each release on it carries -- so a beta
 * check costs the same requests as a stable one, and the two can never be
 * answered from listings read at different moments.
 *
 * Calls follow the app's other api.github.com lookups (scrcpy-server and mkcert
 * in DependencyDefinitions.ts): unauthenticated, `User-Agent: ws-scrcpy-web`,
 * `VERSION_CHECK_POLICY`, a refusal thrown as `HttpStatusError`. Each page is
 * cached with its own ETag and asked for conditionally next time, so an
 * unchanged page is answered `304` and not re-parsed. The cache is per owner,
 * not per channel: the listing is the same whichever feed is wanted. A refusal
 * (403/429) when this owner's listing was read before answers from that
 * reading instead of failing the check. Callers resolve once per update check,
 * never per status poll.
 */

/** Releases asked for per page; GitHub's maximum. */
export const RELEASES_PER_PAGE = 100;

/**
 * Pages walked before giving up: 1,000 releases, several times what this repo
 * has ever published. Only a bound, so a misbehaving listing cannot loop.
 */
export const MAX_RELEASE_PAGES = 10;

const REPO = 'ws-scrcpy-web';

/** The release Velopack should read, the folder its assets download from, and the feed it was chosen for. */
export interface ResolvedReleaseFeed {
    tag: string;
    url: string;
    /**
     * Which of the asked-for feed channels this release carries, and so which
     * `releases.<channel>.json` Velopack must read from its folder (the
     * `ExplicitChannel`).
     */
    channel: string;
}

export interface ReleaseFeedResolver {
    /**
     * The highest-versioned published, non-prerelease release carrying
     * `releases.<channel>.json` for ANY of `channels`, or `null` when no
     * release carries any of them -- a channel with nothing published, which is
     * "no update", not a failure. `channels` is in order of preference: when
     * two candidates have the same version, the earlier channel wins. Throws
     * when GitHub could not be reached, or refused with no earlier reading of
     * this owner's listing to fall back on.
     */
    resolve(owner: string, channels: string | readonly string[]): Promise<ResolvedReleaseFeed | null>;
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

/** A Velopack feed file's asset name, lowercased: `releases.<channel>.json`. */
function feedFileName(channel: string): string {
    return `releases.${channel}.json`.toLowerCase();
}

const FEED_FILE = /^releases\..+\.json$/;

/**
 * The feed files (lowercased asset names) of a release an update may come
 * from: published (not a draft), NOT marked prerelease, with a tag. Any other
 * release carries none, as far as an update is concerned.
 *
 * The prerelease skip is the rollback lever. release.yml never sets the flag
 * (docs/RELEASING.md, "Cutting a beta release"), so a prerelease is a release
 * someone retracted with `gh release edit vX.Y.Z --prerelease` -- the first
 * step of the rollback procedure -- and no install may be offered it.
 */
function feedsCarried(r: GithubReleaseSummary): string[] {
    if (r.draft === true || r.prerelease === true) return [];
    if (typeof r.tag_name !== 'string' || r.tag_name.length === 0) return [];
    if (!Array.isArray(r.assets)) return [];
    const feeds: string[] = [];
    for (const a of r.assets as unknown[]) {
        if (typeof a !== 'object' || a === null) continue;
        const name = (a as { name?: unknown }).name;
        if (typeof name !== 'string') continue;
        const lower = name.toLowerCase();
        if (FEED_FILE.test(lower)) feeds.push(lower);
    }
    return feeds;
}

/** One page of the listing as last read: its ETag, and the releases on it that carry any feed. */
interface PageScan {
    etag: string;
    /** Releases on the page, matching or not; a short page is the last one. */
    count: number;
    releases: { tag: string; feeds: string[] }[];
}

/**
 * The highest version among the releases carrying any of `channels`' feeds;
 * on a tie the channel listed first wins, then the release met first.
 */
function pickNewest(owner: string, pages: PageScan[], channels: readonly string[]): ResolvedReleaseFeed | null {
    let best: { tag: string; channel: string } | null = null;
    for (const channel of channels) {
        const feed = feedFileName(channel);
        for (const r of pages.flatMap((p) => p.releases)) {
            if (!r.feeds.includes(feed)) continue;
            if (best === null || compareVersions(r.tag, best.tag) > 0) best = { tag: r.tag, channel };
        }
    }
    return best === null ? null : { tag: best.tag, url: releaseFeedUrl(owner, best.tag), channel: best.channel };
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
    /**
     * The last complete walk of one owner's listing: every page read, each
     * remembering every feed file its releases carry, so any channel -- or
     * several at once -- is answered from it.
     */
    private cache: { owner: string; pages: PageScan[] } | null = null;
    /** The last answer logged per owner + channel set, so an unchanged answer is not logged every check. */
    private readonly logged = new Map<string, string | null>();

    constructor(opts: GithubReleaseFeedResolverOptions = {}) {
        this.fetchFn = opts.fetchFn;
        this.sleep = opts.sleep;
    }

    public forget(): void {
        this.cache = null;
        this.logged.clear();
    }

    public async resolve(owner: string, channels: string | readonly string[]): Promise<ResolvedReleaseFeed | null> {
        const wanted: readonly string[] = typeof channels === 'string' ? [channels] : channels;
        const label = wanted.join(' + ');
        const cached = this.cache?.owner === owner ? this.cache : null;

        let pages: PageScan[];
        try {
            pages = await this.scan(owner, cached?.pages ?? []);
        } catch (err) {
            // GitHub refused (a rate limit is a 403 or 429 unauthenticated) but
            // this owner's listing was read before: answer from that reading
            // rather than fail the check. Releases change rarely next to a
            // check interval, and the next check asks again.
            if (cached && isRefusal(err)) {
                const kept = pickNewest(owner, cached.pages, wanted);
                log.info(
                    `release lookup refused (HTTP ${err.status}); answering channel ${label} from the last ` +
                        `listing read: ${kept ? `${kept.tag} (${kept.channel})` : 'no release'}`,
                );
                return kept;
            }
            throw err;
        }
        this.cache = { owner, pages };

        // The highest version among every match on every page read. GitHub's
        // listing is ordered neither by publication nor by version (measured
        // 2026-10-04: beta.92 listed above beta.102), so neither the first
        // match nor the newest `published_at` is reliably the newest version.
        const result = pickNewest(owner, pages, wanted);
        const logKey = `${owner}\n${label}`;
        const shown = result ? `${result.tag}\n${result.channel}` : null;
        if (!this.logged.has(logKey) || this.logged.get(logKey) !== shown) {
            log.info(
                result
                    ? `channel ${label}: newest release is ${result.tag} (${feedFileName(result.channel)})`
                    : `channel ${label}: no release carries ${wanted.map(feedFileName).join(' or ')}`,
            );
            this.logged.set(logKey, shown);
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
    private async scan(owner: string, previous: PageScan[]): Promise<PageScan[]> {
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
                    releases: releases
                        .map((r) => ({ tag: r.tag_name as string, feeds: feedsCarried(r) }))
                        .filter((r) => r.feeds.length > 0),
                };
            }
            pages.push(scanned);
            if (scanned.count < RELEASES_PER_PAGE) break;
        }
        return pages;
    }
}
