import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as openpgp from 'openpgp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildPinnedKeysModule,
    droppedSelfSignatures,
    previousArmored,
    signatureCounts,
} from '../refresh-release-keys.mjs';

/**
 * M5: a refresh must keep every self-signature and subkey binding a pinned key
 * already has. verifyOpenPgp refuses a signature made while the key had lapsed
 * only while the pinned copy still holds the self-signature that let it lapse;
 * a publisher re-exporting the key minimised would otherwise erase that
 * history in a routine refresh. Offline: fetch is stubbed with throwaway keys.
 */

const NODE_RAW = 'https://raw.githubusercontent.com/nodejs/release-keys/main';

/** A key with two self-signatures (the original and a renewal) on its user ID, and the same key with only the renewal. */
async function renewedKey(name) {
    const userIDs = [{ name }];
    const { privateKey } = await openpgp.generateKey({
        type: 'ecc',
        curve: 'ed25519Legacy',
        userIDs,
        date: new Date('2020-01-01T00:00:00Z'),
        keyExpirationTime: 30 * 24 * 3600,
        format: 'object',
    });
    const renewal = (
        await openpgp.reformatKey({ privateKey, userIDs, date: new Date('2020-04-01T00:00:00Z'), format: 'object' })
    ).publicKey;
    const full = privateKey.toPublic();
    full.users[0].selfCertifications.push(...renewal.users[0].selfCertifications);
    full.subkeys[0].bindingSignatures.push(...renewal.subkeys[0].bindingSignatures);
    return { fingerprint: full.getFingerprint().toUpperCase(), full: full.armor(), minimised: renewal.armor() };
}

/** Serves nodejs/release-keys with one active key, nodejs/node's README, rom1v.asc and scrcpy's verify doc. */
function stubPublishers(node, nodeArmored, scrcpy) {
    const pages = new Map([
        [
            `${NODE_RAW}/README.md`,
            `<!-- Active releasers keys -->\n* **Test Releaser** <<t@example.invalid>>\n  [\`${node.fingerprint}\`](./keys/${node.fingerprint}.asc)\n<!-- /Active releasers keys -->\n<!-- Retired keys -->\n<!-- /Retired keys -->\n`,
        ],
        [`${NODE_RAW}/keys.list`, `${node.fingerprint}\n`],
        [`${NODE_RAW}/keys/${node.fingerprint}.asc`, nodeArmored],
        ['https://raw.githubusercontent.com/nodejs/node/main/README.md', node.fingerprint],
        ['https://blog.rom1v.com/keys/rom1v.asc', scrcpy.full],
        ['https://raw.githubusercontent.com/Genymobile/scrcpy/master/doc/verify-release.md', scrcpy.fingerprint],
    ]);
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url) =>
            pages.has(url) ? new Response(pages.get(url)) : new Response('not stubbed', { status: 404 }),
        ),
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('refresh-release-keys keeps every self-signature', () => {
    it('counts the self-signatures and bindings openpgp reads, and names the ones a copy dropped', async () => {
        const k = await renewedKey('counted');
        const full = await openpgp.readKey({ armoredKey: k.full });
        const minimised = await openpgp.readKey({ armoredKey: k.minimised });

        expect(signatureCounts(full)).toEqual({ selfSignatures: 2, subkeyBindings: 2 });
        expect(signatureCounts(minimised)).toEqual({ selfSignatures: 1, subkeyBindings: 1 });
        const dropped = droppedSelfSignatures(full, minimised);
        expect(dropped).toHaveLength(2);
        expect(dropped[0]).toBe('self-signature on user ID "counted" made 2020-01-01T00:00:00.000Z');
        expect(dropped[1]).toMatch(/^binding of subkey [0-9A-F]{40} made 2020-01-01T00:00:00\.000Z$/);
        expect(droppedSelfSignatures(minimised, full)).toEqual([]);
    });

    it('fails, writing nothing, when a fetched key lacks a self-signature the pinned copy has', async () => {
        const [node, scrcpy] = await Promise.all([renewedKey('node'), renewedKey('scrcpy')]);
        stubPublishers(node, node.minimised, scrcpy);
        const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`exit ${code}`);
        });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(buildPinnedKeysModule({ previous: new Map([[node.fingerprint, node.full]]) })).rejects.toThrow(
            'exit 1',
        );

        expect(exit).toHaveBeenCalledWith(1);
        expect(error.mock.calls[0][1]).toContain(
            `Node.js key ${node.fingerprint} as fetched lacks 2 self-signature(s) or binding(s) the pinned copy has`,
        );
    });

    it('pins the fetched copy anyway with --allow-dropped-self-signatures, warning what it drops', async () => {
        const [node, scrcpy] = await Promise.all([renewedKey('node'), renewedKey('scrcpy')]);
        stubPublishers(node, node.minimised, scrcpy);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // vitest.setup.ts makes process.exit a no-op, so a fail() would otherwise carry on unseen.
        const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`exit ${code}`);
        });

        const built = await buildPinnedKeysModule({
            previous: new Map([[node.fingerprint, node.full]]),
            allowDropped: true,
        });

        expect(exit).not.toHaveBeenCalled();
        expect(built.node).toEqual([node.fingerprint]);
        expect(built.module).toContain('selfSignatures: 1,');
        expect(warn.mock.calls.some((c) => String(c[1]).includes('lacks 2 self-signature(s)'))).toBe(true);
    });

    it('stores a fetched key verbatim and records its counts when nothing was dropped', async () => {
        const [node, scrcpy] = await Promise.all([renewedKey('node'), renewedKey('scrcpy')]);
        stubPublishers(node, node.full, scrcpy);
        const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`exit ${code}`);
        });

        const built = await buildPinnedKeysModule({ previous: new Map([[node.fingerprint, node.minimised]]) });

        expect(exit).not.toHaveBeenCalled();
        expect(built.module).toContain(node.full);
        expect(built.module).toContain(scrcpy.full);
        expect(built.module.match(/selfSignatures: 2,\n {8}subkeyBindings: 2,/g)).toHaveLength(2);
    });
});

