$ErrorActionPreference = "Stop"
& (Join-Path (Split-Path -Parent $PSScriptRoot) "agent\install-ccswitch-cli.ps1")
