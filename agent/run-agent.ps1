param(
  [Parameter(Mandatory = $true)]
  [string]$RelayUrl,

  [Parameter(Mandatory = $true)]
  [string]$NodePath,

  [Parameter(Mandatory = $true)]
  [string]$AgentPath
)

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
if ($env:HTTP_PROXY -or $env:HTTPS_PROXY -or $env:http_proxy -or $env:https_proxy) {
  $env:NODE_USE_ENV_PROXY = "1"
}

$logDirectory = Join-Path $env:USERPROFILE ".relaydesk"
$logPath = Join-Path $logDirectory "agent.log"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

while ($true) {
  try {
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 8MB) {
      $archivePath = Join-Path $logDirectory ("agent-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
      Move-Item -LiteralPath $logPath -Destination $archivePath
    }
    & $NodePath $AgentPath start --relay $RelayUrl 2>&1 |
      ForEach-Object { $_.ToString() } |
      Out-File -FilePath $logPath -Append -Encoding utf8
    $exitCode = $LASTEXITCODE
  } catch {
    $exitCode = -1
    "[$(Get-Date -Format o)] RelayDesk failed: $($_.Exception.Message)" |
      Out-File -FilePath $logPath -Append -Encoding utf8
  }
  "[$(Get-Date -Format o)] RelayDesk exited with code $exitCode; restarting in 3 seconds." |
    Out-File -FilePath $logPath -Append -Encoding utf8
  Start-Sleep -Seconds 3
}
