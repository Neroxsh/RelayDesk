#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const setup = path.join(root, "scripts", "setup.mjs");
const agent = path.join(root, "agent", "index.mjs");
const command = process.argv[2] ?? "setup";
const args = process.argv.slice(3);

const target = command === "setup"
  ? [setup, ...args]
  : [agent, ["start", "control", "pair"].includes(command) ? command : "start", ...args];

const child = spawn(process.execPath, target, { cwd: root, stdio: "inherit", windowsHide: false });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
