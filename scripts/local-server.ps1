param([ValidateSet('start', 'status', 'stop')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entryPath = Join-Path $repoPath 'dist/server/index.js'
$runtimePath = Join-Path $repoPath '.cache/runtime'
$statePath = Join-Path $runtimePath 'server.json'
$serverUrl = 'http://127.0.0.1:4317'

function Get-ManagedServer {
    if (-not (Test-Path -LiteralPath $statePath)) { return $null }
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $process = Get-Process -Id $state.processId -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    $details = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
    if ($process.StartTime.ToUniversalTime().Ticks -ne ([datetime]$state.startedAt).ToUniversalTime().Ticks -or
        $process.Path -ne $state.nodePath -or
        -not $details.CommandLine.Contains('"' + $entryPath + '"')) {
        throw 'Stored PID belongs to a different process. No process was stopped.'
    }
    return $process
}

$existing = Get-ManagedServer
if ($Action -eq 'stop') {
    if ($existing) { Stop-Process -Id $existing.Id; $existing.WaitForExit(5000) | Out-Null }
    Write-Output 'Server stopped. Saved data was retained.'
    exit 0
}
if ($Action -eq 'status') {
    if (-not $existing) { Write-Output 'Server is not running.'; exit 1 }
    $health = Invoke-RestMethod "$serverUrl/healthz" -TimeoutSec 3
    if ($health.status -ne 'ok') { throw 'Server health check failed.' }
    Write-Output "Running: $serverUrl (PID $($existing.Id))"
    exit 0
}
if ($existing) {
    $health = Invoke-RestMethod "$serverUrl/healthz" -TimeoutSec 3
    if ($health.status -ne 'ok') { throw 'Server health check failed.' }
    Write-Output "Already running: $serverUrl (PID $($existing.Id))"
    exit 0
}
if (-not (Test-Path -LiteralPath $entryPath) -or -not (Test-Path -LiteralPath (Join-Path $repoPath 'dist/client/index.html'))) {
    throw 'Build first: npm ci; npm run build'
}
if (Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 4317 is already in use. No process was stopped.'
}
$nodeCommand = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$nodePath = (& $nodeCommand -p 'process.execPath').Trim()
$nodeMajor = (& $nodePath -p 'process.versions.node.split(".")[0]').Trim()
if ($LASTEXITCODE -ne 0 -or $nodeMajor -ne '24') { throw 'Node.js 24 is required.' }
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$stamp = [guid]::NewGuid().ToString('N')
$stdout = Join-Path $runtimePath "$stamp.out.log"
$stderr = Join-Path $runtimePath "$stamp.err.log"
# Start-Process creates a hidden server independent of this foreground shell.
# Pin the default local port/data path; retain an explicitly configured MEMX_URL.
$oldPort = $env:PORT
$oldData = $env:DATA_PATH
try {
    $env:PORT = '4317'
    $env:DATA_PATH = Join-Path $repoPath '.data/workbench.db'
    $process = Start-Process -FilePath $nodePath -ArgumentList ('"' + $entryPath + '"') -WorkingDirectory $repoPath -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
} finally {
    $env:PORT = $oldPort
    $env:DATA_PATH = $oldData
}
@{processId=$process.Id; startedAt=$process.StartTime.ToUniversalTime().ToString('o'); nodePath=$nodePath; stdout=$stdout; stderr=$stderr} | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
for ($attempt=0; $attempt -lt 30; $attempt++) {
    $process.Refresh()
    if ($process.HasExited) { throw "Server exited. See $stderr" }
    try {
        $health = Invoke-RestMethod "$serverUrl/healthz" -TimeoutSec 1
        if ($health.status -eq 'ok') { Write-Output "Started: $serverUrl (PID $($process.Id))"; exit 0 }
    } catch { }
    Start-Sleep -Milliseconds 200
}
throw "Server did not become ready. See $stderr"
