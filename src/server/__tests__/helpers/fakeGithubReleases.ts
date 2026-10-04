import { createHash } from 'crypto';
import { vi } from 'vitest';

/**
 * A stand-in for GitHub's `GET /repos/<owner>/ws-scrcpy-web/releases`, paged
 * and ETag'd the way the real endpoint is, so update-feed resolution can be
 * tested without the network.
 */

export interface FakeRelease {
    tag_name: string;
    /** Left unset, the fake API dates a release by its place in the listing: first is newest. */
    published_at?: string;
    draft?: boolean;
    prerelease?: boolean;
    assets: { name: string }[];
}

const NEWEST = Date.UTC(2026, 9, 4);

/** A release carrying the feed files for `channels` (e.g. ['beta', 'linux-beta']). */
export function release(tag: string, channels: string[]): FakeRelease {
    return {
        tag_name: tag,
        assets: [
            ...channels.map((c) => ({ name: `releases.${c}.json` })),
            { name: `WsScrcpyWeb-${tag.replace(/^v/, '')}-full.nupkg` },
            { name: 'SHA256SUMS' },
        ],
    };
}

/** `count` beta releases (Windows + Linux feeds), newest first, numbered down from `top`. */
export function betas(count: number, top: number): FakeRelease[] {
    return Array.from({ length: count }, (_, i) => release(`v0.1.30-beta.${top - i}`, ['beta', 'linux-beta']));
}

export interface FakeGithubApi {
    fetchFn: typeof fetch;
    calls: { url: string; ifNoneMatch: string | null }[];
    /**
     * Replace the listing (newest first). Each page's ETag is derived from that
     * page's own content, as GitHub's is: a page whose releases did not change
     * keeps its ETag, so an edit further back leaves page 1's untouched.
     */
    set(list: FakeRelease[]): void;
    /** Answer every request with this status instead of a listing (`null` to stop). */
    refuse(status: number | null): void;
}

export function fakeGithubApi(initial: FakeRelease[]): FakeGithubApi {
    let list = initial;
    let refusal: number | null = null;
    const calls: FakeGithubApi['calls'] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        calls.push({ url: url.toString(), ifNoneMatch: headers.get('If-None-Match') });
        if (refusal !== null) return new Response('{"message":"refused"}', { status: refusal });
        if (url.host !== 'api.github.com' || !/^\/repos\/[^/]+\/ws-scrcpy-web\/releases$/.test(url.pathname)) {
            return new Response('not found', { status: 404 });
        }
        const perPage = Number(url.searchParams.get('per_page') ?? '30');
        const page = Number(url.searchParams.get('page') ?? '1');
        const start = (page - 1) * perPage;
        const slice = list.slice(start, start + perPage).map((r, i) => ({
            ...r,
            published_at: r.published_at ?? new Date(NEWEST - (start + i) * 60_000).toISOString(),
        }));
        const body = JSON.stringify(slice);
        const etag = `"p${page}-${createHash('sha1').update(body).digest('hex').slice(0, 12)}"`;
        if (headers.get('If-None-Match') === etag) return new Response(null, { status: 304 });
        return new Response(body, { status: 200, headers: { ETag: etag } });
    }) as unknown as typeof fetch;
    return {
        fetchFn,
        calls,
        set(next) {
            list = next;
        },
        refuse(status) {
            refusal = status;
        },
    };
}
