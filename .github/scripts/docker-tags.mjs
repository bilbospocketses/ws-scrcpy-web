#!/usr/bin/env node
// .github/scripts/docker-tags.mjs
//
// Turns a published release's tag name into the Docker tag list, and prints it
// as a `tags=` line for $GITHUB_OUTPUT.
//
// The channel rule is the SAME one package-linux.mjs uses: version.includes('-beta').
// It is restated here rather than imported so the workflow has no build-order
// dependency on the Node toolchain being set up first — but the two must not
// drift, which is what the unit tests pin.
//
// The rule that matters is the negative one: a beta must NEVER become :latest.
// That is the single output whose being wrong is silently destructive — it
// reaches every user who follows the default tag, which is exactly what SP4 D3
// exists to prevent. It is unit-tested rather than first exercised on a real
// release.

export const IMAGE_NAME = 'ws-scrcpy-web';

// Fully-qualified namespaces. Written out rather than bare so a six-entry tag
// list is unambiguous about which entry targets which registry; user-facing
// docs use the bare `bilbospocketses/ws-scrcpy-web` form instead.
export const CANONICAL = 'docker.io/bilbospocketses';
export const MIRROR = 'ghcr.io/bilbospocketses';
export const DEPRECATED = 'docker.io/jchapz30';

// The deprecation window closes ITSELF. Publishing to a deleted namespace
// fails the release, and a repo variable someone must remember to flip 90 days
// out is exactly the thing that gets forgotten. The cost is that behaviour
// changes with no commit — accepted deliberately; see the design doc.
export const DEPRECATED_THROUGH = '2026-12-09';

/**
 * @param {Date} [now]
 * @returns {string[]} namespaces to publish to, canonical first
 */
export function activeNamespaces(now = new Date()) {
    const live = [CANONICAL, MIRROR];
    if (now.getTime() <= Date.parse(`${DEPRECATED_THROUGH}T23:59:59Z`)) {
        live.push(DEPRECATED);
    }
    return live;
}

/**
 * @param {string} tagName a release tag, with or without a leading `v`
 * @param {{ now?: Date }} [opts] `now` is injected so the sunset boundary is
 *   testable on both sides rather than trusted.
 * @returns {{version: string, isBeta: boolean, tags: string[]}}
 */
export function computeTags(tagName, { now = new Date() } = {}) {
    if (typeof tagName !== 'string' || tagName.trim() === '') {
        throw new Error('docker-tags: a release tag name is required');
    }
    const version = tagName.trim().replace(/^v/, '');
    if (version === '') {
        throw new Error(`docker-tags: refusing to publish an empty version from "${tagName}"`);
    }

    const isBeta = version.includes('-beta');
    const channels = isBeta ? ['beta'] : ['latest', 'stable'];

    const tags = [];
    for (const namespace of activeNamespaces(now)) {
        const image = `${namespace}/${IMAGE_NAME}`;
        // The immutable, fully-qualified tag is ALWAYS emitted first within a
        // namespace. It is the only one that names one specific build forever.
        tags.push(`${image}:${version}`);
        for (const channel of channels) {
            tags.push(`${image}:${channel}`);
        }
    }
    return { version, isBeta, tags };
}

// CLI: only when run directly, so the tests can import the pure function.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('docker-tags.mjs')) {
    const tagName = process.argv[2];
    try {
        const { tags } = computeTags(tagName);
        // build-push-action takes a newline- or comma-separated list; a single
        // line keeps this usable with `>> "$GITHUB_OUTPUT"` without heredoc
        // delimiters.
        process.stdout.write(`tags=${tags.join(',')}\n`);
    } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exit(1);
    }
}
