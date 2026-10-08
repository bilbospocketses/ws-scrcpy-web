// src/common/Constants.ts
export const SERVER_PACKAGE = 'com.genymobile.scrcpy.Server';
export const SERVER_VERSION = '5.0';

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
 *
 * Keep the entries for versions earlier builds shipped. Besides pinning an
 * updater download of that version, they are how
 * `DependencyManager.repairScrcpyServerVersionMarker` recognises a jar an
 * earlier build seed-promoted without writing a `.version` marker.
 */
export const SERVER_JAR_SHA256: Record<string, string> = {
    '4.1': 'deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae',
    '5.0': '26cbc9ad0aced6c2282455bef4fb43462605c1f8758c74b4ab1dbf818c229daa',
};
export const SERVER_PROCESS_NAME = 'app_process';
export const DEVICE_SERVER_PATH = '/data/local/tmp/scrcpy-server.jar';
