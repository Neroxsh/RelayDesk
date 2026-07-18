param(
  [Parameter(Mandatory = $true)]
  [string]$PromptBase64,
  [switch]$DryRun,
  [switch]$ValidatePaste,
  [switch]$StashDraft
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RelayDeskNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint currentThread, uint targetThread, bool attach);
}
"@

try {
  $prompt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PromptBase64))
  if ([string]::IsNullOrWhiteSpace($prompt)) { throw "Prompt is empty" }

  function Get-ComposerText($element) {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    $text = $pattern.DocumentRange.GetText(4096).Trim()
    $textBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
    if ($textBase64 -in @(
      "6KaB5rGC5ZCO57ut5Y+Y5pu0",
      "UmVxdWVzdCBmb2xsb3ctdXAgY2hhbmdlcw==",
      "UmVxdWVzdCBjaGFuZ2Vz",
      "57uZIENvZGV4IOWPkeS4gOadoeaMh+S7pOKApg==",
      "57uZIENvZGV4IOWPkeS4gOadoeaMh+S7pC4uLg==",
      "QXNrIENvZGV4"
    )) { return "" }
    return $text
  }

  function Invoke-ClipboardRetry([scriptblock]$Action) {
    $lastError = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      try { return (& $Action) } catch {
        $lastError = $_
        Start-Sleep -Milliseconds 100
      }
    }
    throw $lastError
  }

  $app = Get-Process -Name "ChatGPT" -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
  if (-not $app) { throw "No open Codex window was found" }

  [void][RelayDeskNative]::ShowWindowAsync($app.MainWindowHandle, 9)
  [void][RelayDeskNative]::SetForegroundWindow($app.MainWindowHandle)
  Start-Sleep -Milliseconds 320

  $renderHandle = [IntPtr]::Zero
  $callback = [RelayDeskNative+EnumWindowsProc]{
    param($handle, $state)
    $className = New-Object Text.StringBuilder 256
    [void][RelayDeskNative]::GetClassName($handle, $className, 256)
    if ($className.ToString() -eq "Chrome_RenderWidgetHostHWND") {
      $script:renderHandle = $handle
      return $false
    }
    return $true
  }
  [void][RelayDeskNative]::EnumChildWindows($app.MainWindowHandle, $callback, [IntPtr]::Zero)
  $automationHandle = if ($renderHandle -ne [IntPtr]::Zero) { $renderHandle } else { $app.MainWindowHandle }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($automationHandle)
  $document = $null
  $composer = $null
  $blockedByDraft = $false
  $busy = $false
  $draftLength = 0
  $deadline = (Get-Date).AddSeconds(120)
  do {
    $all = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Subtree,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    $document = $all | Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document -and
      $_.Current.Name -eq "Codex"
    } | Select-Object -First 1
    $composer = $all | Where-Object {
      $_.Current.ClassName -like "ProseMirror*" -and
      $_.Current.IsKeyboardFocusable -and
      -not $_.Current.IsOffscreen
    } | Sort-Object { $_.Current.BoundingRectangle.Y } -Descending | Select-Object -First 1
    $busy = @($all | Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
      -not $_.Current.IsOffscreen -and
      $_.Current.Name -match '^(停止|Stop)$'
    }).Count -gt 0
    if ($composer) {
      $existingDraft = Get-ComposerText $composer
      $draftLength = $existingDraft.Length
      if ($existingDraft -and -not $DryRun -and -not $StashDraft) {
        $blockedByDraft = $true
        $composer = $null
        break
      }
    }
    if ($busy -and -not $DryRun -and -not $StashDraft) {
      $composer = $null
    }
    if ($document -and $composer) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  if (-not $document) { throw "The current window is not Codex" }
  if (-not $composer) {
    if ($blockedByDraft) { throw "Codex has unsent text in its composer; the remote message was not mixed into it" }
    throw "Codex is still busy and its composer is unavailable"
  }
  if ($StashDraft) {
    $backupPath = $null
    if ($existingDraft) {
      $backupDirectory = Join-Path $env:USERPROFILE ".relaydesk\draft-backups"
      [void](New-Item -ItemType Directory -Path $backupDirectory -Force)
      $backupPath = Join-Path $backupDirectory ("codex-draft-{0}.txt" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
      [IO.File]::WriteAllText($backupPath, $existingDraft, (New-Object Text.UTF8Encoding($false)))
      [uint32]$stashTargetProcess = 0
      $stashTargetThread = [RelayDeskNative]::GetWindowThreadProcessId($app.MainWindowHandle, [ref]$stashTargetProcess)
      $stashCurrentThread = [RelayDeskNative]::GetCurrentThreadId()
      $stashAttached = $false
      try {
        if ($stashTargetThread -ne 0 -and $stashTargetThread -ne $stashCurrentThread) {
          $stashAttached = [RelayDeskNative]::AttachThreadInput($stashCurrentThread, $stashTargetThread, $true)
        }
        [void][RelayDeskNative]::ShowWindowAsync($app.MainWindowHandle, 9)
        [void][RelayDeskNative]::BringWindowToTop($app.MainWindowHandle)
        [void][RelayDeskNative]::SetForegroundWindow($app.MainWindowHandle)
        Start-Sleep -Milliseconds 180
        $composer.SetFocus()
        Start-Sleep -Milliseconds 100
        [System.Windows.Forms.SendKeys]::SendWait("^a")
        [System.Windows.Forms.SendKeys]::SendWait("{BACKSPACE}")
        Start-Sleep -Milliseconds 250
      } finally {
        if ($stashAttached) {
          [void][RelayDeskNative]::AttachThreadInput($stashCurrentThread, $stashTargetThread, $false)
        }
      }
      $remainingDraft = Get-ComposerText $composer
      if ($remainingDraft) { throw "Codex draft was backed up but could not be cleared" }
    }
    [PSCustomObject]@{ ok = $true; stashed = [bool]$existingDraft; path = $backupPath } | ConvertTo-Json -Compress
    exit 0
  }
  if ($DryRun) {
    $bounds = $composer.Current.BoundingRectangle
    [PSCustomObject]@{ ok = $true; window = "Codex"; composer = "ProseMirror"; width = [int]$bounds.Width; height = [int]$bounds.Height; draftLength = $draftLength; busy = $busy } | ConvertTo-Json -Compress
    exit 0
  }

  [uint32]$targetProcess = 0
  $targetThread = [RelayDeskNative]::GetWindowThreadProcessId($app.MainWindowHandle, [ref]$targetProcess)
  $currentThread = [RelayDeskNative]::GetCurrentThreadId()
  $attached = $false
  if ($targetThread -ne 0 -and $targetThread -ne $currentThread) {
    $attached = [RelayDeskNative]::AttachThreadInput($currentThread, $targetThread, $true)
  }
  $savedClipboard = $null
  try {
    [void][RelayDeskNative]::ShowWindowAsync($app.MainWindowHandle, 9)
    [void][RelayDeskNative]::BringWindowToTop($app.MainWindowHandle)
    [void][RelayDeskNative]::SetForegroundWindow($app.MainWindowHandle)
    Start-Sleep -Milliseconds 180
    $composer.SetFocus()
    Start-Sleep -Milliseconds 100
    $savedClipboard = Invoke-ClipboardRetry { [System.Windows.Forms.Clipboard]::GetDataObject() }
    Invoke-ClipboardRetry { [System.Windows.Forms.Clipboard]::SetText($prompt) } | Out-Null
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 180
    if ($ValidatePaste) {
      $visibleText = Get-ComposerText $composer
      if (-not $visibleText.Contains($prompt)) { throw "Codex did not receive the pasted text" }
      [System.Windows.Forms.SendKeys]::SendWait("^a")
      [System.Windows.Forms.SendKeys]::SendWait("{BACKSPACE}")
    } else {
      $updated = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Subtree,
        [System.Windows.Automation.Condition]::TrueCondition
      )
      $sendButton = $updated | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
        -not $_.Current.IsOffscreen -and
        $_.Current.Name -match '^(发送|发送消息|Send|Submit)$'
      } | Select-Object -First 1
      if ($sendButton) {
        $invoke = $sendButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $invoke.Invoke()
      } else {
        [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
      }
      Start-Sleep -Milliseconds 500
      $remaining = Get-ComposerText $composer
      if ($remaining.Contains($prompt)) { throw "Codex kept the remote message as a draft instead of sending it" }
    }
    Start-Sleep -Milliseconds 160
  } finally {
    try {
      if ($null -ne $savedClipboard) {
        Invoke-ClipboardRetry { [System.Windows.Forms.Clipboard]::SetDataObject($savedClipboard, $true) } | Out-Null
      } else {
        Invoke-ClipboardRetry { [System.Windows.Forms.Clipboard]::Clear() } | Out-Null
      }
    } catch { }
    if ($attached) {
      [void][RelayDeskNative]::AttachThreadInput($currentThread, $targetThread, $false)
    }
  }
  [PSCustomObject]@{ ok = $true; window = "Codex"; pasteValidated = [bool]$ValidatePaste } | ConvertTo-Json -Compress
} catch {
  [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
