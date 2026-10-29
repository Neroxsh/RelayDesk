import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
const execute = promisify(execFile);

export async function findClaudeParent(parentPid = process.ppid) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return null;
  if (process.platform === "win32") {
    const script = `$items=Get-CimInstance Win32_Process; $nextId=${parentPid}; for($i=0;$i -lt 6;$i++){ $row=$items | Where-Object ProcessId -eq $nextId | Select-Object -First 1; if(-not $row){break}; if($row.Name -eq 'claude.exe'){ @{pid=[int]$row.ProcessId; startedAt=([DateTimeOffset]$row.CreationDate).ToUnixTimeMilliseconds()} | ConvertTo-Json -Compress; break }; $nextId=[int]$row.ParentProcessId }`;
    try { const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 6000 }); return JSON.parse(stdout); } catch { return null; }
  }
  let pid = parentPid;
  for (let i = 0; i < 6; i++) {
    try {
      const { stdout } = await execute("ps", ["-p", String(pid), "-o", "ppid=,comm="], { timeout: 2000 });
      const match = stdout.trim().match(/^(\d+)\s+(.+)$/); if (!match) break;
      if (/(?:^|\/)claude(?:\.exe)?$/.test(match[2])) return { pid, startedAt: Date.now() };
      pid = Number(match[1]);
    } catch { break; }
  }
  return null;
}

export async function verifyClaudeProcess(pid, startedAt) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === "win32") {
    const script = `$row=Get-Process -Id ${pid} -ErrorAction Stop; if($row.ProcessName -eq 'claude' -and [Math]::Abs(([DateTimeOffset]$row.StartTime).ToUnixTimeMilliseconds()-${Math.trunc(startedAt)}) -lt 2000){'ok'}`;
    try { return (await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 4000 })).stdout.trim() === "ok"; } catch { return false; }
  }
  try { return /claude/.test(await readFile(`/proc/${pid}/comm`, "utf8")); } catch { return true; }
}
