param(
  [Parameter(Mandatory = $true)]
  [string]$RelayUrl
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $env:USERPROFILE ".relaydesk"
$logPath = Join-Path $logDirectory "agent.log"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
Set-Location -LiteralPath $projectRoot
& node ".\agent\index.mjs" start --relay $RelayUrl *>> $logPath
