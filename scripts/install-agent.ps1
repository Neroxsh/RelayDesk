param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern("^https?://")]
  [string]$RelayUrl,

  [string]$SiteToken = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot "run-agent.ps1"
$relay = $RelayUrl.TrimEnd("/")

if ($relay -notmatch "^https://" -and $relay -notmatch "^http://(127\.0\.0\.1|localhost)(:\d+)?$") {
  throw "Public relay URLs must use HTTPS."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22 or newer is required."
}

$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$startupCommand = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -RelayUrl `"$relay`""
Set-ItemProperty -Path $runKey -Name "RelayDeskAgent" -Value $startupCommand

Set-Location -LiteralPath $projectRoot
$pairArguments = @(".\agent\index.mjs", "pair", "--relay", $relay)
if ($SiteToken) {
  $pairArguments += @("--site-token", $SiteToken)
}
& node @pairArguments

Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
  "-NoProfile",
  "-WindowStyle", "Hidden",
  "-ExecutionPolicy", "Bypass",
  "-File", $runner,
  "-RelayUrl", $relay
)
