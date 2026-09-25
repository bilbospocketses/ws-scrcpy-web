import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';

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

function toPem(label: string, der: Buffer): string {
    const b64 = der.toString('base64').replace(/.{1,64}/g, '$&\n');
    return `-----BEGIN ${label}-----\n${b64}-----END ${label}-----\n`;
}

export function selfSignedCert(commonName = 'localhost'): SelfSignedPair {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ecdsaWithSha256 = seq(oid('1.2.840.10045.4.3.2'));
    const name = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const tbs = seq(
        positiveInteger(Buffer.from([0x01, 0x2c])), // serial
        ecdsaWithSha256,
        name, // issuer
        seq(utcTime(new Date(now - day)), utcTime(new Date(now + day))),
        name, // subject
        publicKey.export({ type: 'spki', format: 'der' }),
    );
    // ECDSA signatures come back DER-encoded by default, which is what X.509 wants.
    const signature = sign('sha256', tbs, privateKey);
    const der = seq(tbs, ecdsaWithSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
    const cert = toPem('CERTIFICATE', der);

    // Fail HERE, naming the helper, rather than as an unexplained TLS error in
    // the server's log three steps later.
    const parsed = new X509Certificate(cert);
    if (!parsed.checkPrivateKey(privateKey) || !parsed.verify(publicKey)) {
        throw new Error('selfSignedCert: generated certificate does not match its own key');
    }
    return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}
