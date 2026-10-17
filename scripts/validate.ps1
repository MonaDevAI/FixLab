[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest

if (-not $IsWindows) {
    throw "This runner is for Windows. Run 'npm run validate' directly on other platforms."
}

Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;

public static class FixLabValidationPowerState {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint flags);
}
'@

$continuous = [uint32]2147483648
$systemRequired = [uint32]1
$displayRequired = [uint32]2
$previousState = [FixLabValidationPowerState]::SetThreadExecutionState(
    $continuous -bor $systemRequired -bor $displayRequired
)
if ($previousState -eq 0) {
    throw "Could not request temporary idle-sleep prevention. Validation was not started."
}

$exitCode = 1
try {
    Write-Output "Temporarily keeping Windows and its display awake during validation."
    Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
    try {
        npm run validate
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
} finally {
    if ([FixLabValidationPowerState]::SetThreadExecutionState($previousState) -eq 0) {
        throw "Could not restore the previous Windows execution state."
    }
    Write-Output "Temporary idle-sleep prevention released."
}

exit $exitCode
