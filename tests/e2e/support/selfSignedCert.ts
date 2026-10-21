import {
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    type KeyObject,
    randomBytes,
    sign,
    X509Certificate,
} from 'node:crypto';

/**
 * A throwaway self-signed certificate and key, generated in-process, for rows
 * that need an HTTPS listener to EXIST rather than to be trusted. Row 12.6 only
 * needs the listener to try to bind.
 *
 * Why not a fixture file: a committed private key is exactly what secret
 * scanning flags, and it would be the only one in the repo. Why not mkcert: it
 * is fetched on first use from GitHub, and the fast tier must not depend on
 * that. Why not `openssl`: it is not guaranteed on a Windows dev box.
 * `node:crypto` can make the key but has no API to issue a certificate, so the
 * certificate is assembled here as DER: X.509 v1 (no extensions), CN=localhost,
 * P-256, valid from a day ago to a day ahead, signed ecdsa-with-SHA256. TLS
 * loads it as a server certificate; nothing ever verifies it against a CA.
 * For a chain a client does verify, see `caCert` and `issuedCert` below.
 */
export interface SelfSignedPair {
    cert: string;
    key: string;
}

function derLength(n: number): Buffer {
    if (n < 0x80) return Buffer.from([n]);
    const bytes: number[] = [];
    for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, body: Buffer): Buffer {
    return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));

