param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern("^https?://")]
  [string]$RelayUrl,

  [Parameter(Mandatory = $true)]
  [string]$NodePath,

  [Parameter(Mandatory = $true)]
  [string]$AgentPath
)

$ErrorActionPreference = "Stop"
$taskName = "RelayDeskAgent"
$relay = $RelayUrl.TrimEnd("/")
$node = (Resolve-Path -LiteralPath $NodePath).Path
$agent = (Resolve-Path -LiteralPath $AgentPath).Path
$runner = Join-Path (Split-Path -Parent $agent) "run-agent.ps1"

if ($relay -notmatch "^https://" -and $relay -notmatch "^http://(127\.0\.0\.1|localhost)(:\d+)?$") {
  throw "Public relay URLs must use HTTPS."
}

$actionArguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -RelayUrl "{1}" -NodePath "{2}" -AgentPath "{3}"' -f $runner, $relay, $node, $agent
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArguments -WorkingDirectory (Split-Path -Parent $agent)
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$healthTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 2)
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger @($logonTrigger, $healthTrigger) `
  -Settings $settings `
  -Description "Keeps the RelayDesk desktop connection online" `
  -Force | Out-Null

$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
Remove-ItemProperty -Path $runKey -Name $taskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $taskName
