# capture-logs.ps1 - snapshot every ws-scrcpy-web diagnostic into one folder, for a smoke capture point.
#
# Run at any capture point during the Windows smoke - ESPECIALLY when a test FAILS, and right after
# an install / uninstall / update. Read-only: it never changes the install. The in-app uninstall
# cleaner runs with logging OFF by design, so for the uninstall tests (15.x) the EVIDENCE is
# filesystem + registry + temp state - which this captures.
#
# Usage:   powershell -ExecutionPolicy Bypass -File capture-logs.ps1 [label]
#   e.g.   powershell -ExecutionPolicy Bypass -File capture-logs.ps1 15.2-wipe
#          powershell -ExecutionPolicy Bypass -File capture-logs.ps1 5.7-after-uninstall
# Output:  %USERPROFILE%\wssw-smoke-logs\<timestamp>-<label>\   (+ a .zip to attach)

param([string]$Label = "capture")

$ts  = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $HOME "wssw-smoke-logs\$ts-$Label"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$dataRoot  = Join-Path $env:ProgramData "WsScrcpyWeb"
$progFiles = Join-Path $env:ProgramFiles "WsScrcpyWeb"
$elevated  = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)

# Capture a command/expression's output (incl. errors) to a named file under $out.
function Save([string]$name, [scriptblock]$block) {
    $path = Join-Path $out $name
    try   { & $block 2>&1 | Out-String | Set-Content -Path $path -Encoding utf8 }
    catch { "ERROR capturing ${name}: $_" | Set-Content -Path $path -Encoding utf8 }
}

Write-Host "[capture] capturing to $out"

# 00. environment + bundle index
@(
  "label:    $Label"
  "captured: $(Get-Date -Format o)"
  "OS:       $([System.Environment]::OSVersion.VersionString)"
  "user:     $env:USERNAME   elevated: $elevated"
  ""
  "# files in this bundle:"
  "#   10-procs        running launcher/node/tray/adb (want: none after stop-exit / uninstall)"
  "#   20-service      sc query WsScrcpyWeb (want: 'does not exist' after uninstall)"
  "#   21-run-key      HKLM ...\Run\WsScrcpyWebTray (want: gone after uninstall)"
  "#   22-arp          Add/Remove Programs entry (want: gone after uninstall)"
  "#   30-programfiles Program Files\WsScrcpyWeb (want: gone after uninstall)"
  "#   31-dataroot     ProgramData\WsScrcpyWeb recursive - the keep/wipe leftover check"
  "#                   (a wipe must leave NOTHING; watch for a stray control\operation-server\)"
  "#   32-temp-cleaner the uninstall cleaner copy in temp (proves Phase-1 staged + ran)"
  "#   40-config       config.json (kept on --keep, gone on --wipe)"
  "#   70-*.log        app logs (launcher / server / tray)"
) | Set-Content (Join-Path $out "00-env.txt") -Encoding utf8

Save "01-version.txt"     { Get-Content (Join-Path $progFiles "current\VERSION") -ErrorAction SilentlyContinue }

# 10. running processes
Save "10-procs.txt"       { Get-Process ws-scrcpy-web-launcher,ws-scrcpy-web-tray,node,adb -ErrorAction SilentlyContinue | Select-Object Name,Id,StartTime,Path | Format-Table -AutoSize }

# 20. service
Save "20-service.txt"     { & "$env:SystemRoot\System32\sc.exe" query WsScrcpyWeb }

# 21. tray autostart registry entry
Save "21-run-key.txt"     { Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" -Name WsScrcpyWebTray -ErrorAction SilentlyContinue | Select-Object WsScrcpyWebTray }

# 22. Add/Remove Programs (ARP) entry
Save "22-arp.txt"         {
    Get-ChildItem "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall","HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } |
        Where-Object { $_.DisplayName -match "scrcpy" } |
        Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString
}

# 30. Program Files install tree
Save "30-programfiles.txt" { if (Test-Path $progFiles) { Get-ChildItem $progFiles -Recurse -ErrorAction SilentlyContinue | Select-Object FullName,Length } else { "(Program Files\WsScrcpyWeb absent)" } }

# 31. dataRoot recursive - the keep/wipe leftover check (shows control\operation-server\)
Save "31-dataroot.txt"     { if (Test-Path $dataRoot) { Get-ChildItem $dataRoot -Recurse -Force -ErrorAction SilentlyContinue | Select-Object FullName,Length } else { "(ProgramData\WsScrcpyWeb absent - fully wiped)" } }

# 32. uninstall cleaner copy in temp (Phase-1 stages it here; cleaner is --no-log so this is the trace)
Save "32-temp-cleaner.txt" {
    @($env:TEMP, "$env:SystemRoot\Temp", "$env:SystemRoot\SystemTemp") | Select-Object -Unique | ForEach-Object {
        Get-ChildItem (Join-Path $_ "ws-scrcpy-web-uninstall-*.exe") -ErrorAction SilentlyContinue
    } | Select-Object FullName,Length,LastWriteTime
}

# 40. config.json
Copy-Item (Join-Path $dataRoot "config.json") (Join-Path $out "40-config.json") -ErrorAction SilentlyContinue

# 70. app logs
Get-ChildItem (Join-Path $dataRoot "logs\*.log") -ErrorAction SilentlyContinue | ForEach-Object { Copy-Item $_.FullName (Join-Path $out "70-$($_.Name)") -ErrorAction SilentlyContinue }

# bundle it for easy attachment
Compress-Archive -Path $out -DestinationPath "$out.zip" -Force -ErrorAction SilentlyContinue
Write-Host "[capture] Captured -> $out  (and $out.zip)"
