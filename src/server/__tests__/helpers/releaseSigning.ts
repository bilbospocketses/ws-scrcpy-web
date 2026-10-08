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

/** One self-signature, or subkey binding signature, of a `makeHandBuiltSigner` key. */
export interface SelfSignatureSpec {
    date: Date;
    /** Key flags. Default: certify + sign for a self-signature, sign for a binding. */
    flags?: number;
    keyExpiresAfterSeconds?: number;
    /** The self-signature's OWN expiry, which openpgp also counts as the key's. */
    signatureExpiresAfterSeconds?: number;
    /** Bindings only: embed the subkey's back-signature. Default true. */
    backSignature?: boolean;
    /** Damage it so it no longer verifies (it still parses, and still names its date). */
    corrupt?: boolean;
}

export interface HandBuiltSignerOptions {
    created: Date;
    /** Default Ed25519 (legacy); `rsa1024` is a key openpgp's requirements call too weak. */
    algorithm?: 'ed25519' | 'rsa1024';
    /** The primary user ID's self-signatures, exactly these, in this order. */
    selfSignatures: readonly SelfSignatureSpec[];
    /** Sign with a subkey created `created` (default: the primary's), bound by exactly these. */
    subkey?: { created?: Date; bindings: readonly SelfSignatureSpec[] };
}

export interface HandBuiltSigner {
    fingerprint: string;
    keySet: ReleaseKeySet;
    /** A binary detached signature at `date`, unchecked (see `signPacketUnchecked`). */
    sign(data: string | Uint8Array, date: Date): Promise<Uint8Array>;
}

async function signSelfSignature(
    type: openpgp.enums.signature,
    signer: openpgp.SecretKeyPacket | openpgp.SecretSubkeyPacket,
    data: object,
    spec: Pick<SelfSignatureSpec, 'date' | 'keyExpiresAfterSeconds' | 'signatureExpiresAfterSeconds' | 'corrupt'> & {
        flags?: number;
        embeddedSignature?: openpgp.SignaturePacket | undefined;
    },
): Promise<openpgp.SignaturePacket> {
    const packet = new openpgp.SignaturePacket();
    packet.signatureType = type;
    packet.hashAlgorithm = openpgp.enums.hash.sha512;
    packet.publicKeyAlgorithm = signer.algorithm;
    if (spec.flags !== undefined) packet.keyFlags = new Uint8Array([spec.flags]);
    if (spec.keyExpiresAfterSeconds !== undefined) {
        packet.keyExpirationTime = spec.keyExpiresAfterSeconds;
        packet.keyNeverExpires = false;
    }
    if (spec.signatureExpiresAfterSeconds !== undefined) {
        packet.signatureExpirationTime = spec.signatureExpiresAfterSeconds;
        packet.signatureNeverExpires = false;
    }
    if (spec.embeddedSignature) packet.embeddedSignature = spec.embeddedSignature;
    // SignaturePacket.sign's typings omit the config argument.
    await (packet as any).sign(signer, data, spec.date, false, openpgp.config);
    // The two digest octets the packet carries no longer match what it signs.
    if (spec.corrupt) packet.signedHashValue![0]! ^= 0xff;
    return packet;
}

/**
 * A key whose self-signatures and subkey bindings are exactly the ones listed,
 * each made at its own date: for judging a key from a self-signature made
 * before, or after, the signature it is asked about.
 */
export async function makeHandBuiltSigner(label: string, opts: HandBuiltSignerOptions): Promise<HandBuiltSigner> {
    const { enums } = openpgp;
    const rsa = opts.algorithm === 'rsa1024';
    const { privateKey } = await openpgp.generateKey({
        ...(rsa ? { type: 'rsa' as const, rsaBits: 1024 } : { type: 'ecc' as const, curve: 'ed25519Legacy' as const }),
        userIDs: [{ name: `${label} hand-built signer` }],
        date: opts.created,
        subkeys: opts.subkey ? [{ sign: true, date: opts.subkey.created ?? opts.created }] : [],
        format: 'object',
        ...(rsa ? { config: { minRSABits: 1024 } } : {}),
    });
    const primary = privateKey.keyPacket as openpgp.SecretKeyPacket;
    const pinnedObject = privateKey.toPublic();
    const user = pinnedObject.users[0]!;
    user.selfCertifications = [];
    for (const spec of opts.selfSignatures) {
        user.selfCertifications.push(
            await signSelfSignature(
                enums.signature.certGeneric,
                primary,
                { userID: user.userID, key: primary },
                { ...spec, flags: spec.flags ?? enums.keyFlags.certifyKeys | enums.keyFlags.signData },
            ),
        );
    }
    let signer: openpgp.SecretKeyPacket | openpgp.SecretSubkeyPacket = primary;
    if (opts.subkey) {
        const sub = privateKey.subkeys[0]!.keyPacket as openpgp.SecretSubkeyPacket;
        const bound = { key: primary, bind: sub };
        pinnedObject.subkeys[0]!.bindingSignatures = [];
        for (const spec of opts.subkey.bindings) {
            const embeddedSignature =
                spec.backSignature === false
                    ? undefined
                    : await signSelfSignature(enums.signature.keyBinding, sub, bound, { date: spec.date });
            pinnedObject.subkeys[0]!.bindingSignatures.push(
                await signSelfSignature(enums.signature.subkeyBinding, primary, bound, {
                    ...spec,
                    flags: spec.flags ?? enums.keyFlags.signData,
                    embeddedSignature,
                }),
            );
        }
        signer = sub;
    }
    // Round-trip, so the pinned key is exactly what its armor parses to.
    const pinned = await openpgp.readKey({ armoredKey: pinnedObject.armor() });
    const fingerprint = pinned.getFingerprint().toUpperCase();
    return {
        fingerprint,
        keySet: { label, keys: [{ fingerprint, owner: user.userID!.name, armored: pinned.armor() }] },
        sign: (data, date) => signPacketUnchecked(signer, data, date),
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
