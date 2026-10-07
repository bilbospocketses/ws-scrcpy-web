import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { PINNED_RELEASE_KEYS } from '../DependencyManager';
import { NODE_RELEASE_KEYS, SCRCPY_RELEASE_KEYS } from '../release-keys/pinnedReleaseKeys';
import { ReleaseSignatureError, verifyDetachedSignature } from '../verifyOpenPgp';
import { makeTestSigner } from './helpers/releaseSigning';

/**
 * M5: verifyDetachedSignature over a hash list's exact bytes. The throwaway-key
 * cases pin each refusal; the real-fixture cases run the files nodejs.org and
 * the scrcpy release actually publish through the keys this repo pins.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
const LIST = 'aaaa  node-v24.99.0-linux-x64.tar.gz\nbbbb  node-v24.99.0-win-x64.zip\n';
const enc = (s: string) => new TextEncoder().encode(s);
const what = 'Node.js SHASUMS256.txt for v24.99.0';

async function refusal(promise: Promise<unknown>): Promise<ReleaseSignatureError> {
    const err = await promise.then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReleaseSignatureError);
    return err as ReleaseSignatureError;
}

describe('verifyDetachedSignature with a throwaway key', () => {
    it('passes a binary detached signature by a pinned key and names the signer', async () => {
        const signer = await makeTestSigner('Node.js');
        const signature = await signer.sign(LIST);

        const result = await verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: signer.keySet });

        expect(result.fingerprint).toBe(signer.fingerprint);
        expect(result.owner).toBe('Node.js test signer');
    });

    it('passes an armored detached signature too', async () => {
        const signer = await makeTestSigner('scrcpy');
        const signature = await signer.sign(LIST, { armored: true });

        const result = await verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: signer.keySet });

        expect(result.fingerprint).toBe(signer.fingerprint);
    });

    it('refuses a list changed by one byte after signing', async () => {
        const signer = await makeTestSigner('Node.js');
        const signature = await signer.sign(LIST);
        const tampered = enc(LIST);
        tampered[0] = 'c'.charCodeAt(0);

        const err = await refusal(verifyDetachedSignature({ what, data: tampered, signature, keySet: signer.keySet }));

        expect(err.reason).toBe('bad-signature');
        expect(err.message).toMatch(
            /^Node\.js SHASUMS256\.txt for v24\.99\.0: signature does not verify \(.+\) -- refusing to install$/,
        );
    });

    it('refuses a signature by a key outside the pinned set, naming its fingerprint', async () => {
        const pinned = await makeTestSigner('Node.js');
        const stranger = await makeTestSigner('Node.js');
        const signature = await stranger.sign(LIST);

        const err = await refusal(verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: pinned.keySet }));

        expect(err.reason).toBe('unknown-key');
        expect(err.message).toBe(
            `${what} is signed by ${stranger.fingerprint}, which is not a pinned Node.js release key -- refusing to install`,
        );
    });

    it('refuses a file that is not a signature', async () => {
        const signer = await makeTestSigner('Node.js');

        const err = await refusal(
            verifyDetachedSignature({
                what,
                data: enc(LIST),
                signature: enc('<html>Not Found</html>'),
                keySet: signer.keySet,
            }),
        );

        expect(err.reason).toBe('bad-signature');
        expect(err.message).toContain('unreadable');
    });

    it('refuses when ANY signature in the file is by an unpinned key, even beside a good one', async () => {
        const pinned = await makeTestSigner('Node.js');
        const stranger = await makeTestSigner('Node.js');
        const both = new Uint8Array([...(await pinned.sign(LIST)), ...(await stranger.sign(LIST))]);

        const err = await refusal(
            verifyDetachedSignature({ what, data: enc(LIST), signature: both, keySet: pinned.keySet }),
        );

        expect(err.reason).toBe('unknown-key');
        expect(err.message).toContain(stranger.fingerprint);
    });

    it('refuses when a second signature by the pinned key does not verify over these bytes', async () => {
        const signer = await makeTestSigner('Node.js');
        const both = new Uint8Array([...(await signer.sign(LIST)), ...(await signer.sign(`${LIST}extra\n`))]);

        const err = await refusal(
            verifyDetachedSignature({ what, data: enc(LIST), signature: both, keySet: signer.keySet }),
        );

        expect(err.reason).toBe('bad-signature');
    });

    it('refuses a signature packet that is not a document signature, which openpgp would skip', async () => {
        const signer = await makeTestSigner('Node.js');
        const signature = await signer.sign(LIST);
        // New-format header (2 bytes), version 4, then the signature type:
        // 0x00 (binary document) becomes 0x02 (standalone).
        expect([signature[0], signature[2], signature[3]]).toEqual([0xc2, 4, 0x00]);
        signature[3] = 0x02;

        const err = await refusal(verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: signer.keySet }));

        expect(err.reason).toBe('bad-signature');
        expect(err.message).toContain('a signature packet is not a document signature');
    });

    it('passes a signature made while the key was valid, though the key has expired since', async () => {
        const created = new Date('2020-01-01T00:00:00Z');
        const signer = await makeTestSigner('Node.js', { created, expiresAfterSeconds: 30 * 24 * 3600 });
        const signature = await signer.sign(LIST, { date: new Date('2020-01-10T00:00:00Z') });

        const result = await verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: signer.keySet });

        expect(result.fingerprint).toBe(signer.fingerprint);
        expect(result.created.toISOString()).toBe('2020-01-10T00:00:00.000Z');
    });

    it('refuses a signature made after the key expired', async () => {
        const created = new Date('2020-01-01T00:00:00Z');
        const signer = await makeTestSigner('Node.js', { created, expiresAfterSeconds: 30 * 24 * 3600 });
        const signature = await signer.sign(LIST, { date: new Date('2020-03-01T00:00:00Z') });

        const err = await refusal(verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: signer.keySet }));

        expect(err.reason).toBe('key-not-valid');
        expect(err.message).toMatch(
            new RegExp(
                `^${what.replace(/\./g, '\\.')} was signed on 2020-03-01T00:00:00\\.000Z by ${signer.fingerprint} ` +
                    '\\(Node\\.js test signer\\), a key that was not valid then \\(.+\\) -- refusing to install$',
            ),
        );
    });

    it('refuses a pinned entry whose armored key is not the fingerprint recorded beside it', async () => {
        const a = await makeTestSigner('Node.js');
        const b = await makeTestSigner('Node.js');
        const keySet = { label: 'Node.js', keys: [{ ...a.keySet.keys[0]!, armored: b.keySet.keys[0]!.armored }] };

        await expect(
            verifyDetachedSignature({ what, data: enc(LIST), signature: await b.sign(LIST), keySet }),
        ).rejects.toThrow(
            `pinned Node.js key ${a.fingerprint} parses as ${b.fingerprint} -- the pinned set is corrupt`,
        );
    });
});

describe('verifyDetachedSignature against the real published files and the pinned keys', () => {
    it('pins every Node.js release key, active and retired, and Romain Vimont for scrcpy', () => {
        // nodejs/release-keys README on 2026-10-07: 8 active, 21 retired.
        expect(NODE_RELEASE_KEYS.filter((k) => k.status === 'active')).toHaveLength(8);
        expect(NODE_RELEASE_KEYS.filter((k) => k.status === 'retired')).toHaveLength(21);
        expect(SCRCPY_RELEASE_KEYS.map((k) => k.fingerprint)).toEqual(['456958E85A185DD5C2D1E4E80C822B298461FA03']);
        expect(PINNED_RELEASE_KEYS.nodejs.keys).toBe(NODE_RELEASE_KEYS);
        expect(PINNED_RELEASE_KEYS.scrcpyServer.keys).toBe(SCRCPY_RELEASE_KEYS);
    });

    it("verifies Node v24.21.0's SHASUMS256.txt.sig (Ed25519) by Antoine du Hamel's key", async () => {
        const result = await verifyDetachedSignature({
            what: 'Node.js SHASUMS256.txt for v24.21.0',
            data: fixture('node-v24.21.0-SHASUMS256.txt'),
            signature: fixture('node-v24.21.0-SHASUMS256.txt.sig'),
            keySet: PINNED_RELEASE_KEYS.nodejs,
        });

        expect(result.fingerprint).toBe('5BE8A3F6C8A5C01D106C0AD820B1A390B168D356');
        expect(result.owner).toBe('Antoine du Hamel <duhamelantoine1995@gmail.com>');
    });

    it("verifies scrcpy v4.1's SHA256SUMS.txt.asc by the signing subkey of Romain Vimont's key", async () => {
        const result = await verifyDetachedSignature({
            what: 'scrcpy-server SHA256SUMS.txt for v4.1',
            data: fixture('scrcpy-v4.1-SHA256SUMS.txt'),
            signature: fixture('scrcpy-v4.1-SHA256SUMS.txt.asc'),
            keySet: PINNED_RELEASE_KEYS.scrcpyServer,
        });

        expect(result.fingerprint).toBe('456958E85A185DD5C2D1E4E80C822B298461FA03');
        expect(result.signingKeyFingerprint).toBe('E39E2DE6A55F5AA6D8EFB79ACA01F46F18683B3D');
    });

    it('refuses either real list changed by one byte', async () => {
        for (const [list, sig, keySet] of [
            ['node-v24.21.0-SHASUMS256.txt', 'node-v24.21.0-SHASUMS256.txt.sig', PINNED_RELEASE_KEYS.nodejs],
            ['scrcpy-v4.1-SHA256SUMS.txt', 'scrcpy-v4.1-SHA256SUMS.txt.asc', PINNED_RELEASE_KEYS.scrcpyServer],
        ] as const) {
            const data = fixture(list);
            data[10]! ^= 1;
            const err = await refusal(verifyDetachedSignature({ what: list, data, signature: fixture(sig), keySet }));
            expect(err.reason, list).toBe('bad-signature');
        }
    });

    it("refuses scrcpy's real list against Node's keys: right signature, wrong publisher", async () => {
        const err = await refusal(
            verifyDetachedSignature({
                what: 'scrcpy-server SHA256SUMS.txt for v4.1',
                data: fixture('scrcpy-v4.1-SHA256SUMS.txt'),
                signature: fixture('scrcpy-v4.1-SHA256SUMS.txt.asc'),
                keySet: PINNED_RELEASE_KEYS.nodejs,
            }),
        );

        expect(err.reason).toBe('unknown-key');
        expect(err.message).toContain('E39E2DE6A55F5AA6D8EFB79ACA01F46F18683B3D');
    });
});
