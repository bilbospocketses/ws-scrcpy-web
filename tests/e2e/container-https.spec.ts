import { expect, test } from '@playwright/test';
import { composeDown, composeRecreateKeepingVolume, composeUpFresh, dockerExecRoot } from './support/dockerStack';

/**
 * Smoke row 20.22 (D8, 2026-09-30): Local HTTPS is not supported in a container,
 * so a certificate that reaches the volume anyway (carried over from a host
 * install, or placed by hand) must not bind an HTTPS listener. The /api/tls
 * writes already refuse there (row 20.18); this is the boot-time half, in
 * `Config.buildServers`.
 *
 * `@docker-host`: the listener set is decided at boot, so the spec writes the
 * certificate into the volume and recreates the container on it. That needs the
 * docker CLI, so it runs on the lifecycle stack (compose.lifecycle.yml, port 8132)
 * in this repo's CI and not under qa-harness's runner.
 *
 * The pair is the unit tests' matched fixture (configHttpsServers.test.ts), whose
 * host-side test proves the same files DO bind a listener outside a container.
 * The container-side control here is the plain-HTTP port answering from the same
 * probe, and the warning in the log, which only appears when the certificate was
 * found at the path the server resolves.
 */

const FILE = 'compose.lifecycle.yml';
const CONTAINER = 'wssw-lifecycle';
const SERVER_LOG = '/data/logs/ws-scrcpy-web.log';

const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVWgAwIBAgIUZyaVyjlE5WplHUXIou7+G/z7LTwwCgYIKoZIzj0EAwIw
LTErMCkGA1UEAwwid3Mtc2NyY3B5LXdlYi10ZXN0LWZpeHR1cmUtbWF0Y2hlZDAe
Fw0yNjA5MTkwODAxNDNaFw0zNjA5MTYwODAxNDNaMC0xKzApBgNVBAMMIndzLXNj
cmNweS13ZWItdGVzdC1maXh0dXJlLW1hdGNoZWQwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARJERUpsodyi0S2zdAYBRxngkS+mMi2EzzFR1TqZFC/64tc83FEZtH1
uoFDQGCRB1NKmaRa5U7dX6Mlv8leRA5mo1MwUTAdBgNVHQ4EFgQU8HzCfuYhTZyd
knkc2gMC/Go5B3wwHwYDVR0jBBgwFoAU8HzCfuYhTZydknkc2gMC/Go5B3wwDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEA03PBA6aweWwPuXi8+Bvc
F9LMnKv989ajzlXcCuV8JqUCIQCslAXIk6F9J+93UKTYmQ61ztgeUv9iZWG9oBMQ
phIFKA==
-----END CERTIFICATE-----
`;
// Test-only, self-signed, and already public in configHttpsServers.test.ts.
const KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgkXTe5ntlD/1orOdu
ltkNicg7eodU8zvM71Kem7jwBtWhRANCAARJERUpsodyi0S2zdAYBRxngkS+mMi2
EzzFR1TqZFC/64tc83FEZtH1uoFDQGCRB1NKmaRa5U7dX6Mlv8leRA5m
-----END PRIVATE KEY-----
`;

/**
 * Connect to each port from inside the container: 'open', or the error code.
 * Inside, because only 8000 is published; 8443 is what the HTTPS listener binds.
 */
function probePorts(): { http: string; https: string } {
    // Double quotes only: the program rides inside a single-quoted `sh -c` word.
    const js =
        'const n=require("net");' +
        'const t=p=>new Promise(r=>{const s=n.connect(p,"127.0.0.1");' +
        's.on("connect",()=>{s.destroy();r("open")});s.on("error",e=>r(e.code))});' +
        'Promise.all([t(8000),t(8443)]).then(v=>console.log(v.join(" ")))';
    const [http, https] = dockerExecRoot(CONTAINER, `node -e '${js}'`).trim().split(' ');
    return { http: http ?? '', https: https ?? '' };
}

test.describe('Local HTTPS in a container (smoke §20.22)', () => {
    test('@docker @docker-host 20.22 a certificate on the volume binds no HTTPS listener, and the log says why', async () => {
        test.setTimeout(600_000);
        composeUpFresh(FILE);
        try {
            // Where Config.buildServers looks on Linux: <dataRoot>/tls/{cert,key}.pem,
            // owned by the app user like everything else on the volume.
            const put = (name: string, pem: string) => `cat > /data/tls/${name} <<'PEM'\n${pem}PEM\n`;
            dockerExecRoot(
                CONTAINER,
                `mkdir -p /data/tls && ${put('cert.pem', CERT_PEM)}${put('key.pem', KEY_PEM)}chown -R 1000:1000 /data/tls`,
            );

            // The listener set is decided at boot.
            composeRecreateKeepingVolume(FILE);

            expect(probePorts(), 'plain HTTP answers; nothing listens on the HTTPS port').toEqual({
                http: 'open',
                https: 'ECONNREFUSED',
            });
            const log = dockerExecRoot(CONTAINER, `cat ${SERVER_LOG}`);
            expect(log).toContain('a Local HTTPS certificate is on the data volume (/data/tls/cert.pem)');
            expect(log).toContain('not supported in a container');
        } finally {
            composeDown(FILE);
        }
    });
});
