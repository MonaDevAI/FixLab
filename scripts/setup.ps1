$ErrorActionPreference = "Stop"

$repository = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repository

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js 20 is required. Install it before running this script."
}

$major = [int]((node --version).TrimStart("v").Split(".")[0])
if ($major -ne 20) {
    throw "Node.js 20 is required; found $(node --version)."
}

npm ci
if ($LASTEXITCODE -ne 0) {
    throw "npm ci failed."
}

Write-Output "FixLab dependencies are installed. Run 'npm run validate'."
