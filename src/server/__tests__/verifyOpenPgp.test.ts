import * as fs from 'fs';
import * as openpgp from 'openpgp';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { PINNED_RELEASE_KEYS } from '../DependencyManager';
import { NODE_RELEASE_KEYS, SCRCPY_RELEASE_KEYS } from '../release-keys/pinnedReleaseKeys';
import { type ReleaseKeySet, ReleaseSignatureError, verifyDetachedSignature } from '../verifyOpenPgp';
import {
    type HandBuiltSignerOptions,
    makeHandBuiltSigner,
    makeTestSigner,
    type SelfSignatureSpec,
    signPacketUnchecked,
} from './helpers/releaseSigning';

/** Escape every regex metacharacter, so text becomes a literal pattern. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

/**
 * A copy of a v4 binary signature that names NO issuer: the hashed issuer key
 * ID subpacket (type 16) zeroed to the wildcard, and the issuer fingerprint
 * subpacket (type 33), from which openpgp would otherwise derive the key ID,
 * retyped to an ignored private-use subpacket (100). The hashed area changes,
 * so it no longer verifies -- the point is what it is refused AS.
 */
function withWildcardIssuer(sig: Uint8Array): Uint8Array {
    const out = new Uint8Array(sig);
    // New-format packet header with a one-octet length, then version 4.
    expect([out[0], out[2]]).toEqual([0xc2, 4]);
    const start = 8; // version, type, public-key algo, hash algo, 2-octet hashed length
    const end = start + ((out[6]! << 8) | out[7]!);
    let found = 0;
    for (let i = start; i < end; ) {
        const len = out[i]!;
        expect(len).toBeLessThan(192); // one-octet subpacket lengths only
        const type = out[i + 1]! & 0x7f;
        if (type === 16) {
            out.fill(0, i + 2, i + 1 + len);
            found++;
        } else if (type === 33) {
            out[i + 1] = 100;
            found++;
        }
        i += 1 + len;
    }
    expect(found).toBe(2);
    return out;
}

/**
 * A key whose signing SUBKEY has had its binding signature stripped: the
 * pinned public key still lists the subkey, but nothing binds it to the primary.
 */
