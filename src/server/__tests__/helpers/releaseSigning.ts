import * as openpgp from 'openpgp';
import type { DependencyReleaseKeys } from '../../DependencyManager';
import type { ReleaseKeySet } from '../../verifyOpenPgp';

/**
 * M5 test signers. Production accepts only the keys pinned in
 * `release-keys/pinnedReleaseKeys.ts`; tests sign their fixture lists with a
 * throwaway key generated here and hand the matching set to
 * `new DependencyManager(dir, { releaseKeys })`, the constructor seam no user
 * setting reaches.
 */

export interface TestSigner {
    /** The PRIMARY key's fingerprint, upper-case. */
    fingerprint: string;
    /** A one-key set naming `label`, holding this signer's public key. */
    keySet: ReleaseKeySet;
    /**
     * A detached signature over `data`: binary like Node's `.sig`, or armored
     * like scrcpy's `.asc`. `unchecked` signs the packet directly, skipping
     * openpgp's own refusal to sign at a `date` its key was not valid on (for
     * example before the key existed); binary only.
     */
    sign(data: string | Uint8Array, opts?: SignOptions): Promise<Uint8Array>;
}

interface SignOptions {
    armored?: boolean;
    date?: Date;
    unchecked?: boolean;
}

const bytes = (data: string | Uint8Array) => (typeof data === 'string' ? new TextEncoder().encode(data) : data);

/**
 * A v4 binary-document signature packet made by `keyPacket` (a secret primary
 * key or subkey) at `date`, with no validity check at all: not the date, not
 * the key flags, not the key's strength.
 */
export async function signPacketUnchecked(
    keyPacket: openpgp.SecretKeyPacket | openpgp.SecretSubkeyPacket,
    data: string | Uint8Array,
    date: Date,
): Promise<Uint8Array> {
    const packet = new openpgp.SignaturePacket();
    packet.signatureType = openpgp.enums.signature.binary;
    packet.hashAlgorithm = openpgp.enums.hash.sha512;
    packet.publicKeyAlgorithm = keyPacket.algorithm;
    const literal = new openpgp.LiteralDataPacket();
    // Neither LiteralDataPacket.setBytes nor SignaturePacket.sign is in openpgp's public typings.
    (literal as any).setBytes(bytes(data), openpgp.enums.literal.binary);
    await (packet as any).sign(keyPacket, literal, date, true, openpgp.config);
    const list = new openpgp.PacketList<openpgp.SignaturePacket>();
    list.push(packet);
    return list.write();
}

async function signWith(
    privateKey: openpgp.PrivateKey,
    data: string | Uint8Array,
    opts: SignOptions = {},
    signingKeyIDs?: openpgp.KeyID[],
): Promise<Uint8Array> {
    const date = opts.date ?? new Date();
    if (opts.unchecked) {
        return signPacketUnchecked(privateKey.keyPacket as openpgp.SecretKeyPacket, data, date);
    }
    const message = await openpgp.createMessage({ binary: bytes(data) });
    const ids = signingKeyIDs ? { signingKeyIDs } : {};
    if (opts.armored) {
        const armored = await openpgp.sign({
            message,
            signingKeys: privateKey,
            ...ids,
            detached: true,
            format: 'armored',
            date,
        });
        return new TextEncoder().encode(armored);
    }
    return openpgp.sign({ message, signingKeys: privateKey, ...ids, detached: true, format: 'binary', date });
}

export interface TestSignerOptions {
    created?: Date;
    expiresAfterSeconds?: number;
    name?: string;
    /** Sign with a signing SUBKEY, as scrcpy's key does, instead of the primary key. */
    subkey?: boolean;
    /**
     * Re-self-sign the pinned key (and re-bind its subkeys) at this date, never
     * expiring, the way a releaser renews a key. The pinned key then carries
     * ONLY the new self-signatures, as the published Node.js keys do -- unless
     * `keepOriginalSelfSignature`, which keeps the first ones beside them.
     */
    renewedAt?: Date;
    keepOriginalSelfSignature?: boolean;
    /**
     * Add a revocation to the pinned key, of the primary key (`target` `key`,
     * the default) or of its signing subkey: `compromised` is a hard
     * revocation, `retired` a soft one.
     */
    revoked?: { date: Date; reason: 'compromised' | 'retired'; target?: 'key' | 'subkey' };
}

