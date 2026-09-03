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

export const IMAGE = 'jchapz30/ws-scrcpy-web';

/**
 * @param {string} tagName a release tag, with or without a leading `v`
 * @returns {{version: string, isBeta: boolean, tags: string[]}}
 */
export function computeTags(tagName) {
    if (typeof tagName !== 'string' || tagName.trim() === '') {
        throw new Error('docker-tags: a release tag name is required');
    }
    const version = tagName.trim().replace(/^v/, '');
    if (version === '') {
        throw new Error(`docker-tags: refusing to publish an empty version from "${tagName}"`);
    }

    const isBeta = version.includes('-beta');
    // The immutable, fully-qualified tag is ALWAYS emitted first. It is the only
    // one that can be relied on to name one specific build forever.
    const tags = [`${IMAGE}:${version}`];
    if (isBeta) {
        tags.push(`${IMAGE}:beta`);
    } else {
        tags.push(`${IMAGE}:latest`, `${IMAGE}:stable`);
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
