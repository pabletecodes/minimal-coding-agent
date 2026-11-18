// 🔧 TOOLS
//
// Each tool is defined in one place, but it still has two halves:
//   1. What the MODEL sees: name, description and input schema. These are sent
//      on every call. It's all the model knows about the tool: it can ask for
//      it, but it can't run anything.
//   2. What the HARNESS runs: `run`, ordinary code that executes on your
//      machine when the model asks for the tool. It never leaves this program.
// The harness strips each tool down to half 1 before sending it to the model.
//
// 🌍 ENVIRONMENT: everything these functions touch (the project folder and
// the shell) exists whether or not a model is involved. Tools are the only way
// the model can observe or change it.

import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ENVIRONMENT_ROOT, safePath, truncate, walk } from "./utils.ts";

// --- What a tool is --------------------------------------------------------

export type Tool = {
  description: string; // for the model
  inputSchema: z.ZodType; // for the model
  needsPermission: boolean; // for the harness: ask the human before running?
  run: (input: any) => Promise<string>; // for the harness: the actual code
};

// A helper so TypeScript knows the shape of `input` inside each tool's `run`.
function defineTool<S extends z.ZodType>(t: {
  description: string;
  inputSchema: S;
  needsPermission?: boolean;
  run: (input: z.infer<S>) => string | Promise<string>;
}): Tool {
  return { ...t, needsPermission: t.needsPermission ?? false, run: async (input) => t.run(input) };
}

// --- The tools -------------------------------------------------------------

// Each `run` returns a string, which becomes the tool result the model reads.
// Throwing is fine: the harness catches it and sends the message back.
export const tools: Record<string, Tool> = {
  list_files: defineTool({
    description: "List all files in the project recursively (skips node_modules and .git).",
    inputSchema: z.object({ path: z.string().describe("Directory, relative to the project root. Use '.' for the root.") }),
    run: (input) => truncate(walk(safePath(input.path)).join("\n") || "(no files)"),
  }),

  read_file: defineTool({
    description: "Read a file. Returns its contents with line numbers.",
    inputSchema: z.object({ path: z.string() }),
    run: (input) => {
      const lines = fs.readFileSync(safePath(input.path), "utf8").split("\n");
      return truncate(lines.map((line, i) => `${String(i + 1).padStart(4)}  ${line}`).join("\n"));
    },
  }),

  write_file: defineTool({
    description: "Create a new file, or overwrite an existing one with the given content.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    needsPermission: true,
    run: (input) => {
      const file = safePath(input.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, input.content);
      return `Wrote ${input.content.length} characters to ${input.path}`;
    },
  }),

  edit_file: defineTool({
    description:
      "Replace an exact string in a file with a new string. old_string must appear exactly once, " +
      "so include enough surrounding lines to make it unique.",
    inputSchema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
    needsPermission: true,
    run: (input) => {
      const file = safePath(input.path);
      const text = fs.readFileSync(file, "utf8");
      const count = text.split(input.old_string).length - 1;
      if (count === 0) throw new Error(`old_string not found in ${input.path}. Read the file and copy the text exactly.`);
      if (count > 1) throw new Error(`old_string appears ${count} times in ${input.path}. Include more context to make it unique.`);
      fs.writeFileSync(file, text.replace(input.old_string, () => input.new_string));
      return `Edited ${input.path}`;
    },
  }),

  search: defineTool({
    description: "Search for text across all project files, like grep. Returns file:line: matches.",
    inputSchema: z.object({ query: z.string().describe("Plain text to search for (case-sensitive).") }),
    run: (input) => {
      const matches: string[] = [];
      for (const file of walk(ENVIRONMENT_ROOT)) {
        const lines = fs.readFileSync(path.join(ENVIRONMENT_ROOT, file), "utf8").split("\n");
        lines.forEach((line, i) => {
          if (line.includes(input.query)) matches.push(`${file}:${i + 1}: ${line.trim()}`);
        });
      }
      return truncate(matches.join("\n") || "No matches.");
    },
  }),

  run_command: defineTool({
    description: "Run a shell command in the project root (60s timeout). Returns stdout, stderr and exit code.",
    inputSchema: z.object({ command: z.string() }),
    needsPermission: true,
    run: (input) =>
      new Promise((resolve) => {
        exec(input.command, { cwd: ENVIRONMENT_ROOT, timeout: 60_000 }, (error, stdout, stderr) => {
          const exitCode = error ? (error.killed ? "killed (60s timeout)" : error.code) : 0;
          resolve(truncate(`exit code: ${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
        });
      }),
  }),
};
