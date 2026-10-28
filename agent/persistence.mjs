import { mkdir, open, rename, unlink, readFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export async function writeAtomicJson(filename, value, { backup = false } = {}) {
  await mkdir(path.dirname(filename), { recursive: true });
  if (backup) {
    try {
      const previous = JSON.parse(await readFile(filename, "utf8"));
      await writeAtomicJson(`${filename}.bak`, previous);
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  const temporary = `${filename}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2), "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, filename);
  } finally { await unlink(temporary).catch(() => undefined); }
}
