#!/usr/bin/env node
// scripts/check-smoke-coverage.mjs
//
// Fail a PR that changes user-visible code unless it either updates the smoke doc
// or says, in its body, why it has no smoke impact.
//
// Why this exists: #698, #700 and #713 each added their smoke rows in the same PR
// as the feature. Then #718-#721 (the whole beta.131 server batch) and #727 (the
// service-host warm-up and the new install-dialog text) merged with
// docs/smoke-tests/smoke-test.md untouched, and nothing noticed -- not CI, not
// review, not the release cut. The rows were reconstructed afterwards from the
// diffs (#725 and the row 4.3 update), which is the expensive time to write them.
// The habit exists; this makes it a decision that has to be taken, while the
// author still knows what the change does.
//
// Any answer is accepted, but it has to be given and it is recorded in the PR
// body: either smoke-test.md changes, or the body carries
//
//     <!-- smoke: none -- <why this change has no smoke impact> -->
//
// A marker with no reason does not count. A silent skip is the defect this gate
// exists to stop, and an empty reason is a silent skip with extra typing.
//
// Usage (CI): GH_TOKEN, GITHUB_REPOSITORY and PR_NUMBER set; the script reads the
// PR's files and its CURRENT body through the API. The body is read live, not
// from the event payload, so re-running the check after editing the body sees
// the edit.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SMOKE_DOC = 'docs/smoke-tests/smoke-test.md';

/**
 * Trees whose changes a user or an operator can see. `launcher/src/**` is here
 * because #727 lived there -- service-install timing and `launcher.log` lines
 * are exactly what row 4.3 checks.
 */
export const WATCHED_PREFIXES = ['src/server/', 'src/app/', 'launcher/src/'];

/** Test-only files change no behaviour anyone can smoke-test. */
export function isTestFile(path) {
    return /(^|\/)__tests__\//.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path) || /(^|\/)tests\//.test(path);
}

export function isWatched(path) {
    return WATCHED_PREFIXES.some((p) => path.startsWith(p)) && !isTestFile(path);
}

/**
 * Return the opt-out reason from a PR body, '' for a marker with an empty
 * reason, or null when there is no marker at all.
 */
export function parseOptOut(body) {
    const m = /<!--\s*smoke:\s*none\s*--\s*([\s\S]*?)\s*-->/i.exec(body ?? '');
    if (!m) return null;
    return m[1].trim();
}

/**
 * The decision, as data. `files` holds every path the PR touches, including the
 * pre-rename path of a renamed file.
 */
export function evaluate({ files, body }) {
    const watched = files.filter(isWatched);
    if (watched.length === 0) {
        return { ok: true, verdict: 'not-applicable', watched };
    }
    if (files.includes(SMOKE_DOC)) {
        return { ok: true, verdict: 'smoke-doc-updated', watched };
    }
    const reason = parseOptOut(body);
    if (reason) {
        return { ok: true, verdict: 'opted-out', reason, watched };
    }
    return { ok: false, verdict: reason === '' ? 'empty-reason' : 'missing', watched };
}

function gh(args) {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function main() {
    const repo = process.env.GITHUB_REPOSITORY;
    const pr = process.env.PR_NUMBER;
    if (!repo || !pr) {
        console.error('check-smoke-coverage: GITHUB_REPOSITORY and PR_NUMBER must be set.');
        process.exit(2);
    }

    const files = gh([
        'api',
        '--paginate',
        `repos/${repo}/pulls/${pr}/files`,
        '--jq',
        '.[] | .filename, (.previous_filename // empty)',
    ])
        .split('\n')
        .filter(Boolean);
    const body = gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.body // ""']);

    const result = evaluate({ files, body });
    const shown = result.watched.slice(0, 20).map((f) => `    - ${f}`);
    if (result.watched.length > shown.length) shown.push(`    - ... and ${result.watched.length - shown.length} more`);

    switch (result.verdict) {
        case 'not-applicable':
            console.log(`smoke coverage: no change under ${WATCHED_PREFIXES.join(', ')} -- nothing to decide.`);
            return;
        case 'smoke-doc-updated':
            console.log(`smoke coverage OK -- ${SMOKE_DOC} is updated in this PR.`);
            return;
        case 'opted-out':
            // The reason is PR-body text, so it goes in as data, never into the
            // format string (CodeQL js/tainted-format-string).
            console.log('smoke coverage OK -- opted out with a reason: %s', JSON.stringify(result.reason));
            return;
    }

    console.error(
        '%s',
        `This PR changes code a user or operator can see, and ${SMOKE_DOC} is untouched:\n` +
            `${shown.join('\n')}\n\n` +
            (result.verdict === 'empty-reason'
                ? 'The PR body has a `smoke: none` marker, but its reason is empty. A marker with no reason\n' +
                  'does not count.\n\n'
                : '') +
            'Decide one of:\n' +
            `  - add or update the rows in ${SMOKE_DOC} that cover the change, or\n` +
            '  - put this in the PR body, with the real reason:\n' +
            '        <!-- smoke: none -- <why this change has no smoke impact> -->\n\n' +
            'Editing the PR body re-runs this check on its own.',
    );
    process.exit(1);
}

// Run main only when invoked as the entry script, not when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
