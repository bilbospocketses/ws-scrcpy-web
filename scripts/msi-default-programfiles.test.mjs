import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guards the fix for the drive-root MSI regression. The whole bug was that the
// MSI's install location was documented and assumed but never TESTED: vpk's raw
// `--msi` defaults INSTALLFOLDER to the drive root (C:\ws-scrcpy-web), the
// Program-Files install came from the dropped Setup.exe, and nothing compared the
// two. These are static guards -- they cannot pack a real MSI in CI -- but they
// make the two failure modes that let this slip impossible to reintroduce
// silently: (1) the pipeline patch step being removed or misordered, and (2) the
// patch script losing its self-verification. The runtime guarantee is the
// script's own throw-if-not-Program-Files, which fails the release.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseYml = fs.readFileSync(path.join(REPO, '.github/workflows/release.yml'), 'utf8');
const scriptPath = path.join(REPO, 'scripts/msi-default-programfiles.ps1');
const script = fs.readFileSync(scriptPath, 'utf8');

describe('MSI defaults to C:\\Program Files\\WsScrcpyWeb', () => {
    it('the patch script exists', () => {
        expect(fs.existsSync(scriptPath)).toBe(true);
    });

    it('release.yml runs the patch step and invokes the script', () => {
        expect(releaseYml).toContain('Default MSI install dir to Program Files');
        expect(releaseYml).toMatch(/scripts\/msi-default-programfiles\.ps1/);
    });

    it('the patch runs AFTER vpk pack and BEFORE signing/upload', () => {
        // After pack (there is an MSI to patch); before the sign/upload step so a
        // future signature covers the PATCHED MSI, not the drive-root one.
        const iPack = releaseYml.indexOf('name: vpk pack');
        const iPatch = releaseYml.indexOf('Default MSI install dir to Program Files');
        const iUpload = releaseYml.indexOf('name: Upload unsigned MSI');
        expect(iPack).toBeGreaterThan(-1);
        expect(iUpload).toBeGreaterThan(-1);
        expect(iPatch).toBeGreaterThan(iPack);
        expect(iUpload).toBeGreaterThan(iPatch);
    });

    it('reparents INSTALLFOLDER under ProgramFiles64Folder', () => {
        expect(script).toContain("Directory_Parent='ProgramFiles64Folder'");
        expect(script).toContain('INSERT INTO Directory');
    });

    it('self-verifies and refuses to commit a drive-root MSI (the guard must be loud)', () => {
        expect(script).toMatch(/MSI PATCH FAILED/);
        expect(script).toMatch(/Not committing/);
        // The verify/throw must precede the Commit -- verify-then-commit in one
        // transacted session, so a failed reparent never ships.
        const iThrow = script.indexOf('MSI PATCH FAILED');
        const iCommit = script.lastIndexOf('$db.Commit()');
        expect(iThrow).toBeGreaterThan(-1);
        expect(iCommit).toBeGreaterThan(iThrow);
    });

    it('never inserts the ProgramFiles64Folder row TEMPORARY (Error 2705 trap)', () => {
        // A TEMPORARY row satisfies the existence check but is dropped at Commit,
        // orphaning INSTALLFOLDER's parent -- the install then fails with 2705.
        expect(script).not.toMatch(/INSERT INTO Directory[^\n]*TEMPORARY/i);
    });
});
