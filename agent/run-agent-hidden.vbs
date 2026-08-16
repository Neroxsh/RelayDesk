Option Explicit

Dim arguments
Dim command
Dim fileSystem
Dim launcherDirectory
Dim powerShell
Dim runner
Dim shell
Dim value

Function QuoteArgument(argument)
  QuoteArgument = Chr(34) & Replace(CStr(argument), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

Set arguments = WScript.Arguments
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

launcherDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
runner = fileSystem.BuildPath(launcherDirectory, "run-agent.ps1")
powerShell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"

command = QuoteArgument(powerShell) & _
  " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & _
  QuoteArgument(runner)

For Each value In arguments
  command = command & " " & QuoteArgument(value)
Next

WScript.Quit shell.Run(command, 0, True)
