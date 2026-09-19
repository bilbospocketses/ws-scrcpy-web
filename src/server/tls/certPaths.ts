import path from 'path';

export interface CertPathOpts {
    platform: NodeJS.Platform;
    dataRoot: string;
    localAppData?: string | undefined;
    home?: string | undefined;
}

export interface CertPaths {
    /** CAROOT — holds rootCA.pem and rootCA-key.pem. */
    caRoot: string;
    /** Absolute leaf certificate path passed as -cert-file. */
    certFile: string;
    /** Absolute leaf key path passed as -key-file. */
    keyFile: string;
}

/**
 * Where the CA and the leaf live.
 *
 * The leaf pair goes in the data root on every platform: it must survive an app
 * update, and in a container it must survive `docker rm`, which is what the
 * /data volume is for.
 *
 * CAROOT is the exception on Windows, and it is not a style choice. mkcert
 * writes the CA key `0400`, but Go maps a Unix mode to the read-only ATTRIBUTE
 * on Windows and sets no ACL at all -- measured 2026-09-18, the generated
 * rootCA-key.pem inherited FullControl for the interactive user. The Windows
 * data root is C:\ProgramData\WsScrcpyWeb, whose ACL grants BUILTIN\Users
 * ReadAndExecute by inheritance. Put those two facts together and a CAROOT
 * there is a CA private key readable by every local account -- who could then
 * mint a certificate for any name that every machine trusting this CA accepts.
 * So on Windows the CA goes in a per-user directory whose inherited ACL is
 * already restrictive.
 *
 * On POSIX the mode does what it says, so the data root is fine at 0700.
 */
export function resolveCertPaths(opts: CertPathOpts): CertPaths {
    const pathModule = opts.platform === 'win32' ? path.win32 : path.posix;

    const tlsDir = pathModule.join(opts.dataRoot, 'tls');
    const certFile = pathModule.join(tlsDir, 'cert.pem');
    const keyFile = pathModule.join(tlsDir, 'key.pem');

    if (opts.platform === 'win32') {
        const base = opts.localAppData || (opts.home ? pathModule.join(opts.home, 'AppData', 'Local') : '');
        if (!base) {
            throw new Error('cannot resolve a per-user CAROOT on Windows: neither LOCALAPPDATA nor HOME is set');
        }
        return { caRoot: pathModule.join(base, 'WsScrcpyWeb', 'tls', 'ca'), certFile, keyFile };
    }

    return { caRoot: pathModule.join(tlsDir, 'ca'), certFile, keyFile };
}
