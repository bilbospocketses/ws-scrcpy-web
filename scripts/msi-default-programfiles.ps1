<#
.SYNOPSIS
  Make Velopack's MSI install to C:\Program Files\<AppFolder> by default.

.DESCRIPTION
  vpk's `--msi` artifact defaults INSTALLFOLDER to `[TARGETDIR]\<packTitle>` --
  the DRIVE ROOT (C:\ws-scrcpy-web). This is true in EVERY vpk version tested
  (0.0.1589, 1.0.1, 1.1.1, 1.2.0): the Directory table roots the app at
  TARGETDIR, and `--instLocation` only sets per-machine vs per-user SCOPE, never
  the directory. The Program-Files install this project shipped for weeks came
  from the Velopack **Setup.exe** bootstrapper, which resolves ProgramFilesX64 at
  runtime -- and dropping Setup.exe (MSI-only, commit 8827fbf) silently left the
  raw MSI's drive-root default as the shipped behaviour. Nothing tested the real
  install location, so it went unnoticed until qa-harness measured it.

  This reparents INSTALLFOLDER under the standard ProgramFiles64Folder system
  folder, so the shipped MSI installs to C:\Program Files\<AppFolder> by default
  in EVERY mode -- double-click and silent (`/qn`) alike, because the change is to
  the Directory-table default, not a UI-only custom action. Velopack's
  `VELOPACK_INSTALLDIR` property still overrides it for anyone who wants a custom
  location.

  Proven on 2026-09-05: a patched stub MSI installed `/qn` to
  `C:\Program Files\WsScrcpyWeb` (msiexec exit 0, ARP InstallLocation correct),
  where the unpatched MSI lands at `C:\ws-scrcpy-web`.

.NOTES
  Windows-only (WindowsInstaller COM). Runs in the release workflow's
  windows-latest job, AFTER `vpk pack` and BEFORE signing, so the signature
  covers the patched MSI.
#>
param(
    [Parameter(Mandatory)][string]$Msi,
    [string]$AppFolder = 'WsScrcpyWeb'
)
$ErrorActionPreference = 'Stop'

# Direct late-bound COM, and ONE OpenDatabase for the whole operation. The
# reflection-based InvokeMember form was measured flaky, and -- more importantly
# -- opening the same MSI a SECOND time in one process throws
# "OpenDatabase,DatabasePath,OpenMode" (WindowsInstaller caches/locks it). So the
# verify happens INSIDE the single transacted session, reflecting the pending
# change, and Commit runs ONLY if it verified. Measured 2026-09-05.
$installer = New-Object -ComObject WindowsInstaller.Installer
# msiOpenDatabaseModeTransact = 1 (changes visible in-session, persisted on Commit()).
$db = $installer.OpenDatabase($Msi, 1)
try {
    # 1. Ensure ProgramFiles64Folder (child of TARGETDIR) exists as a REAL row so
    #    the Directory tree links. MSI resolves the standard system-folder path
    #    itself; '.' is the WiX-idiomatic DefaultDir placeholder.
    #
    #    NEVER insert this row TEMPORARY: a temporary row satisfies an existence
    #    check but is dropped at Commit, orphaning INSTALLFOLDER's parent and
    #    failing the install with Error 2705 ("Invalid table: Directory; could
    #    not be linked as tree"). Measured 2026-09-05.
    $check = $db.OpenView("SELECT Directory FROM Directory WHERE Directory='ProgramFiles64Folder'")
    $check.Execute()
    $exists = $null -ne $check.Fetch()
    $check.Close()
    if (-not $exists) {
        $ins = $db.OpenView("INSERT INTO Directory (Directory, Directory_Parent, DefaultDir) VALUES ('ProgramFiles64Folder','TARGETDIR','.')")
        $ins.Execute(); $ins.Close()
    }

    # 2. Reparent INSTALLFOLDER under ProgramFiles64Folder and set its leaf. Short
    #    name <=8 chars and valid; long name is <AppFolder>.
    $short = ($AppFolder.ToUpper() -replace '[^A-Z0-9]', '')
    if ($short.Length -gt 8) { $short = $short.Substring(0, 8) }
    $upd = $db.OpenView("UPDATE Directory SET Directory_Parent='ProgramFiles64Folder', DefaultDir='$short|$AppFolder' WHERE Directory='INSTALLFOLDER'")
    $upd.Execute(); $upd.Close()

    # 3. VERIFY the pending change before committing. A silent no-op here would
    #    ship the drive-root MSI again -- exactly what this script prevents -- so
    #    it throws (and does NOT commit) rather than shipping the wrong default.
    $v = $db.OpenView("SELECT Directory_Parent FROM Directory WHERE Directory='INSTALLFOLDER'")
    $v.Execute()
    $rec = $v.Fetch()
    $parent = if ($rec) { $rec.StringData(1) } else { '<none>' }
    $v.Close()
    if ($parent -ne 'ProgramFiles64Folder') {
        throw "MSI PATCH FAILED: INSTALLFOLDER parent is '$parent', expected 'ProgramFiles64Folder'. Not committing. $Msi"
    }

    $db.Commit()
}
finally {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($db)
}

Write-Output "OK: $([System.IO.Path]::GetFileName($Msi)) -> C:\Program Files\$AppFolder (INSTALLFOLDER reparented under ProgramFiles64Folder)"