async function makeUnboundSubkeySigner(): Promise<{
    keySet: ReleaseKeySet;
    subkeyFingerprint: string;
    sign: (data: string) => Promise<Uint8Array>;
}> {
    const { privateKey } = await openpgp.generateKey({
        type: 'ecc',
        curve: 'ed25519Legacy',
        userIDs: [{ name: 'unbound subkey signer' }],
        subkeys: [{ sign: true }],
        date: new Date(Date.now() - 24 * 3600 * 1000),
        format: 'object',
    });
    const subkey = privateKey.subkeys[0]!;
    const stripped = new openpgp.PacketList<openpgp.AnyPacket>();
    let inSubkey = false;
    for (const packet of privateKey.toPublic().toPacketList()) {
        if (packet instanceof openpgp.PublicSubkeyPacket) inSubkey = true;
        if (inSubkey && packet instanceof openpgp.SignaturePacket) continue;
        stripped.push(packet);
    }
    const pinned = await openpgp.readKey({ binaryKey: stripped.write() });
    expect(pinned.subkeys).toHaveLength(1);
    expect(pinned.subkeys[0]!.bindingSignatures).toHaveLength(0);
    const fingerprint = pinned.getFingerprint().toUpperCase();
    return {
        keySet: { label: 'Node.js', keys: [{ fingerprint, owner: 'unbound subkey signer', armored: pinned.armor() }] },
        subkeyFingerprint: subkey.getFingerprint().toUpperCase(),
        sign: async (data) =>
            openpgp.sign({
                message: await openpgp.createMessage({ binary: enc(data) }),
                signingKeys: privateKey,
                signingKeyIDs: [subkey.getKeyID()],
                detached: true,
                format: 'binary',
            }),
    };
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
            `${what} names ${stranger.fingerprint} as its claimed issuer, which is not a pinned Node.js release key -- refusing to install`,
        );
    });

    it('refuses a signature with the wildcard key ID as unknown-key, not as a bad signature by the first pinned key', async () => {
        const pinned = await makeTestSigner('Node.js');
        const stranger = await makeTestSigner('Node.js');
        const signature = withWildcardIssuer(await stranger.sign(LIST));
        // The premise: the packet now names no issuer at all.
        const packet = (await openpgp.readSignature({ binarySignature: signature })).packets[0]!;
        expect(packet.issuerKeyID.toHex()).toBe('0000000000000000');
        expect(packet.issuerFingerprint).toBeNull();

        const err = await refusal(verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: pinned.keySet }));

        expect(err.reason).toBe('unknown-key');
        expect(err.message).toBe(
            `${what} names no issuer key (wildcard key ID), so no pinned Node.js release key can be matched to it -- refusing to install`,
        );
    });

    it('refuses an empty signature file', async () => {
        const signer = await makeTestSigner('Node.js');

        const err = await refusal(
            verifyDetachedSignature({ what, data: enc(LIST), signature: new Uint8Array(0), keySet: signer.keySet }),
        );

        expect(err.reason).toBe('bad-signature');
        expect(err.message).toContain('unreadable');
    });

    it('refuses a file holding a packet that is not a signature, even beside a good one', async () => {
        // A signature packet of an unsupported version is kept by openpgp as an
        // unparsed packet, which its verify() skips: without the guard the
        // good signature beside it would carry the file.
        const signer = await makeTestSigner('Node.js');
        const good = await signer.sign(LIST);
        const unparsed = new Uint8Array(good);
        unparsed[2] = 7;
        const parsed = await openpgp.readSignature({ binarySignature: new Uint8Array([...good, ...unparsed]) });
        expect(parsed.packets.map((p) => p instanceof openpgp.SignaturePacket)).toEqual([true, false]);

        for (const signature of [new Uint8Array([...good, ...unparsed]), unparsed]) {
            const err = await refusal(
                verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: signer.keySet }),
            );
            expect(err.reason).toBe('bad-signature');
            expect(err.message).toBe(
                `${what}: signature does not verify (a packet that is not a signature) -- refusing to install`,
            );
        }
    });

    it('refuses a file that parses but holds no packet at all', async () => {
        // A lone marker packet (tag 10, "PGP"), which openpgp reads and drops.
        const signer = await makeTestSigner('Node.js');
        const marker = new Uint8Array([0xca, 0x03, 0x50, 0x47, 0x50]);
        expect((await openpgp.readSignature({ binarySignature: marker })).packets).toHaveLength(0);

        const err = await refusal(
            verifyDetachedSignature({ what, data: enc(LIST), signature: marker, keySet: signer.keySet }),
        );

        expect(err.reason).toBe('bad-signature');
        expect(err.message).toBe(`${what}: signature does not verify (no signature packet) -- refusing to install`);
    });

    it('refuses a signature by a signing subkey that has no valid binding signature', async () => {
        const { keySet, sign, subkeyFingerprint } = await makeUnboundSubkeySigner();
        const signature = await sign(LIST);

        const err = await refusal(verifyDetachedSignature({ what, data: enc(LIST), signature, keySet }));

        expect(err.reason).toBe('key-not-valid');
        expect(err.message).toContain('subkey binding signature');
        expect(subkeyFingerprint).not.toBe(keySet.keys[0]!.fingerprint);
    });

    it('refuses a signature dated before its key was created', async () => {
        const created = new Date('2020-01-01T00:00:00Z');
        const signer = await makeTestSigner('Node.js', { created });
        const signature = await signer.sign(LIST, { date: new Date('2019-06-01T00:00:00Z'), unchecked: true });

        const err = await refusal(verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: signer.keySet }));

        expect(err.reason).toBe('key-not-valid');
        expect(err.message).toMatch(/was signed on 2019-06-01T00:00:00\.000Z by .*, a key that was not valid then/);
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
                `^${escapeRegExp(what)} was signed on 2020-03-01T00:00:00\\.000Z by ${signer.fingerprint} ` +
                    '\\(Node\\.js test signer\\), a key that was not valid then \\(.+\\) -- refusing to install$',
            ),
        );
    });

    it('refuses a signature made while the key was expired, though the key was renewed since', async () => {
        // The pinned key keeps BOTH self-signatures: the first, which let the
        // key expire after 30 days, and the renewal a month after the signing.
        const created = new Date('2020-01-01T00:00:00Z');
        const signer = await makeTestSigner('Node.js', {
            created,
            expiresAfterSeconds: 30 * 24 * 3600,
            renewedAt: new Date('2020-04-01T00:00:00Z'),
            keepOriginalSelfSignature: true,
        });
        const signature = await signer.sign(LIST, { date: new Date('2020-03-01T00:00:00Z') });

        const err = await refusal(verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: signer.keySet }));

        expect(err.reason).toBe('key-not-valid');
        expect(err.message).toContain('a key that was not valid then (the key had expired by then)');
    });
});

