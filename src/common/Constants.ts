// src/common/Constants.ts
export const SERVER_PACKAGE = 'com.genymobile.scrcpy.Server';
export const SERVER_VERSION = '4.1';

/**
 * SHA-256 of the vendored `assets/scrcpy-server` JAR, keyed by the version it
 * ships. `SERVER_VERSION` MUST have an entry here and the entry MUST match the
 * JAR actually on disk — both enforced by
 * `src/common/__tests__/scrcpyServerAsset.test.ts`.
 *
 * Bumping scrcpy-server means three edits together: replace
 * `assets/scrcpy-server`, bump `SERVER_VERSION`, add the new hash here. Miss
 * any one and the test fails. This exists because the v4.0 wire-protocol port
 * (179159b) moved the parser to v4 while the JAR and the constant stayed at
 * 3.3.4, and nothing caught it for three months.
 */
export const SERVER_JAR_SHA256: Record<string, string> = {
    '4.1': 'deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae',
};
export const SERVER_PROCESS_NAME = 'app_process';
export const DEVICE_SERVER_PATH = '/data/local/tmp/scrcpy-server.jar';

// Sentinel passed to the device-side scrcpy server's `remote=tcp:<port>` adb-forward
// argument. `0` means "let the server pick a port"; the actual port is reported back
// over the control socket. Used by DeviceTracker + StreamClientScrcpy.
export const SERVER_PORT = 0;
