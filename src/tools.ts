// 🔧 TOOLS
//
// A tool has two halves that live in different places:
//   1. The DEFINITION (name, description, input schema). This is sent to the
//      model on every call. It is the only thing the model knows about the
//      tool: it can ask for it, but it can't run anything.
//   2. The IMPLEMENTATION (runTool below). This is ordinary code that runs in
//      the harness, on your machine, when the model asks for a tool.
//
// 🌍 ENVIRONMENT: everything these functions touch (the project folder and
// the shell) exists whether or not a model is involved. Tools are the only way
// the model can observe or change it.

import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";

// The environment is the folder you ran the agent from.
export const ROOT = process.cwd();
const MAX_OUTPUT = 10_000; // characters; long results waste context and money
const SKIP_DIRS = new Set(["node_modules", ".git"]);

// --- Definitions: what the model sees -------------------------------------
// There is no `execute` function here on purpose. Without one, the AI SDK
// just hands the tool calls back to us, so our harness decides what runs.
export const toolDefinitions = {
  list_files: tool({
    description: "List all files in the project recursively (skips node_modules and .git).",
    inputSchema: z.object({ path: z.string().describe("Directory, relative to the project root. Use '.' for the root.") }),
  }),
  read_file: tool({
    description: "Read a file. Returns its contents with line numbers.",
    inputSchema: z.object({ path: z.string() }),
  }),
  write_file: tool({
    description: "Create a new file, or overwrite an existing one with the given content.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
  }),
  edit_file: tool({
    description:
      "Replace an exact string in a file with a new string. old_string must appear exactly once, " +
      "so include enough surrounding lines to make it unique.",
    inputSchema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
  }),
  search: tool({
    description: "Search for text across all project files, like grep. Returns file:line: matches.",
    inputSchema: z.object({ query: z.string().describe("Plain text to search for (case-sensitive).") }),
  }),
  run_command: tool({
    description: "Run a shell command in the project root (60s timeout). Returns stdout, stderr and exit code.",
    inputSchema: z.object({ command: z.string() }),
  }),
};

// --- Guardrails ------------------------------------------------------------

// Resolve a path the model gave us and refuse anything outside the project.
// The model can ask for "../../etc/passwd"; the harness says no.
function safePath(p: string): string {
  const full = path.resolve(ROOT, p);
  const rel = path.relative(ROOT, full);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Path "${p}" is outside the project folder, access denied.`);
  }
  return full;
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return text.slice(0, MAX_OUTPUT) + `\n... [truncated ${text.length - MAX_OUTPUT} characters]`;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(path.relative(ROOT, full));
  }
  return files;
}

// --- Implementations: what actually runs ----------------------------------
// Each one returns a string, which becomes the tool result the model reads.
// Throwing is fine: the agent loop catches it and sends the message back.
export async function runTool(name: string, input: any): Promise<string> {
  switch (name) {
    case "list_files":
      return truncate(walk(safePath(input.path)).join("\n") || "(no files)");

    case "read_file": {
      const lines = fs.readFileSync(safePath(input.path), "utf8").split("\n");
      return truncate(lines.map((line, i) => `${String(i + 1).padStart(4)}  ${line}`).join("\n"));
    }

    case "write_file": {
      const file = safePath(input.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, input.content);
      return `Wrote ${input.content.length} characters to ${input.path}`;
    }

    case "edit_file": {
      const file = safePath(input.path);
      const text = fs.readFileSync(file, "utf8");
      const count = text.split(input.old_string).length - 1;
      if (count === 0) throw new Error(`old_string not found in ${input.path}. Read the file and copy the text exactly.`);
      if (count > 1) throw new Error(`old_string appears ${count} times in ${input.path}. Include more context to make it unique.`);
      fs.writeFileSync(file, text.replace(input.old_string, () => input.new_string));
      return `Edited ${input.path}`;
    }

    case "search": {
      const matches: string[] = [];
      for (const file of walk(ROOT)) {
        const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
        lines.forEach((line, i) => {
          if (line.includes(input.query)) matches.push(`${file}:${i + 1}: ${line.trim()}`);
        });
      }
      return truncate(matches.join("\n") || "No matches.");
    }

    case "run_command":
      return new Promise((resolve) => {
        exec(input.command, { cwd: ROOT, timeout: 60_000 }, (error, stdout, stderr) => {
          const exitCode = error ? (error.killed ? "killed (60s timeout)" : error.code) : 0;
          resolve(truncate(`exit code: ${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
        });
      });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Tools that change the environment need a human's OK first (see agent.ts).
export const NEEDS_PERMISSION = new Set(["write_file", "edit_file", "run_command"]);