describe('verifyDetachedSignature under the key-renewal policy', () => {
    const KEY_CREATED = new Date('2020-01-01T00:00:00Z');
    const SIGNED = new Date('2020-02-01T00:00:00Z');
    const RENEWED = new Date('2020-03-01T00:00:00Z');

    /** The premise of each case: openpgp's own check, at the signing time, refuses it. */
    async function expectOpenPgpRefuses(signature: Uint8Array, keySet: ReleaseKeySet): Promise<string> {
        const result = await openpgp.verify({
            message: await openpgp.createMessage({ binary: enc(LIST) }),
            signature: await openpgp.readSignature({ binarySignature: signature }),
            verificationKeys: await openpgp.readKey({ armoredKey: keySet.keys[0]!.armored }),
            format: 'binary',
        });
        const err = await result.signatures[0]!.verified.then(
            () => null,
            (e: Error) => e,
        );
        expect(err).not.toBeNull();
        return err!.message;
    }

    it('passes a signature made before the key was re-self-signed, as GnuPG does', async () => {
        const signer = await makeTestSigner('Node.js', { created: KEY_CREATED, renewedAt: RENEWED });
        const signature = await signer.sign(LIST, { date: SIGNED });
        expect(await expectOpenPgpRefuses(signature, signer.keySet)).toContain(
            'Signature creation time is in the future',
        );

        const result = await verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: signer.keySet });

        expect(result.fingerprint).toBe(signer.fingerprint);
        expect(result.created.toISOString()).toBe(SIGNED.toISOString());
    });

    it('passes a signing subkey whose only binding signature was made after the signature', async () => {
        const signer = await makeTestSigner('scrcpy', { created: KEY_CREATED, renewedAt: RENEWED, subkey: true });
        const signature = await signer.sign(LIST, { date: SIGNED });
        expect(await expectOpenPgpRefuses(signature, signer.keySet)).toContain(
            'Signature creation time is in the future',
        );

        const result = await verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: signer.keySet });

        expect(result.fingerprint).toBe(signer.fingerprint);
        expect(result.signingKeyFingerprint).not.toBe(signer.fingerprint);
    });

    it('refuses a renewed key that a hard revocation, made after the signature, revokes', async () => {
        const signer = await makeTestSigner('Node.js', {
            created: KEY_CREATED,
            renewedAt: RENEWED,
            revoked: { date: new Date('2020-04-01T00:00:00Z'), reason: 'compromised' },
        });
        const signature = await signer.sign(LIST, { date: SIGNED });
        await expectOpenPgpRefuses(signature, signer.keySet);

        const err = await refusal(verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: signer.keySet }));

        expect(err.reason).toBe('key-not-valid');
        expect(err.message).toContain('a key that was not valid then (the primary key is revoked)');
    });

    it('refuses a key retired (a soft revocation) before the signature was made', async () => {
        const signer = await makeTestSigner('Node.js', {
            created: KEY_CREATED,
            revoked: { date: new Date('2020-01-15T00:00:00Z'), reason: 'retired' },
        });
        const signature = await signer.sign(LIST, { date: SIGNED });
        await expectOpenPgpRefuses(signature, signer.keySet);

        const err = await refusal(verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: signer.keySet }));

        expect(err.reason).toBe('key-not-valid');
        expect(err.message).toContain('a key that was not valid then (the primary key is revoked)');
    });

    it('passes a renewed key retired only after the signature was made: revocation is judged at the signing time', async () => {
        const signer = await makeTestSigner('Node.js', {
            created: KEY_CREATED,
            renewedAt: RENEWED,
            revoked: { date: new Date('2020-04-01T00:00:00Z'), reason: 'retired' },
        });
        const signature = await signer.sign(LIST, { date: SIGNED });
        await expectOpenPgpRefuses(signature, signer.keySet);

        const result = await verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: signer.keySet });

        expect(result.fingerprint).toBe(signer.fingerprint);
    });

    it('refuses a renewed key whose signing subkey a hard revocation, made after the signature, revokes', async () => {
        const signer = await makeTestSigner('scrcpy', {
            created: KEY_CREATED,
            renewedAt: RENEWED,
            subkey: true,
            revoked: { date: new Date('2020-04-01T00:00:00Z'), reason: 'compromised', target: 'subkey' },
        });
        const signature = await signer.sign(LIST, { date: SIGNED });
        await expectOpenPgpRefuses(signature, signer.keySet);

        const err = await refusal(verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: signer.keySet }));

        expect(err.reason).toBe('key-not-valid');
        expect(err.message).toContain('a key that was not valid then (the signing subkey is revoked)');
    });

    it('refuses a signing subkey that had expired before the signature, though its primary key had not', async () => {
        const { privateKey } = await openpgp.generateKey({
            type: 'ecc',
            curve: 'ed25519Legacy',
            userIDs: [{ name: 'expiring subkey' }],
            subkeys: [{ sign: true, keyExpirationTime: 15 * 24 * 3600 }],
            date: KEY_CREATED,
            format: 'object',
        });
        const pinned = privateKey.toPublic();
        const fingerprint = pinned.getFingerprint().toUpperCase();
        const keySet = { label: 'scrcpy', keys: [{ fingerprint, owner: 'expiring subkey', armored: pinned.armor() }] };
        const signature = await signPacketUnchecked(
            privateKey.subkeys[0]!.keyPacket as openpgp.SecretSubkeyPacket,
            LIST,
            SIGNED,
        );
        await expectOpenPgpRefuses(signature, keySet);

        const err = await refusal(verifyDetachedSignature({ what, data: enc(LIST), signature, keySet }));

        expect(err.reason).toBe('key-not-valid');
        expect(err.message).toContain('a key that was not valid then (the signing subkey had expired by then)');
    });

    it('refuses a primary key whose self-signature does not grant the signing flag', async () => {
        const { privateKey } = await openpgp.generateKey({
            type: 'ecc',
            curve: 'ed25519Legacy',
            userIDs: [{ name: 'certify-only primary' }],
            date: KEY_CREATED,
            format: 'object',
        });
        const user = privateKey.users[0]!;
        const certifyOnly = new openpgp.SignaturePacket();
        certifyOnly.signatureType = openpgp.enums.signature.certGeneric;
        certifyOnly.hashAlgorithm = openpgp.enums.hash.sha512;
        certifyOnly.publicKeyAlgorithm = privateKey.keyPacket.algorithm;
        (certifyOnly as any).keyFlags = [openpgp.enums.keyFlags.certifyKeys];
        // SignaturePacket.sign is not in openpgp's public typings.
        await (certifyOnly as any).sign(
            privateKey.keyPacket,
            { userID: user.userID, key: privateKey.keyPacket },
            KEY_CREATED,
            false,
            openpgp.config,
        );
        const pinnedObject = privateKey.toPublic();
        pinnedObject.users[0]!.selfCertifications = [certifyOnly];
        const pinned = await openpgp.readKey({ armoredKey: pinnedObject.armor() });
        const fingerprint = pinned.getFingerprint().toUpperCase();
        const keySet = { label: 'Node.js', keys: [{ fingerprint, owner: 'certify-only', armored: pinned.armor() }] };
        const signature = await signPacketUnchecked(privateKey.keyPacket as openpgp.SecretKeyPacket, LIST, SIGNED);
        await expectOpenPgpRefuses(signature, keySet);

        const err = await refusal(verifyDetachedSignature({ what, data: enc(LIST), signature, keySet }));

        expect(err.reason).toBe('key-not-valid');
        expect(err.message).toContain('a key that was not valid then (its self-signature does not allow signing)');
    });

    it('refuses a subkey whose binding signature does not grant the signing flag', async () => {
        // An RSA subkey bound for encryption only: RSA can sign, so the packet
        // verifies over the bytes, but the binding never allowed it to.
        const { privateKey } = await openpgp.generateKey({
            type: 'rsa',
            rsaBits: 2048,
            userIDs: [{ name: 'encrypt-only subkey signer' }],
            date: KEY_CREATED,
            format: 'object',
        });
        const subkey = privateKey.subkeys[0]!;
        const pinned = privateKey.toPublic();
        const fingerprint = pinned.getFingerprint().toUpperCase();
        const keySet = { label: 'Node.js', keys: [{ fingerprint, owner: 'encrypt-only', armored: pinned.armor() }] };
        const signature = await signPacketUnchecked(subkey.keyPacket as openpgp.SecretSubkeyPacket, LIST, SIGNED);
        await expectOpenPgpRefuses(signature, keySet);

        const err = await refusal(verifyDetachedSignature({ what, data: enc(LIST), signature, keySet }));

        expect(err.reason).toBe('key-not-valid');
        expect(err.message).toContain(
            'a key that was not valid then (its subkey binding signature does not allow signing)',
        );
    });

    it('refuses a signing subkey whose binding signature carries no back-signature', async () => {
        // The binding grants the signing flag but lacks the subkey's embedded
        // signature over the primary, so nothing shows the subkey agreed to it.
        const { privateKey } = await openpgp.generateKey({
            type: 'ecc',
            curve: 'ed25519Legacy',
            userIDs: [{ name: 'no back-signature' }],
            subkeys: [{ sign: true }],
            date: KEY_CREATED,
            format: 'object',
        });
        const subkey = privateKey.subkeys[0]!;
        const binding = new openpgp.SignaturePacket();
        binding.signatureType = openpgp.enums.signature.subkeyBinding;
        binding.hashAlgorithm = openpgp.enums.hash.sha512;
        binding.publicKeyAlgorithm = privateKey.keyPacket.algorithm;
        (binding as any).keyFlags = [openpgp.enums.keyFlags.signData];
        // SignaturePacket.sign is not in openpgp's public typings.
        await (binding as any).sign(
            privateKey.keyPacket,
            { key: privateKey.keyPacket, bind: subkey.keyPacket },
            KEY_CREATED,
            false,
            openpgp.config,
        );
        const pinnedObject = privateKey.toPublic();
        pinnedObject.subkeys[0]!.bindingSignatures = [binding];
        const pinned = await openpgp.readKey({ armoredKey: pinnedObject.armor() });
        expect(pinned.subkeys[0]!.bindingSignatures[0]!.embeddedSignature).toBeNull();
        const fingerprint = pinned.getFingerprint().toUpperCase();
        const keySet = { label: 'Node.js', keys: [{ fingerprint, owner: 'no back-sig', armored: pinned.armor() }] };
        const signature = await signPacketUnchecked(subkey.keyPacket as openpgp.SecretSubkeyPacket, LIST, SIGNED);
        expect(await expectOpenPgpRefuses(signature, keySet)).toContain('Missing embedded signature');

        const err = await refusal(verifyDetachedSignature({ what, data: enc(LIST), signature, keySet }));

        expect(err.reason).toBe('key-not-valid');
        expect(err.message).toContain(
            'a key that was not valid then (its subkey binding signature has no valid back-signature)',
        );
    });

    it("refuses a key openpgp's requirements call too weak (1024-bit RSA)", async () => {
        const weak = { ...openpgp.config, minRSABits: 1024 };
        const { privateKey } = await openpgp.generateKey({
            type: 'rsa',
            rsaBits: 1024,
            userIDs: [{ name: 'weak signer' }],
            date: KEY_CREATED,
            format: 'object',
            config: weak,
        });
        const pinned = privateKey.toPublic();
        const fingerprint = pinned.getFingerprint().toUpperCase();
        const keySet = { label: 'Node.js', keys: [{ fingerprint, owner: 'weak', armored: pinned.armor() }] };
        const signature = await signPacketUnchecked(privateKey.keyPacket as openpgp.SecretKeyPacket, LIST, SIGNED);
        await expectOpenPgpRefuses(signature, keySet);

        const err = await refusal(verifyDetachedSignature({ what, data: enc(LIST), signature, keySet }));

        expect(err.reason).toBe('key-not-valid');
        expect(err.message).toContain('RSA keys shorter than 2047 bits are considered too weak');
    });

    const DAY = 24 * 3600;
    const LATER = new Date('2020-04-01T00:00:00Z');
    const { certifyKeys, encryptCommunication } = openpgp.enums.keyFlags;

    /** Verifies LIST signed at SIGNED by a hand-built key; null when it passes, else the refusal. */
    async function verdict(opts: HandBuiltSignerOptions): Promise<ReleaseSignatureError | null> {
        const signer = await makeHandBuiltSigner('Node.js', opts);
        const signature = await signer.sign(LIST, SIGNED);
        return verifyDetachedSignature({ what, data: enc(LIST), signature, keySet: signer.keySet }).then(
            (result) => {
                expect(result.fingerprint).toBe(signer.fingerprint);
                return null;
            },
            (e: unknown) => {
                expect(e).toBeInstanceOf(ReleaseSignatureError);
                return e as ReleaseSignatureError;
            },
        );
    }
    const why = (err: ReleaseSignatureError | null) =>
        err
            ? `${err.reason}: ${/a key that was not valid then \((.+)\) -- /.exec(err.message)?.[1] ?? err.message}`
            : 'passed';

    describe('a self-signature made by the signing time decides, even when it had expired and a renewal followed', () => {
        // The adversarial review's probe: openpgp counts a self-signature's (or
        // binding's) OWN expiry as the key's, so a key whose only self-signature
        // made by then had lapsed was not valid then, renewal or not.
        it('refuses a primary key whose self-signature had expired by the signing time, renewed after it', async () => {
            const err = await verdict({
                created: KEY_CREATED,
                selfSignatures: [{ date: KEY_CREATED, signatureExpiresAfterSeconds: 15 * DAY }, { date: RENEWED }],
            });
            expect(why(err)).toBe('key-not-valid: its self-signature had expired by then, or its user ID was revoked');
        });

        it('refuses a signing subkey whose binding had expired by the signing time, re-bound after it', async () => {
            const err = await verdict({
                created: KEY_CREATED,
                selfSignatures: [{ date: KEY_CREATED }],
                subkey: {
                    bindings: [{ date: KEY_CREATED, signatureExpiresAfterSeconds: 15 * DAY }, { date: RENEWED }],
                },
            });
            expect(why(err)).toBe('key-not-valid: its subkey binding signature had expired by then');
        });

        it('counts only a self-signature or binding that verifies: a damaged one made by then is ignored', async () => {
            const results = await Promise.all([
                verdict({
                    created: KEY_CREATED,
                    selfSignatures: [{ date: KEY_CREATED, corrupt: true }, { date: RENEWED }],
                }),
                verdict({
                    created: KEY_CREATED,
                    selfSignatures: [{ date: KEY_CREATED }],
                    subkey: { bindings: [{ date: KEY_CREATED, corrupt: true }, { date: RENEWED }] },
                }),
            ]);
            expect(results.map(why)).toEqual(['passed', 'passed']);
        });

        it('controls: the same keys with a KEY expiry are refused, and with a self-signature still valid then pass', async () => {
            const results = await Promise.all([
                verdict({
                    created: KEY_CREATED,
                    selfSignatures: [{ date: KEY_CREATED, keyExpiresAfterSeconds: 15 * DAY }, { date: RENEWED }],
                }),
                verdict({
                    created: KEY_CREATED,
                    selfSignatures: [{ date: KEY_CREATED }],
                    subkey: { bindings: [{ date: KEY_CREATED, keyExpiresAfterSeconds: 15 * DAY }, { date: RENEWED }] },
                }),
                verdict({
                    created: KEY_CREATED,
                    selfSignatures: [{ date: KEY_CREATED, signatureExpiresAfterSeconds: 60 * DAY }, { date: RENEWED }],
                }),
                verdict({
                    created: KEY_CREATED,
                    selfSignatures: [{ date: KEY_CREATED }],
                    subkey: {
                        bindings: [{ date: KEY_CREATED, signatureExpiresAfterSeconds: 60 * DAY }, { date: RENEWED }],
                    },
                }),
            ]);
            expect(results.map(why)).toEqual([
                'key-not-valid: the key had expired by then',
                'key-not-valid: the signing subkey had expired by then',
                'passed',
                'passed',
            ]);
        });
    });

    it('refuses a signing subkey created after the signature, though its primary key is older', async () => {
        const subkeyCreated = new Date('2020-02-15T00:00:00Z');
        const results = await Promise.all([
            verdict({
                created: KEY_CREATED,
                selfSignatures: [{ date: KEY_CREATED }],
                subkey: { created: subkeyCreated, bindings: [{ date: subkeyCreated }] },
            }),
            // Control: the same binding, after the signature, of a subkey that already existed.
            verdict({
                created: KEY_CREATED,
                selfSignatures: [{ date: KEY_CREATED }],
                subkey: { bindings: [{ date: subkeyCreated }] },
            }),
        ]);
        expect(results.map(why)).toEqual(['key-not-valid: the key did not exist yet', 'passed']);
    });

    describe('judged from a self-signature made only AFTER the signature, every check still applies', () => {
        // Each row: the post-dated self-signatures / bindings that should pass,
        // and the same with the one property the check guards changed.
        const primaryOnly = (spec: Partial<SelfSignatureSpec>) => ({
            created: KEY_CREATED,
            selfSignatures: [{ date: RENEWED, ...spec }],
        });
        const subkeyBound = (spec: Partial<SelfSignatureSpec>): HandBuiltSignerOptions => ({
            created: KEY_CREATED,
            selfSignatures: [{ date: RENEWED }],
            subkey: { bindings: [{ date: RENEWED, ...spec }] },
        });
        const rows: { name: string; good: HandBuiltSignerOptions; bad: HandBuiltSignerOptions; reason: string }[] = [
            {
                name: 'the primary self-signature must grant signing',
                good: primaryOnly({}),
                bad: primaryOnly({ flags: certifyKeys }),
                reason: 'its self-signature does not allow signing',
            },
            {
                name: 'the primary key must not have expired by the signing time',
                good: primaryOnly({ keyExpiresAfterSeconds: 45 * DAY }),
                bad: primaryOnly({ keyExpiresAfterSeconds: 15 * DAY }),
                reason: 'the key had expired by then',
            },
            {
                name: 'the subkey binding must grant signing',
                good: subkeyBound({}),
                bad: subkeyBound({ flags: encryptCommunication }),
                reason: 'its subkey binding signature does not allow signing',
            },
            {
                name: 'the subkey binding must carry a back-signature',
                good: subkeyBound({}),
                bad: subkeyBound({ backSignature: false }),
                reason: 'its subkey binding signature has no valid back-signature',
            },
            {
                name: 'the subkey must not have expired by the signing time',
                good: subkeyBound({ keyExpiresAfterSeconds: 45 * DAY }),
                bad: subkeyBound({ keyExpiresAfterSeconds: 15 * DAY }),
                reason: 'the signing subkey had expired by then',
            },
            {
                name: "the key must meet openpgp's requirements",
                good: primaryOnly({}),
                bad: { ...primaryOnly({}), algorithm: 'rsa1024' },
                reason: 'RSA keys shorter than 2047 bits are considered too weak',
            },
        ];
        for (const { name, good, bad, reason } of rows) {
            it(name, async () => {
                const [passed, refused] = await Promise.all([verdict(good), verdict(bad)]);
                expect([why(passed), why(refused)]).toEqual(['passed', `key-not-valid: ${reason}`]);
            });
        }

        it('of two post-dated self-signatures or bindings that disagree, the NEWEST decides, as in GnuPG', async () => {
            // GnuPG 2.4.9, measured on these shapes: a key whose newer
            // post-dated self-signature (or binding) drops the signing flag is
            // not used to verify (NO_PUBKEY); one whose newer one restores it
            // verifies (GOODSIG).
            const results = await Promise.all([
                verdict({
                    created: KEY_CREATED,
                    selfSignatures: [{ date: RENEWED }, { date: LATER, flags: certifyKeys }],
                }),
                verdict({
                    created: KEY_CREATED,
                    selfSignatures: [{ date: RENEWED, flags: certifyKeys }, { date: LATER }],
                }),
                verdict({
                    created: KEY_CREATED,
                    selfSignatures: [{ date: RENEWED }],
                    subkey: { bindings: [{ date: RENEWED }, { date: LATER, flags: encryptCommunication }] },
                }),
                verdict({
                    created: KEY_CREATED,
                    selfSignatures: [{ date: RENEWED }],
                    subkey: { bindings: [{ date: RENEWED, flags: encryptCommunication }, { date: LATER }] },
                }),
                // The order the packets are listed in is not what decides.
                verdict({
                    created: KEY_CREATED,
                    selfSignatures: [{ date: LATER }, { date: RENEWED, flags: certifyKeys }],
                }),
            ]);
            expect(results.map(why)).toEqual([
                'key-not-valid: its self-signature does not allow signing',
                'passed',
                'key-not-valid: its subkey binding signature does not allow signing',
                'passed',
                'passed',
            ]);
        });
    });

    it('refuses a renewed key whose signature does not verify over these bytes, as a bad signature', async () => {
        const signer = await makeTestSigner('Node.js', { created: KEY_CREATED, renewedAt: RENEWED });
        const signature = await signer.sign(LIST, { date: SIGNED });
        const tampered = enc(LIST);
        tampered[0] = 'c'.charCodeAt(0);

        const err = await refusal(verifyDetachedSignature({ what, data: tampered, signature, keySet: signer.keySet }));

        expect(err.reason).toBe('bad-signature');
    });
});

