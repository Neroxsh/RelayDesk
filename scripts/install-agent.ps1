param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern("^https?://")]
  [string]$RelayUrl
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot "run-agent.ps1"
$relay = $RelayUrl.TrimEnd("/")

if ($relay -notmatch "^https://" -and $relay -notmatch "^http://(127\.0\.0\.1|localhost)(:\d+)?$") {
  throw "公网中继必须使用 HTTPS。"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "未找到 Node.js，请先安装 Node.js 22 或更高版本。"
}

$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$startupCommand = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -RelayUrl `"$relay`""
Set-ItemProperty -Path $runKey -Name "RelayDeskAgent" -Value $startupCommand

Set-Location -LiteralPath $projectRoot
& node ".\agent\index.mjs" pair --relay $relay

Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
  "-NoProfile",
  "-WindowStyle", "Hidden",
  "-ExecutionPolicy", "Bypass",
  "-File", $runner,
  "-RelayUrl", $relay
)
