import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decryptJson, deriveSessionKey, encryptJson, generateDeviceKeys, sha256 } from "../agent/crypto.mjs";

test("desktop and phone derive the same end-to-end key", async () => {
  const desktop = await generateDeviceKeys();
  const phone = await generateDeviceKeys();
  const salt = sha256("ABCD-EFGH-JKLM-NPQR".replaceAll("-", ""));
  const desktopKey = await deriveSessionKey(desktop.privateKey, phone.publicKey, salt);
  const phoneKey = await deriveSessionKey(phone.privateKey, desktop.publicKey, salt);
  const envelope = await encryptJson(phoneKey, { type: "sessions:list", requestId: "test" });
  assert.deepEqual(await decryptJson(desktopKey, envelope), { type: "sessions:list", requestId: "test" });
});

test("the product ships permanent pairing, projects, and both provider surfaces", async () => {
  const [page, manifest, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0002_cuddly_mephistopheles.sql", import.meta.url), "utf8"),
  ]);
  assert.match(page, /永久连接密钥/);
  assert.match(page, /当前 Codex 窗口/);
  assert.match(page, /项目/);
  assert.match(page, /Codex/);
  assert.match(page, /Claude/);
  assert.match(page, /完全控制/);
  assert.equal(JSON.parse(manifest).display, "standalone");
  assert.match(migration, /pending_pairs/);
  assert.match(migration, /pair_key_hash/);
});

test("the desktop bridge never exposes an arbitrary shell command endpoint", async () => {
  const agent = await readFile(new URL("../agent/index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(agent, /payload\?\.type === ["']shell/);
  assert.match(agent, /payload\?\.type === "session:send"/);
  assert.match(agent, /prompt\.length > 12_000/);
  assert.match(agent, /message\.kind === "pair_request"/);
});

test("current-window injection is restricted to the Codex composer", async () => {
  const script = await readFile(new URL("../agent/codex-window.ps1", import.meta.url), "utf8");
  assert.match(script, /Chrome_RenderWidgetHostHWND/);
  assert.match(script, /Current\.Name -eq "Codex"/);
  assert.match(script, /Current\.ClassName -eq "ProseMirror"/);
  assert.match(script, /SendWait\("\{ENTER\}"\)/);
});