describe('refresh-release-keys reads the pinned module back, or stops', () => {
    const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-refresh-keys-'));
    const exitThrows = () =>
        vi.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`exit ${code}`);
        });

    it('reads every pinned key from the real generated module', () => {
        const real = path.join(
            import.meta.dirname,
            '..',
            '..',
            'src',
            'server',
            'release-keys',
            'pinnedReleaseKeys.ts',
        );
        const listed = new Set(
            [...fs.readFileSync(real, 'utf8').matchAll(/fingerprint: '([0-9A-F]{40})'/g)].map((m) => m[1]),
        );
        const exit = exitThrows();

        const pinned = previousArmored(real);

        expect(exit).not.toHaveBeenCalled();
        expect(listed.size).toBeGreaterThan(0);
        expect(pinned.size).toBe(listed.size);
    });

    it('returns nothing, without failing, when no module exists yet', () => {
        const exit = exitThrows();
        expect(previousArmored(path.join(tmp(), 'absent.ts')).size).toBe(0);
        expect(exit).not.toHaveBeenCalled();
    });

    it('stops when the module lists keys it cannot read back (a changed format)', () => {
        const file = path.join(tmp(), 'pinned.ts');
        // Fingerprints present, but the armored text is no longer in a template literal.
        fs.writeFileSync(
            file,
            `export const NODE_RELEASE_KEYS = [\n    { fingerprint: '${'A'.repeat(40)}', armored: "x" },\n];\n`,
        );
        const exit = exitThrows();
        vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(() => previousArmored(file)).toThrow('exit 1');
        expect(exit).toHaveBeenCalledWith(1);
    });

    it('stops when the module has no keys it can find at all', () => {
        const file = path.join(tmp(), 'pinned.ts');
        fs.writeFileSync(file, 'export const NODE_RELEASE_KEYS = [];\n');
        exitThrows();
        vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(() => previousArmored(file)).toThrow('exit 1');
    });
});
