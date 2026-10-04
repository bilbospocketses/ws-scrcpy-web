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
 * So the lookup is done here, paging `per_page=100` until a release carrying the
 * feed turns up or the listing ends, and Velopack is given THAT release's
 * download folder as a plain HTTP source. Velopack's HttpSource reads
 * `<folder>/releases.<channel>.json` and downloads `<folder>/<FileName>`
 * (`sources/http.rs:38-66`), and our release workflow publishes both into the
 * same release.
 *
 * Calls follow the app's other api.github.com lookups (scrcpy-server and mkcert
 * in DependencyDefinitions.ts): unauthenticated, `User-Agent: ws-scrcpy-web`,
 * `VERSION_CHECK_POLICY`, a refusal thrown as `HttpStatusError`. The answer is
 * cached with page 1's ETag, so a check whose listing has not changed costs one
 * conditional request (answered `304`) however far back the channel's release
 * sits. Callers resolve once per update check, never per status poll.
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
     * The newest release carrying `releases.<channel>.json`, or `null` when no
     * release does -- a channel with nothing published, which is "no update",
     * not a failure. Throws when GitHub refused or could not be reached.
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
    published_at?: unknown;
    assets?: unknown;
}

function carriesFeed(r: GithubReleaseSummary, feedName: string): boolean {
    if (r.draft === true || typeof r.tag_name !== 'string' || r.tag_name.length === 0) return false;
    if (!Array.isArray(r.assets)) return false;
    return r.assets.some(
        (a: unknown) =>
            typeof a === 'object' &&
            a !== null &&
            typeof (a as { name?: unknown }).name === 'string' &&
            (a as { name: string }).name.toLowerCase() === feedName,
    );
}

function publishedAt(r: GithubReleaseSummary): string {
    return typeof r.published_at === 'string' ? r.published_at : '';
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
    private cache: { key: string; etag: string; result: ResolvedReleaseFeed | null } | null = null;

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
        let page1Etag = '';

        for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
            const url =
                `https://api.github.com/repos/${encodeURIComponent(owner)}/${REPO}/releases` +
                `?per_page=${RELEASES_PER_PAGE}&page=${page}`;
            const headers: Record<string, string> = {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'ws-scrcpy-web',
            };
            if (page === 1 && cached && cached.etag) headers['If-None-Match'] = cached.etag;

            const res = await fetchWithRetry(url, {
                init: { headers },
                ...VERSION_CHECK_POLICY,
                ...(this.fetchFn ? { fetchImpl: this.fetchFn } : {}),
                ...(this.sleep ? { sleep: this.sleep } : {}),
                onRetry: (n) => log.warn(`release lookup ${n.attempt}/${n.attempts}: ${n.reason}`),
            });
            // Page 1 unchanged since the cached answer: nothing was published,
            // edited or removed at the top of the listing, so the answer stands.
            if (page === 1 && res.status === 304 && cached) return cached.result;
            if (!res.ok) throw new HttpStatusError(res.status, res.statusText, url);
            if (page === 1) page1Etag = res.headers.get('ETag') ?? '';

            const list: unknown = await res.json();
            if (!Array.isArray(list)) {
                throw new Error(`unexpected answer from ${url}: not a list of releases`);
            }
            const releases = list as GithubReleaseSummary[];
            const matches = releases.filter((r) => carriesFeed(r, feedName));
            if (matches.length > 0) {
                // Newest by publication; the listing's own order breaks a tie.
                const newest = matches.reduce((best, r) => (publishedAt(r) > publishedAt(best) ? r : best));
                const tag = newest.tag_name as string;
                const result: ResolvedReleaseFeed = { tag, url: releaseFeedUrl(owner, tag) };
                this.cache = { key, etag: page1Etag, result };
                if (cached?.result?.tag !== tag) log.info(`channel ${channel}: newest release is ${tag}`);
                return result;
            }
            if (releases.length < RELEASES_PER_PAGE) break;
        }

        this.cache = { key, etag: page1Etag, result: null };
        if (!cached || cached.result !== null) log.info(`channel ${channel}: no release carries ${feedName}`);
        return null;
    }
}
