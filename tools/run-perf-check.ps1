param(
    [ValidateSet("before", "after")]
    [string]$Phase = "before",
    
    [ValidateSet("all", "small", "medium", "large")]
    [string]$Scale = "all",
    
    [ValidateSet("all", "debug", "release")]
    [string]$Binary = "all",
    
    [int]$CdpPort = 9456,
    [string]$DataDir = "docs/perf-data",
    
    # Executable parameterization
    [string]$Executable = "",
    [string]$DebugExecutable = "",
    [string]$ReleaseExecutable = ""
)

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RootDir

# Default executable paths
$BackupDebug = "$RootDir/_backup/ux-themes-20261015-014117/src-tauri/target/debug/kal.exe"
$BackupRelease = "$RootDir/_backup/ux-themes-20261015-014117/src-tauri/target/release/kal.exe"
$TargetDebug = "$RootDir/src-tauri/target/debug/kal.exe"
$TargetRelease = "$RootDir/src-tauri/target/release/kal.exe"

# Resolve Debug executable
if ($DebugExecutable) {
    $DebugExe = $DebugExecutable
} elseif ($Executable) {
    $DebugExe = $Executable
} elseif ($Phase -eq "before" -and (Test-Path $BackupDebug)) {
    $DebugExe = $BackupDebug
} else {
    $DebugExe = $TargetDebug
}

# Resolve Release executable
if ($ReleaseExecutable) {
    $ReleaseExe = $ReleaseExecutable
} elseif ($Executable) {
    $ReleaseExe = $Executable
} elseif ($Phase -eq "before" -and (Test-Path $BackupRelease)) {
    $ReleaseExe = $BackupRelease
} else {
    $ReleaseExe = $TargetRelease
}

$AbsDataDir = "$RootDir/$DataDir"
New-Item -ItemType Directory -Force -Path $AbsDataDir | Out-Null

$PerfRunsRoot = "$RootDir/_fixture/perf-runs"
New-Item -ItemType Directory -Force -Path $PerfRunsRoot | Out-Null

Write-Host "=== Kal Performance Benchmarking Runner ===" -ForegroundColor Cyan
Write-Host "Phase: $Phase | Scale: $Scale | Binary: $Binary | CDP Port: $CdpPort" -ForegroundColor Gray
Write-Host "DebugExe: $DebugExe (Exists: $(Test-Path $DebugExe))" -ForegroundColor Gray
Write-Host "ReleaseExe: $ReleaseExe (Exists: $(Test-Path $ReleaseExe))" -ForegroundColor Gray

# 1. Check if an external kal.exe is already running
$existing = Get-Process kal -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "已有 Kal 实例正在运行 (PID: $($existing.Id -join ', '))。为避免破坏外部/其他会话状态，测试中断退出。" -ForegroundColor Red
    exit 1
}

# 2. Determine scales to test
$scalesToRun = @()
if ($Scale -eq "all") {
    $scalesToRun = @("small", "medium", "large")
} else {
    $scalesToRun = @($Scale)
}

function Get-ProcessTreePids($rootPid) {
    $pids = @($rootPid)
    $queue = [System.Collections.Generic.Queue[int]]::new()
    $queue.Enqueue($rootPid)
    while ($queue.Count -gt 0) {
        $curr = $queue.Dequeue()
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $curr" -ErrorAction SilentlyContinue
        if ($children) {
            foreach ($ch in $children) {
                $pids += [int]$ch.ProcessId
                $queue.Enqueue([int]$ch.ProcessId)
            }
        }
    }
    return $pids
}

