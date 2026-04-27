<#
.SYNOPSIS
    Manual end-to-end test of the Velopack v1 -> v2 update flow.

.DESCRIPTION
    Builds the current branch as v0.1.0 into a sandbox install dir, bumps to
    v0.1.1, builds again into a local feed dir, and instructs you to launch the
    sandboxed app and click "Check now" in the browser. After you confirm the
    update completed, the script asserts that <install-root>/sq.version reads
    "0.1.1".

    INTERACTIVE -- not a CI script. Requires user attention partway through.

.NOTES
    Windows / PowerShell 7+ only. On non-Windows, exits cleanly with a notice.
    Uses pwsh syntax (chain operators, ternary). Run as:

        pwsh scripts/test-update-flow.ps1

.PARAMETER SandboxRoot
    Optional path to use as the sandbox root. Defaults to a fresh temp dir.

.PARAMETER KeepSandbox
    If set, leaves the sandbox dir on disk for inspection. Default: removes it
    after a successful run.
#>

[CmdletBinding()]
param(
    [string]$SandboxRoot,
    [switch]$KeepSandbox
)

$ErrorActionPreference = 'Stop'

# -------- Banner --------
Write-Host ''
Write-Host '================================================================'
Write-Host '  ws-scrcpy-web -- manual update-flow test (v1 -> v2)'
Write-Host '  This is an INTERACTIVE script -- not a CI gate.'
Write-Host '  You will be asked to launch the sandboxed app and click'
Write-Host '  "Check for updates now" in the browser partway through.'
Write-Host '================================================================'
Write-Host ''

# -------- Platform check --------
if (-not $IsWindows) {
    Write-Host 'test-update-flow is Windows-only (uses vpk pack + .msi). Skipping.'
    exit 0
}

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw 'PowerShell 7+ (pwsh) is required. Current version: ' + $PSVersionTable.PSVersion
}

# -------- Locate repo root --------
$ScriptRoot = Split-Path -Parent $PSCommandPath
$RepoRoot = Resolve-Path (Join-Path $ScriptRoot '..')
Write-Host "Repo root: $RepoRoot"

# -------- Sandbox dirs --------
if (-not $SandboxRoot) {
    $SandboxRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ws-scrcpy-update-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
}
$InstallRoot = Join-Path $SandboxRoot 'install'
$FeedRoot    = Join-Path $SandboxRoot 'feed'
$BuildOutV1  = Join-Path $SandboxRoot 'releases-v1'
$BuildOutV2  = Join-Path $SandboxRoot 'releases-v2'

New-Item -ItemType Directory -Path $InstallRoot, $FeedRoot, $BuildOutV1, $BuildOutV2 -Force | Out-Null

Write-Host ''
Write-Host "Sandbox dirs:"
Write-Host "  install root : $InstallRoot"
Write-Host "  feed dir     : $FeedRoot"
Write-Host "  v1 build out : $BuildOutV1"
Write-Host "  v2 build out : $BuildOutV2"
Write-Host ''

# -------- Pre-flight: vpk on PATH --------
if (-not (Get-Command vpk -ErrorAction SilentlyContinue)) {
    throw 'vpk not found on PATH. Install via: dotnet tool install -g vpk'
}

function Invoke-StepBuild {
    param(
        [Parameter(Mandatory)] [string]$Version,
        [Parameter(Mandatory)] [string]$OutDir
    )

    Push-Location $RepoRoot
    try {
        Write-Host "[step] Bumping version to $Version"
        & node 'scripts/bump-version.mjs' $Version
        if ($LASTEXITCODE -ne 0) { throw "bump-version failed for $Version" }

        Write-Host '[step] npm run build'
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }

        Write-Host '[step] cargo build --release --workspace'
        & cargo build --release --workspace
        if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }

        Write-Host '[step] node scripts/fetch-servy.mjs'
        & node 'scripts/fetch-servy.mjs'
        if ($LASTEXITCODE -ne 0) { throw 'fetch-servy failed' }

        Write-Host '[step] node scripts/stage-publish.mjs'
        & node 'scripts/stage-publish.mjs'
        if ($LASTEXITCODE -ne 0) { throw 'stage-publish failed' }

        Write-Host "[step] vpk pack -> $OutDir"
        & vpk pack `
            --packId WsScrcpyWeb `
            --packVersion $Version `
            --packDir 'publish' `
            --mainExe 'ws-scrcpy-web-launcher.exe' `
            --packTitle 'ws-scrcpy-web' `
            --packAuthors 'ws-scrcpy-web contributors' `
            --msi `
            --instLocation Either `
            --channel stable `
            -o $OutDir
        if ($LASTEXITCODE -ne 0) { throw 'vpk pack failed' }
    }
    finally {
        Pop-Location
    }
}