function oid(dotted: string): Buffer {
    const [a, b, ...rest] = dotted.split('.').map(Number) as [number, number, ...number[]];
    const out = [40 * a + b];
    for (const part of rest) {
        const chunk = [part & 0x7f];
        for (let v = part >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
        out.push(...chunk);
    }
    return tlv(0x06, Buffer.from(out));
}

/** UTCTime, YYMMDDHHMMSSZ. Valid for 1950-2049, which is all this needs. */
function utcTime(d: Date): Buffer {
    const p = (n: number) => String(n).padStart(2, '0');
    const s =
        p(d.getUTCFullYear() % 100) +
        p(d.getUTCMonth() + 1) +
        p(d.getUTCDate()) +
        p(d.getUTCHours()) +
        p(d.getUTCMinutes()) +
        p(d.getUTCSeconds()) +
        'Z';
    return tlv(0x17, Buffer.from(s, 'ascii'));
}

function positiveInteger(bytes: Buffer): Buffer {
    // DER INTEGER is signed: a leading byte with the high bit set needs a 0x00 pad.
    return tlv(0x02, (bytes[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

/**
 * Eight random serial bytes that `positiveInteger` encodes as valid DER: the
 * first byte is never 0x00 (a 0x00 ahead of a byte below 0x80 is padding DER
 * forbids, and OpenSSL refuses the certificate) and never has the high bit set.
 */
function randomSerial(): Buffer {
    const serial = randomBytes(8);
    serial[0] = (serial[0]! & 0x7f) | 0x01;
    return serial;
}

function toPem(label: string, der: Buffer): string {
    const b64 = der.toString('base64').replace(/.{1,64}/g, '$&\n');
    return `-----BEGIN ${label}-----\n${b64}-----END ${label}-----\n`;
}

const nameOf = (commonName: string): Buffer =>
    seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));

/** One v3 extension: its OID, whether it is critical, and its DER value. */
function extension(id: string, critical: boolean, value: Buffer): Buffer {
    return seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
}

function buildCert(opts: {
    subject: string;
    issuer: string;
    publicKey: KeyObject;
    signingKey: KeyObject;
    serial: Buffer;
    /** Present: an X.509 v3 certificate carrying them. Absent: v1, as `selfSignedCert` always made. */
    extensions?: Buffer[];
}): string {
    const ecdsaWithSha256 = seq(oid('1.2.840.10045.4.3.2'));
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const v3 = opts.extensions !== undefined;
    const tbs = seq(
        ...(v3 ? [tlv(0xa0, tlv(0x02, Buffer.from([2])))] : []), // [0] version v3
        positiveInteger(opts.serial),
        ecdsaWithSha256,
        nameOf(opts.issuer),
        seq(utcTime(new Date(now - day)), utcTime(new Date(now + day))),
        nameOf(opts.subject),
        opts.publicKey.export({ type: 'spki', format: 'der' }),
        ...(v3 ? [tlv(0xa3, seq(...(opts.extensions ?? [])))] : []), // [3] extensions
    );
    // ECDSA signatures come back DER-encoded by default, which is what X.509 wants.
    const signature = sign('sha256', tbs, opts.signingKey);
    const der = seq(tbs, ecdsaWithSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
    return toPem('CERTIFICATE', der);
}

const pkcs8 = (key: KeyObject): string => key.export({ type: 'pkcs8', format: 'pem' }).toString();

export function selfSignedCert(commonName = 'localhost'): SelfSignedPair {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const cert = buildCert({
        subject: commonName,
        issuer: commonName,
        publicKey,
        signingKey: privateKey,
        serial: Buffer.from([0x01, 0x2c]),
    });

    // Fail HERE, naming the helper, rather than as an unexplained TLS error in
    // the server's log three steps later.
    const parsed = new X509Certificate(cert);
    if (!parsed.checkPrivateKey(privateKey) || !parsed.verify(publicKey)) {
        throw new Error('selfSignedCert: generated certificate does not match its own key');
    }
    return { cert, key: pkcs8(privateKey) };
}

/**
 * A chain a TLS client can VERIFY, for the rows whose subject is trust itself
 * (21.2: the handshake succeeds with the CA and fails without it). What mkcert
 * makes, minus the name constraints: a v3 root (basicConstraints CA, keyCertSign)
 * and a v3 leaf it signed, whose subjectAltName holds IPv4 addresses, first
 * one first, as CertService reads the subject back (`parseLeafSubject`).
 */
export interface CaPair extends SelfSignedPair {
    commonName: string;
}

export function caCert(commonName = 'ws-scrcpy-web e2e CA'): CaPair {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const cert = buildCert({
        subject: commonName,
        issuer: commonName,
        publicKey,
        signingKey: privateKey,
        serial: randomSerial(),
        extensions: [
            extension('2.5.29.19', true, seq(tlv(0x01, Buffer.from([0xff])))), // basicConstraints: CA
            extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x01, 0x06]))), // keyUsage: keyCertSign, cRLSign
        ],
    });
    const parsed = new X509Certificate(cert);
    if (!parsed.ca || !parsed.verify(publicKey)) throw new Error('caCert: generated CA is not a self-signed CA');
    return { cert, key: pkcs8(privateKey), commonName };
}

export function issuedCert(ca: CaPair, ips: string[]): SelfSignedPair {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ipNames = ips.map((ip) => {
        const octets = ip.split('.').map(Number);
        if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
            throw new Error(`issuedCert: "${ip}" is not an IPv4 address`);
        }
        return tlv(0x87, Buffer.from(octets)); // GeneralName iPAddress [7]
    });
    const cert = buildCert({
        subject: ips[0] ?? 'localhost',
        issuer: ca.commonName,
        publicKey,
        signingKey: createPrivateKey(ca.key),
        serial: randomSerial(),
        extensions: [
            extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))), // keyUsage: digitalSignature
            extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
            extension('2.5.29.17', false, seq(...ipNames)), // subjectAltName
        ],
    });
    const parsed = new X509Certificate(cert);
    if (!parsed.checkPrivateKey(privateKey) || !parsed.checkIssued(new X509Certificate(ca.cert))) {
        throw new Error('issuedCert: generated leaf does not match its key or its CA');
    }
    if (!parsed.verify(createPublicKey(ca.key))) throw new Error('issuedCert: the CA did not sign the leaf');
    return { cert, key: pkcs8(privateKey) };
}
