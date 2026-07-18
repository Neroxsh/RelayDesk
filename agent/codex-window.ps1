param(
  [Parameter(Mandatory = $true)]
  [string]$PromptBase64,
  [switch]$DryRun
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
  $all = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Subtree,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $document = $all | Where-Object {
    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document -and
    $_.Current.Name -eq "Codex"
  } | Select-Object -First 1
  if (-not $document) { throw "The current window is not Codex" }

  $composer = $all | Where-Object {
    $_.Current.ClassName -eq "ProseMirror" -and
    $_.Current.IsKeyboardFocusable -and
    -not $_.Current.IsOffscreen
  } | Sort-Object { $_.Current.BoundingRectangle.Y } -Descending | Select-Object -First 1
  if (-not $composer) { throw "The current Codex composer was not found" }
  if ($DryRun) {
    $bounds = $composer.Current.BoundingRectangle
    [PSCustomObject]@{ ok = $true; window = "Codex"; composer = "ProseMirror"; width = [int]$bounds.Width; height = [int]$bounds.Height } | ConvertTo-Json -Compress
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
    $savedClipboard = [System.Windows.Forms.Clipboard]::GetDataObject()
    [System.Windows.Forms.Clipboard]::SetText($prompt)
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 180
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 160
  } finally {
    if ($null -ne $savedClipboard) {
      [System.Windows.Forms.Clipboard]::SetDataObject($savedClipboard, $true)
    } else {
      [System.Windows.Forms.Clipboard]::Clear()
    }
    if ($attached) {
      [void][RelayDeskNative]::AttachThreadInput($currentThread, $targetThread, $false)
    }
  }
  [PSCustomObject]@{ ok = $true; window = "Codex" } | ConvertTo-Json -Compress
} catch {
  [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
