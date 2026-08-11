param(
  [Parameter(Mandatory = $true)]
  [string]$RelayUrl,

  [Parameter(Mandatory = $true)]
  [string]$NodePath,

  [Parameter(Mandatory = $true)]
  [string]$AgentPath
)

$logDirectory = Join-Path $env:USERPROFILE ".relaydesk"
$logPath = Join-Path $logDirectory "agent.log"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

while ($true) {
  try {
    & $NodePath $AgentPath start --relay $RelayUrl 2>&1 |
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
