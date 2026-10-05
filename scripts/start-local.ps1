param([string]$PublicOrigin = '')
$ErrorActionPreference = 'Stop'
$wazexArguments = @('server/index.js')
if ($PublicOrigin) {
    $wazexOriginUri = [Uri]$PublicOrigin
    if (-not $wazexOriginUri.IsAbsoluteUri -or $wazexOriginUri.Scheme -ne 'https') { throw 'PublicOrigin must be an absolute HTTPS origin.' }
    $PublicOrigin = $wazexOriginUri.GetLeftPart([UriPartial]::Authority)
    $wazexArguments += "--public-origin=$PublicOrigin"
}
$wazexRoot = Split-Path -Parent $PSScriptRoot
$wazexUrl = 'http://127.0.0.1:4310'
try {
    $wazexStatus = Invoke-RestMethod "$wazexUrl/api/status" -TimeoutSec 2
} catch {}
if ($wazexStatus.token -and $null -ne $wazexStatus.accounts) {
    if ($PublicOrigin -and $wazexStatus.publicOrigin -ne $PublicOrigin) { throw 'Stop the existing wazex process before changing its proxy origin.' }
    Write-Output "wazex is already running at $wazexUrl"
    exit 0
}
$wazexNode = (Get-Command node -ErrorAction Stop).Source
$wazexData = Join-Path $wazexRoot 'data'
New-Item -ItemType Directory -Path $wazexData -Force | Out-Null
$wazexProcess = Start-Process -FilePath $wazexNode -ArgumentList $wazexArguments -WorkingDirectory $wazexRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $wazexData 'server.stdout.log') -RedirectStandardError (Join-Path $wazexData 'server.stderr.log') -PassThru
for ($wazexAttempt = 0; $wazexAttempt -lt 30; $wazexAttempt++) {
    Start-Sleep -Milliseconds 200
    if ($wazexProcess.HasExited) {
        throw "wazex exited during startup. See data/server.stderr.log."
    }
    try {
        $wazexStatus = Invoke-RestMethod "$wazexUrl/api/status" -TimeoutSec 2
        if ($wazexStatus.token -and $null -ne $wazexStatus.accounts) {
            Write-Output "wazex is running independently in the background at $wazexUrl (PID $($wazexProcess.Id)). Logs: data/server.stdout.log and data/server.stderr.log."
            exit 0
        }
    } catch {}
}
throw 'wazex did not become ready. See data/server.stderr.log.'