/**
 * A fresh Ed25519 key (the algorithm Node's current releasers use), created
 * `created` (default: a day ago, so a signature dated now is after it).
 *
 * `expiresAfterSeconds` pins the PUBLIC key with that expiry while the signer
 * keeps a non-expiring copy of the same key material, so the test can sign on
 * either side of the pinned key's expiry -- openpgp refuses to sign with a key
 * it knows has expired. Renewal and revocation, likewise, change only the
 * pinned copy: the signer signs as the key stood when it was created.
 */
export async function makeTestSigner(label: string, opts: TestSignerOptions = {}): Promise<TestSigner> {
    const created = opts.created ?? new Date(Date.now() - 24 * 3600 * 1000);
    const userIDs = [{ name: opts.name ?? `${label} test signer`, email: 'test@example.invalid' }];
    const { privateKey } = await openpgp.generateKey({
        type: 'ecc',
        curve: 'ed25519Legacy',
        userIDs,
        date: created,
        ...(opts.subkey ? { subkeys: [{ sign: true }] } : {}),
        format: 'object',
    });
    let pinned: openpgp.PublicKey = privateKey.toPublic();
    if (opts.expiresAfterSeconds !== undefined) {
        const reformatted = await openpgp.reformatKey({
            privateKey,
            userIDs,
            keyExpirationTime: opts.expiresAfterSeconds,
            date: created,
            format: 'object',
        });
        pinned = reformatted.publicKey;
    }
    if (opts.renewedAt) {
        const renewed = (await openpgp.reformatKey({ privateKey, userIDs, date: opts.renewedAt, format: 'object' }))
            .publicKey;
        if (opts.keepOriginalSelfSignature) {
            pinned.users[0]!.selfCertifications.push(...renewed.users[0]!.selfCertifications);
            for (const [i, s] of pinned.subkeys.entries()) {
                s.bindingSignatures.push(...renewed.subkeys[i]!.bindingSignatures);
            }
        } else {
            pinned = renewed;
        }
    }
    if (opts.revoked) {
        const { reasonForRevocation } = openpgp.enums;
        const flag =
            opts.revoked.reason === 'retired' ? reasonForRevocation.keyRetired : reasonForRevocation.keyCompromised;
        if (opts.revoked.target === 'subkey') {
            const revoked = await privateKey.subkeys[0]!.revoke(
                privateKey.keyPacket as openpgp.SecretKeyPacket,
                { flag },
                opts.revoked.date,
            );
            pinned.subkeys[0]!.revocationSignatures.push(...revoked.revocationSignatures);
        } else {
            const revoked = await openpgp.revokeKey({
                key: privateKey,
                reasonForRevocation: { flag },
                date: opts.revoked.date,
                format: 'object',
            });
            pinned.revocationSignatures.push(...revoked.publicKey.revocationSignatures);
        }
    }
    // Round-trip, so the pinned key is exactly what its armor parses to.
    pinned = await openpgp.readKey({ armoredKey: pinned.armor() });
    const fingerprint = pinned.getFingerprint().toUpperCase();
    const signingKeyIDs = opts.subkey ? [privateKey.subkeys[0]!.getKeyID()] : undefined;
    return {
        fingerprint,
        keySet: { label, keys: [{ fingerprint, owner: userIDs[0]!.name, armored: pinned.armor() }] },
        sign: (data, signOpts) => signWith(privateKey, data, signOpts, signingKeyIDs),
    };
}

/** One throwaway signer per publisher, and the `releaseKeys` option that pins them. */
export async function makeTestReleaseKeys(): Promise<{
    releaseKeys: DependencyReleaseKeys;
    node: TestSigner;
    scrcpy: TestSigner;
}> {
    const [node, scrcpy] = await Promise.all([makeTestSigner('Node.js'), makeTestSigner('scrcpy')]);
    return { releaseKeys: { nodejs: node.keySet, scrcpyServer: scrcpy.keySet }, node, scrcpy };
}

/** A Response over raw bytes (a body reads once, so build one per fetch). */
export const bytesResponse = (data: Uint8Array) => new Response(new Uint8Array(data));
