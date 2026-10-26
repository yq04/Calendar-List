param(
    [string]$Executable,
    [string]$Fixture,
    [switch]$ThemeChecks
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Executable) { $Executable = Join-Path $projectRoot 'src-tauri/target/debug/kal.exe' }
if (-not $Fixture) { $Fixture = Join-Path $projectRoot '_fixture/calendar.db' }
$executablePath = (Resolve-Path -LiteralPath $Executable).Path
$fixturePath = (Resolve-Path -LiteralPath $Fixture).Path
$allowedFixture = (Resolve-Path -LiteralPath (Join-Path $projectRoot '_fixture/calendar.db')).Path
if ($fixturePath -ne $allowedFixture) { throw 'Native checks accept only the project _fixture/calendar.db, never a live database.' }
if ([IO.Path]::GetFileName($executablePath) -ne 'kal.exe') { throw 'Expected an explicitly built kal.exe.' }
if (Get-Process -Name kal -ErrorAction SilentlyContinue) { throw 'An existing Kal process is running; exit it normally before isolated native checks.' }
$runRoot = Join-Path $projectRoot ('_fixture/runtime-native-' + [Guid]::NewGuid().ToString('N'))
$appDir = Join-Path $runRoot 'Kal'
$fontDir = Join-Path $appDir 'fonts'
New-Item -ItemType Directory -Path $fontDir -Force | Out-Null
$fontSource = Join-Path $env:WINDIR 'Fonts/segoeui.ttf'
if (-not (Test-Path -LiteralPath $fontSource -PathType Leaf)) { throw 'The native font check needs the installed Segoe UI font.' }
Copy-Item -LiteralPath $fontSource -Destination (Join-Path $fontDir 'native-segoe.ttf')
$settings = @{
    schema = 'kal.settings/1'
    activeTheme = 'default'
    productivity = @{ countdowns = @(@{ id='native-check-countdown'; title='原生隔离倒计时'; date=(Get-Date).AddDays(30).ToString('yyyy-MM-dd') }) }
}
$settings | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $appDir 'settings.json') -Encoding utf8NoBOM
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$cdpPort = $listener.LocalEndpoint.Port
$listener.Stop()
$start = [Diagnostics.ProcessStartInfo]::new($executablePath)
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$start.WorkingDirectory = $projectRoot
$start.Environment['APPDATA'] = $runRoot
$start.Environment['KAL_DB_PATH'] = $fixturePath
$start.Environment['KAL_DEBUG_PORT'] = [string]$cdpPort
$ownedProcess = $null
$oldPort = $env:KAL_CDP_PORT
$oldExe = $env:KAL_NATIVE_EXE
$oldTheme = $env:KAL_NATIVE_THEMES
Push-Location $projectRoot
try {
    $ownedProcess = [Diagnostics.Process]::Start($start)
    $ready = $false
    for ($attempt=0; $attempt -lt 150; $attempt++) {
        if ($ownedProcess.HasExited) { throw "Isolated Kal exited before CDP startup (code $($ownedProcess.ExitCode)). No other process was touched." }
        try {
            $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$cdpPort/json/list" -TimeoutSec 1
            if ($targets | Where-Object type -EQ 'page') { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 100
    }
    if (-not $ready) { throw 'No CDP page from the isolated instance. Build a debug binary with KAL_DEBUG_PORT support first.' }
    $env:KAL_CDP_PORT = [string]$cdpPort
    $env:KAL_NATIVE_EXE = $executablePath
    $env:KAL_NATIVE_THEMES = if ($ThemeChecks) { '1' } else { '0' }
    & node (Join-Path $PSScriptRoot 'native-check.mjs')
    if ($LASTEXITCODE -ne 0) { throw "Native checks failed (exit $LASTEXITCODE). Isolated artifacts retained at $runRoot" }
    Write-Output "Native artifacts retained at $runRoot"
} finally {
    $env:KAL_CDP_PORT = $oldPort
    $env:KAL_NATIVE_EXE = $oldExe
    $env:KAL_NATIVE_THEMES = $oldTheme
    if ($ownedProcess -and -not $ownedProcess.HasExited) {
        $null = $ownedProcess.CloseMainWindow()
        if (-not $ownedProcess.WaitForExit(1500)) { $ownedProcess.Kill(); $ownedProcess.WaitForExit() }
    }
    Pop-Location
}
