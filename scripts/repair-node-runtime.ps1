[CmdletBinding()]
param(
    [string]$Repository = (Get-Location).Path,
    [string]$NodeVersion = "",
    [ValidateSet("x64", "arm64")]
    [string]$Architecture = "x64",
    [string]$DestinationRoot = (
        Join-Path $env:LOCALAPPDATA "FixLab\runtimes"
    ),
    [switch]$Yes
)

$ErrorActionPreference = "Stop"

function Get-ExactVersion {
    param([string]$Value)

    $normalized = $Value.Trim().TrimStart("v")
    if ($normalized -match '^\d+\.\d+\.\d+$') {
        return $normalized
    }
    return ""
}

function Get-RepositoryNodeVersion {
    param([string]$Root)

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        throw "Repository directory does not exist: $Root"
    }

    $profilePath = Join-Path $Root ".github\fixlab\repository-profile.json"
    $frontendDirectory = ""
    if (Test-Path -LiteralPath $profilePath -PathType Leaf) {
        try {
            $profile = Get-Content -LiteralPath $profilePath -Raw |
                ConvertFrom-Json
            $configuredVersion = [string]$profile.toolchain.nodeVersion
            if ($configuredVersion) {
                $profileVersion = Get-ExactVersion $configuredVersion
                if (-not $profileVersion) {
                    throw "$profilePath toolchain.nodeVersion must be an exact version such as 18.18.0."
                }
                return [pscustomobject]@{
                    Version = $profileVersion
                    Source = "$profilePath (toolchain.nodeVersion)"
                }
            }
            if ($profile.applications.frontend.workingDirectory) {
                $frontendDirectory = Join-Path $Root (
                    [string]$profile.applications.frontend.workingDirectory
                )
            }
        }
        catch {
            throw "Repository profile is invalid: $profilePath ($($_.Exception.Message))"
        }
    }

    $directories = @($Root)
    if ($frontendDirectory) {
        $directories += $frontendDirectory
    }
    foreach ($directory in $directories | Select-Object -Unique) {
        foreach ($name in @(".nvmrc", ".node-version")) {
            $path = Join-Path $directory $name
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                continue
            }
            $version = Get-ExactVersion (
                Get-Content -LiteralPath $path -Raw
            )
            if (-not $version) {
                throw "$path must contain an exact Node.js version such as 18.18.0."
            }
            return [pscustomobject]@{
                Version = $version
                Source = $path
            }
        }

        $packagePath = Join-Path $directory "package.json"
        if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
            continue
        }
        try {
            $package = Get-Content -LiteralPath $packagePath -Raw |
                ConvertFrom-Json
            $configuredVersion = [string]$package.engines.node
            $version = Get-ExactVersion $configuredVersion
            if ($version) {
                return [pscustomobject]@{
                    Version = $version
                    Source = "$packagePath (engines.node)"
                }
            }
        }
        catch {
            throw "package.json is invalid JSON: $packagePath ($($_.Exception.Message))"
        }
    }

    return $null
}

function Test-PortableRuntime {
    param(
        [string]$Directory,
        [string]$RequiredVersion
    )

    $nodePath = Join-Path $Directory "node.exe"
    $npmCliPath = Join-Path $Directory "node_modules\npm\bin\npm-cli.js"
    if (
        -not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $npmCliPath -PathType Leaf)
    ) {
        return $null
    }

    $nodeOutput = (& $nodePath --version 2>&1 | Out-String).Trim()
    if (
        $LASTEXITCODE -ne 0 -or
        (Get-ExactVersion $nodeOutput) -ne $RequiredVersion
    ) {
        return $null
    }

    $npmOutput = (& $nodePath $npmCliPath --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $npmOutput) {
        return $null
    }

    return [pscustomobject]@{
        Node = $nodePath
        NpmCli = $npmCliPath
        NodeVersion = $RequiredVersion
        NpmVersion = $npmOutput
        Directory = $Directory
    }
}

if ($env:OS -ne "Windows_NT") {
    throw "Portable Node runtime repair currently supports Windows only."
}
if (-not $env:LOCALAPPDATA -and -not $DestinationRoot) {
    throw "LOCALAPPDATA is unavailable; pass an explicit -DestinationRoot."
}

$repositoryRoot = (Resolve-Path -LiteralPath $Repository).Path
$requestedVersion = Get-ExactVersion $NodeVersion
if ($NodeVersion -and -not $requestedVersion) {
    throw "-NodeVersion must be an exact version such as 18.18.0."
}
if (-not $requestedVersion) {
    $requirement = Get-RepositoryNodeVersion -Root $repositoryRoot
    if (-not $requirement) {
        throw "No exact repository Node.js version was found. Pass -NodeVersion with an exact version."
    }
    $requestedVersion = $requirement.Version
    Write-Output "Repository requires Node.js $requestedVersion from $($requirement.Source)."
}

