param(
  [Parameter(Mandatory = $true)]
  [string]$RelayUrl
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $env:USERPROFILE ".relaydesk"
$logPath = Join-Path $logDirectory "agent.log"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
Set-Location -LiteralPath $projectRoot

while ($true) {
  try {
    & node ".\agent\index.mjs" start --relay $RelayUrl *>> $logPath
    $exitCode = $LASTEXITCODE
  } catch {
    $exitCode = -1
    "[$(Get-Date -Format o)] RelayDesk failed: $($_.Exception.Message)" | Out-File -FilePath $logPath -Append -Encoding utf8
  }
  "[$(Get-Date -Format o)] RelayDesk exited with code $exitCode; restarting in 3 seconds." | Out-File -FilePath $logPath -Append -Encoding utf8
  Start-Sleep -Seconds 3
}