function Measure-ProcessTreeMemory($rootPid) {
    $pids = Get-ProcessTreePids -rootPid $rootPid
    $mainProc = $null
    $treeDetails = @()
    $totalPrivateBytes = [int64]0
    $totalWorkingSet = [int64]0

    foreach ($pidNum in $pids) {
        $p = Get-Process -Id $pidNum -ErrorAction SilentlyContinue
        if ($p) {
            $isMain = ($pidNum -eq $rootPid)
            $item = [PSCustomObject]@{
                Id = $pidNum
                Name = $p.ProcessName
                IsMain = $isMain
                PrivateBytesMB = [Math]::Round($p.PrivateMemorySize64 / 1MB, 2)
                WorkingSetMB = [Math]::Round($p.WorkingSet64 / 1MB, 2)
                PrivateBytes = $p.PrivateMemorySize64
                WorkingSet = $p.WorkingSet64
            }
            $treeDetails += $item
            $totalPrivateBytes += $p.PrivateMemorySize64
            $totalWorkingSet += $p.WorkingSet64
            if ($isMain) { $mainProc = $item }
        }
    }

    return [PSCustomObject]@{
        ProcessCount = $treeDetails.Count
        MainProcess = $mainProc
        TreeProcesses = $treeDetails
        TotalPrivateBytesMB = [Math]::Round($totalPrivateBytes / 1MB, 2)
        TotalWorkingSetMB = [Math]::Round($totalWorkingSet / 1MB, 2)
        Note = "Private Bytes 可安全跨进程累加；Working Set (RSS) 总和包含共享页重复计算，不可作为真实私有物理开销"
    }
}

# 3. Execute Debug CDP Benchmarks
if ($Binary -in @("all", "debug")) {
    Write-Host "`n--- Running Debug CDP Benchmarks (IPC Latency & Render Amplification) ---" -ForegroundColor Yellow
    
    foreach ($sc in $scalesToRun) {
        $dbPath = "$RootDir/_fixture/perf-20261015/calendar-$sc.db"
        if (-not (Test-Path $dbPath)) {
            Write-Host "Fixture database not found: $dbPath. Generating fixtures..." -ForegroundColor Yellow
            python "$RootDir/tools/generate-perf-fixture.py"
        }
        
        # Unique GUID isolated APPDATA, retained for forensic inspection (no recursive deletions)
        $runGuid = [System.Guid]::NewGuid().ToString("N")
        $isoApp = "$PerfRunsRoot/appdata-debug-$Phase-$sc-$runGuid"
        New-Item -ItemType Directory -Force -Path $isoApp | Out-Null
        
        Write-Host "Starting Debug Kal for scale: $sc (Port: $CdpPort, APPDATA: $isoApp)..." -ForegroundColor Gray
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $DebugExe
        $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
        $psi.UseShellExecute = $false
        $psi.EnvironmentVariables["APPDATA"] = $isoApp
        $psi.EnvironmentVariables["KAL_DB_PATH"] = $dbPath
        $psi.EnvironmentVariables["KAL_DEBUG_PORT"] = "$CdpPort"
        
        $debugProc = [System.Diagnostics.Process]::Start($psi)
        $procId = $debugProc.Id
        Write-Host "Started Debug Kal PID: $procId" -ForegroundColor Gray
        
        try {
            $outJson = "$AbsDataDir/debug-$Phase-$sc.json"
            $nodeArgs = @(
                "$RootDir/tools/perf-check.mjs",
                "--cdp-port", "$CdpPort",
                "--phase", $Phase,
                "--scale", $sc,
                "--db-path", $dbPath,
                "--expected-db", $dbPath,
                "--expected-app-dir", $isoApp,
                "--output-json", $outJson
            )
            node @nodeArgs
            if ($LASTEXITCODE -ne 0) {
                Write-Host "perf-check.mjs failed with exit code $LASTEXITCODE" -ForegroundColor Red
            }
        } finally {
            Write-Host "Closing Debug Kal PID: $procId..." -ForegroundColor Gray
            if (-not $debugProc.HasExited) {
                $debugProc.CloseMainWindow() | Out-Null
                $debugProc.WaitForExit(3000) | Out-Null
                if (-not $debugProc.HasExited) {
                    Stop-Process -Id $procId -ErrorAction SilentlyContinue
                }
            }
        }
        Start-Sleep -Seconds 1
    }
}

