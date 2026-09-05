# tests/load/monitor-resources.ps1
#
# Pattern 23 (realistic load and concurrency test) — this dev machine has
# no APM/monitoring stack, so this polls what's actually observable locally
# (the e2e Node server's own CPU%/RSS, and Redis's own INFO stats for
# clients/memory/queue-ish key counts) at a fixed interval for the duration
# of one k6 profile run, appending one CSV row per sample. Point it at the
# e2e server's process id (see: netstat -ano | findstr :5001) and a label
# for which load profile is running.
#
# Usage: powershell -File tests/load/monitor-resources.ps1 -TargetPid 2936 -Label baseline -OutFile tests/load/results/baseline-resources.csv -DurationSeconds 300
param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$Label,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [int]$DurationSeconds = 300,
  [int]$IntervalSeconds = 5
)

$header = @('timestamp', 'label', 'cpu_percent', 'working_set_mb', 'redis_connected_clients', 'redis_used_memory_mb', 'redis_keyspace_hits', 'redis_keyspace_misses') -join ','
Set-Content -Path $OutFile -Value $header -Encoding utf8

function Write-Row([object[]]$fields) {
  ($fields -join ',') | Add-Content -Path $OutFile -Encoding utf8
}

$proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if (-not $proc) {
  Write-Error "No process with id $TargetPid - is the e2e server running?"
  exit 1
}
$cpuCount = [Environment]::ProcessorCount
$prevCpuTime = $proc.TotalProcessorTime
$prevSampleTime = Get-Date

$elapsed = 0
while ($elapsed -lt $DurationSeconds) {
  Start-Sleep -Seconds $IntervalSeconds
  $elapsed += $IntervalSeconds

  $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
  if (-not $proc) {
    Write-Row @((Get-Date -Format o), $Label, 'PROCESS_EXITED', '', '', '', '', '')
    break
  }

  $now = Get-Date
  $cpuTime = $proc.TotalProcessorTime
  $cpuPercent = [Math]::Round((($cpuTime - $prevCpuTime).TotalMilliseconds / ($now - $prevSampleTime).TotalMilliseconds / $cpuCount) * 100, 1)
  $prevCpuTime = $cpuTime
  $prevSampleTime = $now
  $workingSetMb = [Math]::Round($proc.WorkingSet64 / 1MB, 1)

  $redisInfo = & redis-cli -n 1 info 2>$null
  $connectedClients = ($redisInfo | Select-String '^connected_clients:(\d+)').Matches.Groups[1].Value
  $usedMemory = ($redisInfo | Select-String '^used_memory:(\d+)').Matches.Groups[1].Value
  $usedMemoryMb = if ($usedMemory) { [Math]::Round([int64]$usedMemory / 1MB, 1) } else { '' }
  $hits = ($redisInfo | Select-String '^keyspace_hits:(\d+)').Matches.Groups[1].Value
  $misses = ($redisInfo | Select-String '^keyspace_misses:(\d+)').Matches.Groups[1].Value

  Write-Row @((Get-Date -Format o), $Label, $cpuPercent, $workingSetMb, $connectedClients, $usedMemoryMb, $hits, $misses)
}
