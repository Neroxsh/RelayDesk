import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decryptJson, deriveSessionKey, encryptJson, generateDeviceKeys, sha256 } from "../agent/crypto.mjs";

test("desktop and phone derive the same end-to-end key", async () => {
  const desktop = await generateDeviceKeys();
  const phone = await generateDeviceKeys();
  const salt = sha256("284610");
  const desktopKey = await deriveSessionKey(desktop.privateKey, phone.publicKey, salt);
  const phoneKey = await deriveSessionKey(phone.privateKey, desktop.publicKey, salt);
  const envelope = await encryptJson(phoneKey, { type: "sessions:list", requestId: "test" });
  assert.deepEqual(await decryptJson(desktopKey, envelope), { type: "sessions:list", requestId: "test" });
});

test("the product ships pairing, mobile, and both provider surfaces", async () => {
  const [page, manifest, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0000_peaceful_darkstar.sql", import.meta.url), "utf8"),
  ]);
  assert.match(page, /6 位配对码/);
  assert.match(page, /Codex/);
  assert.match(page, /Claude/);
  assert.match(page, /完全控制/);
  assert.equal(JSON.parse(manifest).display, "standalone");
  assert.match(migration, /CREATE TABLE `devices`/);
  assert.match(migration, /CREATE TABLE `messages`/);
});

test("the desktop bridge never exposes an arbitrary shell command endpoint", async () => {
  const agent = await readFile(new URL("../agent/index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(agent, /payload\?\.type === ["']shell/);
  assert.match(agent, /payload\?\.type === "session:send"/);
  assert.match(agent, /prompt\.length > 12_000/);
});
