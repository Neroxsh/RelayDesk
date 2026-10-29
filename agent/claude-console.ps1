param([Parameter(Mandatory=$true)][int]$ClaudePid,[Parameter(Mandatory=$true)][long]$StartedAt,[ValidateSet('probe','escape')][string]$Action='probe')
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class RelayDeskClaudeConsole {
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint id);
 [DllImport("kernel32.dll")] static extern bool FreeConsole();
 [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList([Out] uint[] list,uint size);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [StructLayout(LayoutKind.Explicit,Size=20,CharSet=CharSet.Unicode)] struct InputRecord {
  [FieldOffset(0)] public ushort Type; [FieldOffset(4)] public int Down;
  [FieldOffset(8)] public ushort Repeat; [FieldOffset(10)] public ushort Key;
  [FieldOffset(12)] public ushort Scan; [FieldOffset(14)] public char Character;
  [FieldOffset(16)] public uint Control;
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool WriteConsoleInputW(SafeFileHandle handle,InputRecord[] records,uint count,out uint written);
 static bool Matches(Process p,long start) { return !p.HasExited && p.ProcessName.Equals("claude",StringComparison.OrdinalIgnoreCase) && Math.Abs(new DateTimeOffset(p.StartTime).ToUnixTimeMilliseconds()-start)<2000; }
 public static bool Run(int pid,long start,bool escape) {
  using(var p=Process.GetProcessById(pid)) {
   if(!Matches(p,start)) return false;
   FreeConsole();
   if(!AttachConsole((uint)pid)) return false;
   try {
    var ids=new uint[64]; uint count=GetConsoleProcessList(ids,(uint)ids.Length); bool found=false;
    for(int i=0;i<Math.Min(count,ids.Length);i++) if(ids[i]==pid) found=true;
    if(!found || !Matches(p,start)) return false;
    if(!escape) return true;
    using(var input=CreateFile("CONIN$",0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero)) {
     if(input.IsInvalid || !Matches(p,start)) return false;
     var records=new InputRecord[]{new InputRecord{Type=1,Down=1,Repeat=1,Key=27,Scan=1,Character=(char)27},new InputRecord{Type=1,Down=0,Repeat=1,Key=27,Scan=1,Character=(char)27}};
     uint written; return WriteConsoleInputW(input,records,2,out written)&&written==2;
    }
   } finally { FreeConsole(); }
  }
 }
}
'@
try { $ok=[RelayDeskClaudeConsole]::Run($ClaudePid,$StartedAt,($Action -eq 'escape')); @{ok=$ok} | ConvertTo-Json -Compress }
catch { @{ok=$false} | ConvertTo-Json -Compress }
