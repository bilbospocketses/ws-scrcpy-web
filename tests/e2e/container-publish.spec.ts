import { expect, test } from '@playwright/test';
import { dockerImageInspect, dockerPull } from './support/dockerStack';

/**
 * Smoke row 20.8 — the published image: `docker pull bilbospocketses/ws-scrcpy-web:beta`
 * pulls, and the tag points at the newest beta the release workflow pushed.
 *
 * The rule under test is docker-publish.yml's channel-tag rule (SP4 D3): every
 * beta release pushes an immutable `:X.Y.Z-beta.N` AND moves `:beta` to it, so
 * `:beta` must carry the same digest as the highest-numbered beta tag on the
 * Hub. Docker Hub's public tags API is the reference for "what was pushed";
 * the pull is the row's own action; the pulled image's RepoDigests close the
 * loop.
 *
 * `@docker-host`: it drives the docker CLI on the host and needs Docker Hub
 * reachable, so it runs in this repo's CI and not under qa-harness. Anonymous
 * pulls are rate-limited per IP; a 429 fails with the Hub's own wording rather
 * than a timeout, and is a retry, not a product finding.
 */

const REPO = 'bilbospocketses/ws-scrcpy-web';
const BETA_TAG = /^0\.1\.30-beta\.(\d+)$/;

interface HubTag {
    name: string;
    digest?: string;
    images?: { digest: string; architecture: string }[];
}

function digestOf(tag: HubTag): string | undefined {
    return tag.digest ?? tag.images?.[0]?.digest;
}

test.describe('published image (smoke §20.8)', () => {
    test('@docker @docker-host 20.8 `:beta` pulls from Docker Hub and is the newest beta the release workflow pushed', async () => {
        test.setTimeout(900_000);

        // 100 tags is more than the whole beta history to date; ordering by
        // last_updated puts the current channel tag and its target on page one
        // regardless.
        const res = await fetch(
            `https://hub.docker.com/v2/repositories/${REPO}/tags?page_size=100&ordering=last_updated`,
        );
        expect(res.status, `Docker Hub tags API for ${REPO}`).toBe(200);
        const body = (await res.json()) as { results: HubTag[] };

        const betas = body.results
            .map((t) => ({ tag: t, match: BETA_TAG.exec(t.name) }))
            .filter((x): x is { tag: HubTag; match: RegExpExecArray } => x.match !== null)
            .map((x) => ({ name: x.tag.name, n: Number(x.match[1]), digest: digestOf(x.tag) }))
            .sort((a, b) => b.n - a.n);
        expect(betas.length, 'at least one 0.1.30-beta.N tag is published').toBeGreaterThan(0);
        const newest = betas[0]!;
        expect(newest.digest, `${newest.name} carries a digest`).toBeTruthy();

        const channel = body.results.find((t) => t.name === 'beta');
        expect(channel, 'the :beta channel tag exists').toBeTruthy();
        // D3: a beta release moves :beta. Anything else means the publish
        // workflow pushed the immutable tag and not the channel, or vice versa.
        expect(digestOf(channel!), `:beta should point at ${newest.name}`).toBe(newest.digest);

        // The row's own action, then the loop closed: what was pulled is what
        // the Hub says :beta is.
        dockerPull(`${REPO}:beta`);
        const repoDigests = JSON.parse(dockerImageInspect(`${REPO}:beta`, '{{json .RepoDigests}}')) as string[];
        expect(repoDigests).toContain(`${REPO}@${newest.digest}`);
    });
});
