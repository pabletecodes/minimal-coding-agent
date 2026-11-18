// Helpers the tools share: where the environment is, the guardrails that keep
// the model inside it, and a file walker.

import fs from "node:fs";
import path from "node:path";

// 🌍 The environment is the folder you ran the agent from.
export const ENVIRONMENT_ROOT = process.cwd();
const MAX_OUTPUT = 10_000; // characters; long results waste context and money
const SKIP_DIRS = new Set(["node_modules", ".git"]);

// --- Guardrails: limits the harness enforces, whatever the model asks for ---

// Resolve a path the model gave us and refuse anything outside the project.
// The model can ask for "../../etc/passwd"; the harness says no.
export function safePath(p: string): string {
  const full = path.resolve(ENVIRONMENT_ROOT, p);
  const rel = path.relative(ENVIRONMENT_ROOT, full);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Path "${p}" is outside the project folder, access denied.`);
  }
  return full;
}

// Cap a tool result's size, since every result is resent on every model call.
export function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return text.slice(0, MAX_OUTPUT) + `\n... [truncated ${text.length - MAX_OUTPUT} characters]`;
}

// --- Files -----------------------------------------------------------------

// Every file under `dir`, relative to the project root, skipping SKIP_DIRS.
export function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(path.relative(ENVIRONMENT_ROOT, full));
  }
  return files;
}
