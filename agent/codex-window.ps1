param(
  [Parameter(Mandatory = $true)]
  [string]$PromptBase64,
  [switch]$DryRun,
  [switch]$ValidatePaste
)

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.ComponentModel;
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
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);

  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public InputUnion data; }
  [StructLayout(LayoutKind.Explicit)]
  struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mouse;
    [FieldOffset(0)] public KEYBDINPUT keyboard;
    [FieldOffset(0)] public HARDWAREINPUT hardware;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint flags; public uint time; public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT {
    public ushort virtualKey; public ushort scanCode; public uint flags; public uint time; public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct HARDWAREINPUT { public uint message; public ushort parameterLow; public ushort parameterHigh; }

  public static void SendKeys(ushort[] keys) {
    INPUT[] inputs = new INPUT[keys.Length * 2];
    for (int index = 0; index < keys.Length; index++) {
      inputs[index] = new INPUT {
        type = 1,
        data = new InputUnion { keyboard = new KEYBDINPUT { virtualKey = keys[index] } }
      };
      int releaseIndex = keys.Length + (keys.Length - index - 1);
      inputs[releaseIndex] = new INPUT {
        type = 1,
        data = new InputUnion { keyboard = new KEYBDINPUT { virtualKey = keys[index], flags = 2 } }
      };
    }
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows blocked keyboard input");
  }
}
"@

try {
  $prompt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PromptBase64))
  if ([string]::IsNullOrWhiteSpace($prompt)) { throw "Prompt is empty" }

  function Get-ComposerText($element, [switch]$AllowUnavailable) {
    try {
      $pattern = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
      $text = $pattern.DocumentRange.GetText(4096).Trim()
    } catch {
      if ($AllowUnavailable) { return "" }
      throw
    }
    $textBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
    if ($textBase64 -in @(
      "6KaB5rGC5ZCO57ut5Y+Y5pu0",
      "UmVxdWVzdCBmb2xsb3ctdXAgY2hhbmdlcw==",
      "UmVxdWVzdCBjaGFuZ2Vz",
      "57uZIENvZGV4IOWPkeS4gOadoeaMh+S7pOKApg==",
      "57uZIENvZGV4IOWPkeS4gOadoeaMh+S7pC4uLg==",
      "QXNrIENvZGV4",
      "V29yayB3aXRoIENoYXRHUFQ="
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

  function Send-VirtualKeys([uint16[]]$Keys) {
    [RelayDeskNative]::SendKeys($Keys)
    Start-Sleep -Milliseconds 80
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
    }
    if ($busy -and -not $DryRun) {
      $composer = $null
    }
    if ($document -and $composer) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  if (-not $document) { throw "The current window is not Codex" }
  if (-not $composer) {
    throw "Codex is still busy and its composer is unavailable"
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
  $clipboardTouched = $false
  try {
    [void][RelayDeskNative]::ShowWindowAsync($app.MainWindowHandle, 9)
    [void][RelayDeskNative]::BringWindowToTop($app.MainWindowHandle)
    [void][RelayDeskNative]::SetForegroundWindow($app.MainWindowHandle)
    Start-Sleep -Milliseconds 180
    $composer.SetFocus()
    Start-Sleep -Milliseconds 100
    # Remote input always replaces any unsent local draft. Do not try to classify,
    # back up, or validate the old text because UI Automation can expose placeholder
    # copy as document text even when the composer is visually empty.
    Send-VirtualKeys @(0x11, 0x41)
    Send-VirtualKeys @(0x08)
    Start-Sleep -Milliseconds 120
    $savedClipboard = Invoke-ClipboardRetry { [System.Windows.Forms.Clipboard]::GetDataObject() }
    Invoke-ClipboardRetry { [System.Windows.Forms.Clipboard]::SetText($prompt) } | Out-Null
    $clipboardTouched = $true
    Send-VirtualKeys @(0x11, 0x56)
    Start-Sleep -Milliseconds 180
    if ($ValidatePaste) {
      $visibleText = Get-ComposerText $composer
      if (-not $visibleText.Contains($prompt)) { throw "Codex did not receive the pasted text" }
      Send-VirtualKeys @(0x11, 0x41)
      Send-VirtualKeys @(0x08)
    } else {
      # A UI Automation Invoke can start a task without updating Codex's visible
      # conversation state. Submit through the focused composer just like a user.
      $composer.SetFocus()
      Send-VirtualKeys @(0x0D)
      Start-Sleep -Milliseconds 500
      # Codex replaces the composer element as soon as a message is accepted. A stale
      # automation element here means the submit succeeded, not that the request failed.
      $remaining = Get-ComposerText $composer -AllowUnavailable
      if ($remaining.Contains($prompt)) { throw "Codex kept the remote message as a draft instead of sending it" }
    }
    Start-Sleep -Milliseconds 160
  } finally {
    if ($clipboardTouched) {
      try {
        if ($null -ne $savedClipboard) {
          Invoke-ClipboardRetry { [System.Windows.Forms.Clipboard]::SetDataObject($savedClipboard, $true) } | Out-Null
        } else {
          Invoke-ClipboardRetry { [System.Windows.Forms.Clipboard]::Clear() } | Out-Null
        }
      } catch { }
    }
    if ($attached) {
      [void][RelayDeskNative]::AttachThreadInput($currentThread, $targetThread, $false)
    }
  }
  [PSCustomObject]@{ ok = $true; window = "Codex"; pasteValidated = [bool]$ValidatePaste; draftCleared = $true } | ConvertTo-Json -Compress
} catch {
  [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