describe('verifyDetachedSignature pinned-set integrity', () => {
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

    it('pins every key with all the self-signatures and bindings recorded beside it', async () => {
        // The keys are stored verbatim, and the refresh refuses to drop a
        // self-signature: the old ones are what lets a signature made while a
        // key had lapsed be refused. A hand-minimised armored block fails here.
        const counted = await Promise.all(
            [...NODE_RELEASE_KEYS, ...SCRCPY_RELEASE_KEYS].map(async (k) => {
                const key = await openpgp.readKey({ armoredKey: k.armored });
                return {
                    fingerprint: k.fingerprint,
                    selfSignatures: key.users.reduce((n, u) => n + u.selfCertifications.length, 0),
                    subkeyBindings: key.subkeys.reduce((n, s) => n + s.bindingSignatures.length, 0),
                };
            }),
        );
        expect(counted).toEqual(
            [...NODE_RELEASE_KEYS, ...SCRCPY_RELEASE_KEYS].map(({ fingerprint, selfSignatures, subkeyBindings }) => ({
                fingerprint,
                selfSignatures,
                subkeyBindings,
            })),
        );
        // Some keys carry their history: at least one holds several self-signatures.
        expect(Math.max(...counted.map((c) => c.selfSignatures))).toBeGreaterThan(1);
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

    it("verifies a historical release signed by a RETIRED key: v24.2.0 by Antoine du Hamel's old RSA key", async () => {
        const retired = NODE_RELEASE_KEYS.find((k) => k.fingerprint === 'C0D6248439F1D5604AAFFB4021D900FFDB233756');
        expect(retired?.status).toBe('retired');

        const result = await verifyDetachedSignature({
            what: 'Node.js SHASUMS256.txt for v24.2.0',
            data: fixture('node-v24.2.0-SHASUMS256.txt'),
            signature: fixture('node-v24.2.0-SHASUMS256.txt.sig'),
            keySet: PINNED_RELEASE_KEYS.nodejs,
        });

        expect(result.fingerprint).toBe('C0D6248439F1D5604AAFFB4021D900FFDB233756');
        expect(result.created.toISOString()).toBe('2025-06-09T21:48:06.000Z');
    });

    // Two releases signed BEFORE their key's current self-signature was made:
    // openpgp 6 alone refuses both ("Signature creation time is in the
    // future"), GnuPG accepts both, and the key-renewal policy accepts both.
    for (const { version, fingerprint, status, owner, signed } of [
        {
            version: 'v24.9.0',
            fingerprint: '8FCCA13FEF1D0C2E91008E09770F7A9A5AE15600',
            status: 'retired',
            owner: 'Michaël Zasso',
            signed: '2025-09-25T19:48:32.000Z',
        },
        {
            version: 'v24.0.2',
            fingerprint: '890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4',
            status: 'active',
            owner: 'Rafael Gonzaga',
            signed: '2025-05-14T21:11:07.000Z',
        },
    ] as const) {
        it(`verifies ${version}, signed by ${owner}'s ${status} key before its current self-signature`, async () => {
            const pinned = NODE_RELEASE_KEYS.find((k) => k.fingerprint === fingerprint)!;
            expect(pinned.status).toBe(status);
            const data = fixture(`node-${version}-SHASUMS256.txt`);
            const signature = fixture(`node-${version}-SHASUMS256.txt.sig`);
            // The premise: openpgp's own check refuses it.
            const strict = await openpgp.verify({
                message: await openpgp.createMessage({ binary: data }),
                signature: await openpgp.readSignature({ binarySignature: signature }),
                verificationKeys: await openpgp.readKey({ armoredKey: pinned.armored }),
                format: 'binary',
            });
            await expect(strict.signatures[0]!.verified).rejects.toThrow('Signature creation time is in the future');

            const result = await verifyDetachedSignature({
                what: `Node.js SHASUMS256.txt for ${version}`,
                data,
                signature,
                keySet: PINNED_RELEASE_KEYS.nodejs,
            });

            expect(result.fingerprint).toBe(fingerprint);
            expect(result.created.toISOString()).toBe(signed);
        });
    }

    it('still refuses either renewed-key release changed by one byte', async () => {
        for (const version of ['v24.9.0', 'v24.0.2']) {
            const data = fixture(`node-${version}-SHASUMS256.txt`);
            data[10]! ^= 1;
            const err = await refusal(
                verifyDetachedSignature({
                    what: version,
                    data,
                    signature: fixture(`node-${version}-SHASUMS256.txt.sig`),
                    keySet: PINNED_RELEASE_KEYS.nodejs,
                }),
            );
            expect(err.reason, version).toBe('bad-signature');
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