# 4. Execute Release Benchmarks (Process tree memory & window creation proxy)
if ($Binary -in @("all", "release")) {
    Write-Host "`n--- Running Release Benchmarks (Process Tree & Window Creation Proxy) ---" -ForegroundColor Yellow
    
    foreach ($sc in $scalesToRun) {
        $dbPath = "$RootDir/_fixture/perf-20261015/calendar-$sc.db"
        
        # Unique GUID isolated APPDATA, retained for forensic inspection (no recursive deletions)
        $runGuid = [System.Guid]::NewGuid().ToString("N")
        $isoApp = "$PerfRunsRoot/appdata-release-$Phase-$sc-$runGuid"
        New-Item -ItemType Directory -Force -Path $isoApp | Out-Null
        
        Write-Host "Testing Release Kal for scale: $sc (APPDATA: $isoApp)..." -ForegroundColor Gray
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $ReleaseExe
        $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
        $psi.UseShellExecute = $false
        $psi.EnvironmentVariables["APPDATA"] = $isoApp
        $psi.EnvironmentVariables["KAL_DB_PATH"] = $dbPath
        
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $relProc = [System.Diagnostics.Process]::Start($psi)
        $procId = $relProc.Id
        Write-Host "Started Release Kal PID: $procId" -ForegroundColor Gray
        
        # Measure window handle creation proxy time
        $windowProxyMs = -1
        $hwnd = [IntPtr]::Zero
        for ($i = 0; $i -lt 100; $i++) {
            Start-Sleep -Milliseconds 50
            $relProc.Refresh()
            if ($relProc.MainWindowHandle -ne [IntPtr]::Zero) {
                $windowProxyMs = $sw.ElapsedMilliseconds
                $hwnd = $relProc.MainWindowHandle
                break
            }
        }
        
        Write-Host "  首次窗口句柄创建代理: ${windowProxyMs}ms (HWND=0x$($hwnd.ToString('X')))" -ForegroundColor Gray
        
        # Warmup and sample initial memory
        Start-Sleep -Seconds 2
        $initialMem = Measure-ProcessTreeMemory -rootPid $procId
        
        # Idle for 5 seconds to sample steady-state memory
        Start-Sleep -Seconds 5
        $steadyMem = Measure-ProcessTreeMemory -rootPid $procId
        
        $releaseReport = [PSCustomObject]@{
            Timestamp = [DateTime]::UtcNow.ToString("o")
            Phase = $Phase
            Scale = $sc
            Binary = "release"
            DbPath = $dbPath
            ExePath = $ReleaseExe
            IsoAppDir = $isoApp
            FirstWindowCreationProxyMs = $windowProxyMs
            WindowProxyLimitations = "该指标仅代表首个 Win32 窗口句柄已被系统创建（可能是 16x16 辅助窗口，未核验主窗类名），不能等同于 WebView2 页面可操作或冷启动完毕；Release 构建不带调试口，无页面内部时间戳。"
            InitialMemory = $initialMem
            SteadyMemory = $steadyMem
        }
        
        $outJson = "$AbsDataDir/release-$Phase-$sc.json"
        $releaseReport | ConvertTo-Json -Depth 6 | Set-Content -Path $outJson -Encoding UTF8
        Write-Host "  Release metrics saved to $outJson" -ForegroundColor Green
        Write-Host "  Main Proc: Private=$($steadyMem.MainProcess.PrivateBytesMB)MB, WS=$($steadyMem.MainProcess.WorkingSetMB)MB" -ForegroundColor Gray
        Write-Host "  Tree ($($steadyMem.ProcessCount) procs): Total Private Commit=$($steadyMem.TotalPrivateBytesMB)MB, WS Sum=$($steadyMem.TotalWorkingSetMB)MB" -ForegroundColor Gray
        
        # Clean shutdown
        Write-Host "Closing Release Kal PID: $procId..." -ForegroundColor Gray
        if (-not $relProc.HasExited) {
            $relProc.CloseMainWindow() | Out-Null
            $relProc.WaitForExit(3000) | Out-Null
            if (-not $relProc.HasExited) {
                Stop-Process -Id $procId -ErrorAction SilentlyContinue
            }
        }
        Start-Sleep -Seconds 1
    }
}

# If running AFTER phase, automatically generate before-vs-after comparison summary
if ($Phase -eq "after") {
    Write-Host "`n--- Generating Before vs After Automated Summary ---" -ForegroundColor Cyan
    node "$RootDir/tools/compare-results.mjs" --data-dir $AbsDataDir
}

Write-Host "`n=== Benchmarking Completed for Phase: $Phase ===" -ForegroundColor Green
