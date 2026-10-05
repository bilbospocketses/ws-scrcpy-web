import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type PrivateServerPaths, privateServerPaths } from './privateServer';
import { type SelfSignedPair, selfSignedCert } from './selfSignedCert';

/**
 * Local HTTPS state on disk for a private server: where its TLS home is, and
 * the certificates and failing mkcert a row puts there before the server reads
 * them.
 *
 * Nothing here runs mkcert, downloads it, or installs anything into a trust
 * store. The certificates come from selfSignedCert.ts: `readCertMaterial` only
 * needs a cert and key that load and match, not a trusted chain.
 *
 * The TLS home is per platform, mirroring `resolveCertPaths` in
 * src/server/tls/certPaths.ts (copied, not imported, to keep server modules out
 * of the test process): `<LOCALAPPDATA>\WsScrcpyWeb-tls` on Windows, which
 * `spawnServer` points inside the private root, and `<dataRoot>/tls` elsewhere.
 */

export interface TlsServerPaths extends PrivateServerPaths {
    /** Where the server's CertService looks: certPaths.ts's resolveCertPaths, per platform. */
    tlsHome: string;
    certFile: string;
    keyFile: string;
    caRoot: string;
    caPemFile: string;
    /** `<deps>/mkcert/<exe>`: createCertService.ts's resolveMkcertExe. */
    mkcertExe: string;
}

function withTlsHome(base: PrivateServerPaths): TlsServerPaths {
    const tlsHome =
        process.platform === 'win32'
            ? path.join(base.localAppData, 'WsScrcpyWeb-tls')
            : path.join(base.dataRoot, 'tls');
    const caRoot = path.join(tlsHome, 'ca');
    return {
        ...base,
        tlsHome,
        certFile: path.join(tlsHome, 'cert.pem'),
        keyFile: path.join(tlsHome, 'key.pem'),
        caRoot,
        caPemFile: path.join(caRoot, 'rootCA.pem'),
        mkcertExe: path.join(
            base.dataRoot,
            'dependencies',
            'mkcert',
            process.platform === 'win32' ? 'mkcert.exe' : 'mkcert',
        ),
    };
}

/** `privateServerPaths`, plus where that server keeps its TLS material. */
export function tlsServerPaths(name: string, port: number): TlsServerPaths {
    return withTlsHome(privateServerPaths(name, port));
}

/**
 * Put a usable leaf (no CA) where the flat config finds one, so the boot
 * builds a Local HTTPS listener exactly as it would after 21.1's "generate".
 */
export function placeCertificate(paths: PrivateServerPaths): SelfSignedPair {
    const pair = selfSignedCert();
    const { certFile, keyFile } = withTlsHome(paths);
    mkdirSync(path.dirname(certFile), { recursive: true });
    writeFileSync(certFile, pair.cert, 'utf8');
    writeFileSync(keyFile, pair.key, 'utf8');
    return pair;
}

export interface PlantedCert {
    leaf: SelfSignedPair;
    ca: SelfSignedPair;
}

/**
 * Put a leaf (and, unless told not to, a CA root) where CertService reads them,
 * in place of what mkcert would have written. The leaf is valid for one day
 * either side of now, so it is also, by construction, a certificate inside the
 * panel's 30-day expiry window.
 */
export function plantCert(paths: TlsServerPaths, opts: { withCa?: boolean } = {}): PlantedCert {
    const leaf = selfSignedCert();
    const ca = selfSignedCert('ws-scrcpy-web e2e CA');
    mkdirSync(paths.caRoot, { recursive: true });
    writeFileSync(paths.certFile, leaf.cert, 'utf8');
    writeFileSync(paths.keyFile, leaf.key, 'utf8');
    if (opts.withCa !== false) writeFileSync(paths.caPemFile, ca.cert, 'utf8');
    return { leaf, ca };
}

/**
 * An mkcert that fails. A copy of the runner's own node binary named mkcert:
 * the server finds a file at `<deps>/mkcert/<exe>`, so `ensureMkcertInstalled`
 * downloads nothing, and every spawn exits non-zero on mkcert's flags
 * (`node: bad option: -cert-file`) with real stderr behind it. Cross-platform,
 * which a shell script is not, and it cannot mint anything.
 */
export function installFailingMkcert(paths: TlsServerPaths): void {
    mkdirSync(path.dirname(paths.mkcertExe), { recursive: true });
    copyFileSync(process.execPath, paths.mkcertExe);
    if (process.platform !== 'win32') chmodSync(paths.mkcertExe, 0o755);
}