# -------- Capture baseline version so we can restore it --------
$pkgJsonPath = Join-Path $RepoRoot 'package.json'
$originalVersion = (Get-Content $pkgJsonPath -Raw | ConvertFrom-Json).version
Write-Host "Original version (will be restored at end): $originalVersion"
Write-Host ''

try {
    # -------- Build v0.1.0 (sandbox install) --------
    Write-Host '=== BUILDING v0.1.0 (initial install) ==='
    Invoke-StepBuild -Version '0.1.0' -OutDir $BuildOutV1

    # Locate the MSI / portable / feed json from the v1 build.
    $v1Msi = Get-ChildItem -Path $BuildOutV1 -Filter '*.msi' -File | Select-Object -First 1
    if (-not $v1Msi) { throw 'v1 MSI not produced by vpk pack' }
    Write-Host "v1 MSI: $($v1Msi.FullName)"

    Write-Host ''
    Write-Host '>>> Manual install step <<<'
    Write-Host "Install the MSI to a sandbox location:"
    Write-Host "    msiexec /i `"$($v1Msi.FullName)`" /qb INSTALLDIR=`"$InstallRoot`""
    Write-Host '(or run the MSI through the GUI and pick a sandbox path)'
    Write-Host ''
    Read-Host 'Press ENTER once v0.1.0 is installed to the sandbox'

    # -------- Build v0.1.1 (feed) --------
    Write-Host ''
    Write-Host '=== BUILDING v0.1.1 (update target) ==='
    Invoke-StepBuild -Version '0.1.1' -OutDir $BuildOutV2

    # Copy v2 release artifacts into feed dir (Velopack reads RELEASES + nupkg from feed root).
    Copy-Item -Path (Join-Path $BuildOutV2 '*') -Destination $FeedRoot -Recurse -Force
    Write-Host "v2 artifacts staged in feed: $FeedRoot"

    # -------- Point app at local feed --------
    $feedUri = ([System.Uri]$FeedRoot).AbsoluteUri  # produces file:///C:/...
    $env:VELOPACK_FEED_URL = $feedUri
    Write-Host ''
    Write-Host ">>> VELOPACK_FEED_URL = $feedUri"
    Write-Host 'This env var is set in THIS shell only. Launch the sandboxed app'
    Write-Host 'from THIS shell so it inherits the override:'
    Write-Host ''
    Write-Host "    & `"$InstallRoot\ws-scrcpy-web-launcher.exe`""
    Write-Host ''
    Write-Host 'In the browser at http://localhost:8000:'
    Write-Host '  1. Open Settings (gear icon)'
    Write-Host '  2. Click "check for updates now" in the Updates section'
    Write-Host '  3. Wait for the "ready" state, click Apply'
    Write-Host '  4. The app should restart on v0.1.1'
    Write-Host ''
    Read-Host 'Press ENTER once the update has been applied and the app restarted'

    # -------- Final assertion --------
    $sqVersionPath = Join-Path $InstallRoot 'sq.version'
    if (-not (Test-Path $sqVersionPath)) {
        throw "FAIL: sq.version not found at $sqVersionPath"
    }
    $observed = (Get-Content $sqVersionPath -Raw).Trim()
    Write-Host ''
    Write-Host "Observed sq.version: '$observed'"
    if ($observed -ne '0.1.1') {
        throw "FAIL: expected sq.version to be '0.1.1', got '$observed'"
    }

    Write-Host ''
    Write-Host '================================================================'
    Write-Host '  PASS -- v0.1.0 -> v0.1.1 update flow completed successfully.'
    Write-Host '================================================================'
}
finally {
    # Restore working tree's version.
    Push-Location $RepoRoot
    try {
        Write-Host ''
        Write-Host "Restoring working-tree version to $originalVersion"
        & node 'scripts/bump-version.mjs' $originalVersion 2>&1 | Out-Null
        # bump-version refuses to "downgrade" by inserting a duplicate header; that's OK,
        # the user can `git checkout package.json Cargo.toml CHANGELOG.md` if needed.
    }
    catch {
        Write-Warning "Could not auto-restore version. Run: git checkout package.json Cargo.toml CHANGELOG.md"
    }
    finally {
        Pop-Location
    }

    if (-not $KeepSandbox) {
        Write-Host "Cleaning up sandbox: $SandboxRoot"
        Remove-Item -Path $SandboxRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    else {
        Write-Host "Sandbox kept at: $SandboxRoot"
    }
}
