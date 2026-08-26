#!/usr/bin/env node
// scripts/assert-bump-blob-sync.mjs
//
// Assert that the files `bump-version.mjs` rewrites are exactly the files
// `.github/workflows/auto-release.yml` uploads into the API-signed bump commit.
//
// Why this exists: the auto-release workflow cannot `git push` the bump (main is
// protected and requires signed commits), so it creates the commit through the
// GitHub API -- which means assembling the tree from an explicit list of blobs.
// Only paths in that list reach the commit. Before this check, the two lists were
// coupled by a comment: when bump-version.mjs learned to write package-lock.json
// and the workflow was not updated, v0.1.30-beta.74 shipped a lock still pinned at
// beta.73, failed the tag-time version-sync gate, and burned the version number
// (release tags are protected against deletion, so it could not be reused).
//
// Usage: node scripts/assert-bump-blob-sync.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUMPED_FILES } from './bump-version.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_REL = '.github/workflows/auto-release.yml';

/**
 * Pull the tree entry paths out of the workflow's `gh api .../git/trees` heredoc.
 * Matches the `{"path": "<p>", "mode": ...}` objects the workflow emits.
 */
export function parseWorkflowTreePaths(yaml) {
    const paths = [...yaml.matchAll(/\{\s*"path"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
    if (paths.length === 0) {
        throw new Error(
            `${WORKFLOW_REL}: found no tree-entry paths. The bump commit's tree assembly ` +
                'changed shape -- update this parser to match, do not delete the check.',
        );
    }
    return paths;
}

function main() {
    const yaml = readFileSync(join(REPO_ROOT, WORKFLOW_REL), 'utf8');
    const inWorkflow = new Set(parseWorkflowTreePaths(yaml));
    const inScript = new Set(BUMPED_FILES);

    const missingFromWorkflow = [...inScript].filter((f) => !inWorkflow.has(f));
    const missingFromScript = [...inWorkflow].filter((f) => !inScript.has(f));

    if (missingFromWorkflow.length === 0 && missingFromScript.length === 0) {
        console.log(`bump/blob sync OK — ${[...inScript].sort().join(', ')}`);
        return;
    }

    console.error('Version-bump file list is out of sync with the auto-release blob list.\n');
    if (missingFromWorkflow.length > 0) {
        console.error(
            `  bump-version.mjs writes these, but ${WORKFLOW_REL} never uploads them:\n` +
                missingFromWorkflow.map((f) => `    - ${f}`).join('\n') +
                '\n  => The bump commit would silently ship a stale copy of each. Add a\n' +
                '     create_blob line and a tree entry for each path in the workflow.\n',
        );
    }
    if (missingFromScript.length > 0) {
        console.error(
            `  ${WORKFLOW_REL} uploads these, but bump-version.mjs does not write them:\n` +
                missingFromScript.map((f) => `    - ${f}`).join('\n') +
                '\n  => The bump commit would re-upload an unchanged file. Drop it from the\n' +
                '     workflow, or add it to BUMPED_FILES if the script should write it.\n',
        );
    }
    process.exit(1);
}

// Run main only when invoked as the entry script, not when a test imports the parser.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
