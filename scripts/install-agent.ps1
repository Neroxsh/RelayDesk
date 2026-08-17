param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern("^https?://")]
  [string]$RelayUrl,

  [string]$SiteToken = "",

  [switch]$NoControlPanel
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $projectRoot "agent\install-agent.ps1"
$agent = Join-Path $projectRoot "agent\index.mjs"
$relay = $RelayUrl.TrimEnd("/")

if ($relay -notmatch "^https://" -and $relay -notmatch "^http://(127\.0\.0\.1|localhost)(:\d+)?$") {
  throw "Public relay URLs must use HTTPS."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22 or newer is required."
}

$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) {
  throw "Node.js 22 or newer is required."
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer `
  -RelayUrl $relay `
  -NodePath (Get-Command node).Source `
  -AgentPath $agent

Start-Sleep -Seconds 2
Set-Location -LiteralPath $projectRoot
if (-not $NoControlPanel) {
  $controlArguments = @(".\agent\index.mjs", "control", "--relay", $relay)
  if ($SiteToken) {
    $controlArguments += @("--site-token", $SiteToken)
  }
  & node @controlArguments
}