$destinationRootFull = [System.IO.Path]::GetFullPath($DestinationRoot)
$ownershipMarker = Join-Path $destinationRootFull ".fixlab-runtime-root"
$runtimeName = "node-v$requestedVersion-win-$Architecture"
$runtimePath = [System.IO.Path]::GetFullPath(
    (Join-Path $destinationRootFull $runtimeName)
)
$rootPrefix = $destinationRootFull.TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
) + [System.IO.Path]::DirectorySeparatorChar
if (
    -not $runtimePath.StartsWith(
        $rootPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )
) {
    throw "Runtime destination must remain inside DestinationRoot."
}

$archiveName = "$runtimeName.zip"
$downloadBase = "https://nodejs.org/dist/v$requestedVersion"
$archiveUrl = "$downloadBase/$archiveName"
$checksumsUrl = "$downloadBase/SHASUMS256.txt"

Write-Output "Portable Node.js repair plan:"
Write-Output "  version: $requestedVersion"
Write-Output "  architecture: $Architecture"
Write-Output "  destination: $runtimePath"
Write-Output "  archive: $archiveUrl"
Write-Output "  checksum manifest: $checksumsUrl"
Write-Output "  system PATH changes: none"
Write-Output "  NVM changes: none"

$current = Test-PortableRuntime `
    -Directory $runtimePath `
    -RequiredVersion $requestedVersion
if ($current) {
    Write-Output "Portable runtime is already ready:"
    Write-Output "  Node.js: $($current.NodeVersion) ($($current.Node))"
    Write-Output "  npm: $($current.NpmVersion) ($($current.NpmCli))"
    exit 0
}

if (-not $Yes) {
    Write-Output "No changes made. Review the plan and rerun with -Yes to repair the runtime."
    exit 0
}

New-Item -ItemType Directory -Path $destinationRootFull -Force | Out-Null
if (
    (Test-Path -LiteralPath $runtimePath) -and
    -not (Test-Path -LiteralPath $ownershipMarker -PathType Leaf)
) {
    throw "Refusing to replace an existing runtime because DestinationRoot is not marked as FixLab-owned: $destinationRootFull"
}
if (-not (Test-Path -LiteralPath $ownershipMarker -PathType Leaf)) {
    Set-Content `
        -LiteralPath $ownershipMarker `
        -Value "FixLab portable runtime root"
}
$downloadRoot = Join-Path $destinationRootFull (
    ".downloads\repair-$([guid]::NewGuid())"
)
$archivePath = Join-Path $downloadRoot $archiveName
$checksumsPath = Join-Path $downloadRoot "SHASUMS256.txt"
$extractPath = Join-Path $downloadRoot "extract"
New-Item -ItemType Directory -Path $downloadRoot | Out-Null

try {
    Invoke-WebRequest -UseBasicParsing $archiveUrl -OutFile $archivePath
    Invoke-WebRequest `
        -UseBasicParsing `
        $checksumsUrl `
        -OutFile $checksumsPath

    $checksumLine = Get-Content -LiteralPath $checksumsPath |
        Where-Object { $_ -match "  $([regex]::Escape($archiveName))$" } |
        Select-Object -First 1
    if (-not $checksumLine) {
        throw "Official checksum manifest does not contain $archiveName."
    }
    $expectedHash = ($checksumLine -split '\s+', 2)[0].ToUpperInvariant()
    $actualHash = (
        Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
    ).Hash
    if ($actualHash -ne $expectedHash) {
        throw "Node.js archive checksum mismatch. Expected $expectedHash, got $actualHash."
    }
    Write-Output "PASS  Official Node.js SHA-256 checksum ($actualHash)"

    New-Item -ItemType Directory -Path $extractPath | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath
    $extractedRuntime = Join-Path $extractPath $runtimeName
    $verified = Test-PortableRuntime `
        -Directory $extractedRuntime `
        -RequiredVersion $requestedVersion
    if (-not $verified) {
        throw "Downloaded archive did not produce a coherent Node.js $requestedVersion and npm runtime."
    }

    if (
        (Test-Path -LiteralPath $runtimePath) -and
        (Test-Path -LiteralPath $ownershipMarker -PathType Leaf)
    ) {
        Remove-Item -LiteralPath $runtimePath -Recurse -Force
    }
    Move-Item -LiteralPath $extractedRuntime -Destination $runtimePath
}
finally {
    if (Test-Path -LiteralPath $downloadRoot) {
        Remove-Item -LiteralPath $downloadRoot -Recurse -Force
    }
}

$runtime = Test-PortableRuntime `
    -Directory $runtimePath `
    -RequiredVersion $requestedVersion
if (-not $runtime) {
    throw "Portable Node.js repair completed but final verification failed."
}

Write-Output "Portable runtime repaired and verified:"
Write-Output "  Node.js: $($runtime.NodeVersion) ($($runtime.Node))"
Write-Output "  npm: $($runtime.NpmVersion) ($($runtime.NpmCli))"
Write-Output "Use it in the current PowerShell session without changing the permanent PATH:"
Write-Output "  `$env:PATH = `"$runtimePath;`$env:PATH`""
