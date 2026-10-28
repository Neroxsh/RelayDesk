$ErrorActionPreference = "Stop"
$version = "5.11.2"
$archiveHash = "b588f973b4a1073c18deba3c1b4a3860737a4058923fc95a7630832bee7e2ad2"
$toolDirectory = Join-Path $env:USERPROFILE ".relaydesk\tools\cc-switch\v$version"
$archive = Join-Path $toolDirectory "cc-switch-cli-v$version-windows-x64.zip"
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
  throw "This optional adapter is verified for Windows x64 only."
}
New-Item -ItemType Directory -Path $toolDirectory -Force | Out-Null
function Get-ArchiveHash([string]$file) {
  if (-not [IO.File]::Exists($file)) { return "" }
  $stream = [IO.File]::OpenRead($file)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace("-", "").ToLowerInvariant() }
  finally { $hash.Dispose(); $stream.Dispose() }
}
if ((Get-ArchiveHash $archive) -ne $archiveHash) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $download = New-Object Net.WebClient
  try { $download.DownloadFile("https://github.com/SaladDay/cc-switch-cli/releases/download/v$version/cc-switch-cli-v$version-windows-x64.zip", $archive) }
  finally { $download.Dispose() }
}
if ((Get-ArchiveHash $archive) -ne $archiveHash) { throw "CC Switch CLI archive checksum does not match the verified release." }
[Reflection.Assembly]::LoadWithPartialName("System.IO.Compression.FileSystem") | Out-Null
$binaryDirectory = Join-Path $toolDirectory "bin"
New-Item -ItemType Directory -Path $binaryDirectory -Force | Out-Null
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  $entry = $zip.GetEntry("cc-switch.exe")
  if ($null -eq $entry) { throw "The verified archive does not contain cc-switch.exe." }
  $inputStream = $entry.Open()
  $outputStream = [IO.File]::Open((Join-Path $binaryDirectory "cc-switch.exe"), [IO.FileMode]::Create)
  try { $inputStream.CopyTo($outputStream) }
  finally { $inputStream.Dispose(); $outputStream.Dispose() }
} finally { $zip.Dispose() }
Write-Output "Installed optional CC Switch CLI $version. No provider or database was changed."
