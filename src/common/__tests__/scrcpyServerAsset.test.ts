import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVER_JAR_SHA256, SERVER_VERSION } from '../Constants';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VENDORED_JAR = path.join(REPO_ROOT, 'assets', 'scrcpy-server');

/**
 * SERVER_VERSION is handed to `app_process ... com.genymobile.scrcpy.Server
 * <version>`, and scrcpy rejects a mismatch against the JAR it was started
 * from. It is ALSO the fallback `getInstalledScrcpyServerVersion` returns for
 * seed-promoted installs, which carry no `.version` marker — so on a fresh
 * install the constant and the vendored JAR are the only two things that have
 * to agree, with nothing else to catch it when they don't.
 *
 * They silently disagreed for three months: the v4.0 wire-protocol port
 * (179159b, 2026-05-15) moved `ScrcpyConnection.parseMetadata` + `FrameReader`
 * to the v4 layout while the vendored JAR and this constant stayed at 3.3.4.
 * Every fresh install seed-promoted a v3 JAR into a v4-only parser and failed
 * to mirror until the user manually hit the dependency panel.
 *
 * Keying the hash pin BY VERSION closes the drift in both directions: bumping
 * SERVER_VERSION without adding an entry fails on the missing key, and
 * swapping the JAR without bumping the version fails on the hash.
 */
describe('vendored scrcpy-server asset', () => {
    it('declares a pinned hash for the current SERVER_VERSION', () => {
        expect(SERVER_JAR_SHA256[SERVER_VERSION]).toBeDefined();
    });

    it('matches the hash pinned for SERVER_VERSION', () => {
        const actual = createHash('sha256').update(readFileSync(VENDORED_JAR)).digest('hex');
        expect(actual).toBe(SERVER_JAR_SHA256[SERVER_VERSION]);
    });
});
