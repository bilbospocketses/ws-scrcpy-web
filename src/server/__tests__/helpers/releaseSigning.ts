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

/** A v4 binary-document signature packet made by the primary key at `date`, with no validity check. */
async function signUnchecked(privateKey: openpgp.PrivateKey, data: Uint8Array, date: Date): Promise<Uint8Array> {
    const packet = new openpgp.SignaturePacket();
    packet.signatureType = openpgp.enums.signature.binary;
    packet.hashAlgorithm = openpgp.enums.hash.sha512;
    packet.publicKeyAlgorithm = privateKey.keyPacket.algorithm;
    const literal = new openpgp.LiteralDataPacket();
    // Neither LiteralDataPacket.setBytes nor SignaturePacket.sign is in openpgp's public typings.
    (literal as any).setBytes(data, openpgp.enums.literal.binary);
    await (packet as any).sign(privateKey.keyPacket, literal, date, true, openpgp.config);
    const list = new openpgp.PacketList<openpgp.SignaturePacket>();
    list.push(packet);
    return list.write();
}

async function signWith(
    privateKey: openpgp.PrivateKey,
    data: string | Uint8Array,
    opts: SignOptions = {},
): Promise<Uint8Array> {
    const date = opts.date ?? new Date();
    if (opts.unchecked) return signUnchecked(privateKey, bytes(data), date);
    const message = await openpgp.createMessage({ binary: bytes(data) });
    if (opts.armored) {
        const armored = await openpgp.sign({
            message,
            signingKeys: privateKey,
            detached: true,
            format: 'armored',
            date,
        });
        return new TextEncoder().encode(armored);
    }
    return openpgp.sign({ message, signingKeys: privateKey, detached: true, format: 'binary', date });
}

/**
 * A fresh Ed25519 key (the algorithm Node's current releasers use), created
 * `created` (default: a day ago, so a signature dated now is after it).
 *
 * `expiresAfterSeconds` pins the PUBLIC key with that expiry while the signer
 * keeps a non-expiring copy of the same key material, so the test can sign on
 * either side of the pinned key's expiry -- openpgp refuses to sign with a key
 * it knows has expired.
 */
export async function makeTestSigner(
    label: string,
    opts: { created?: Date; expiresAfterSeconds?: number; name?: string } = {},
): Promise<TestSigner> {
    const created = opts.created ?? new Date(Date.now() - 24 * 3600 * 1000);
    const userIDs = [{ name: opts.name ?? `${label} test signer`, email: 'test@example.invalid' }];
    const { privateKey } = await openpgp.generateKey({
        type: 'ecc',
        curve: 'ed25519Legacy',
        userIDs,
        date: created,
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
    const fingerprint = pinned.getFingerprint().toUpperCase();
    return {
        fingerprint,
        keySet: { label, keys: [{ fingerprint, owner: userIDs[0]!.name, armored: pinned.armor() }] },
        sign: (data, signOpts) => signWith(privateKey, data, signOpts),
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
