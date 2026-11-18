// A minimal coding agent, small enough to read in one sitting.
//
// Usage (from inside any project folder):
//   npx tsx path/to/src/agent.ts "Add a test for the add function and make it pass"
//   npx tsx path/to/src/agent.ts            (interactive mode: asks you for tasks)
//
// THE CONCEPTS
//
// 🧠 Model: the LLM. One call = one decision: given everything so far, either
//    answer in text or ask for some tools to be run. It keeps no memory between
//    calls; anything it "remembers" is because we sent it again.
//
// 🧰 Harness: this program. It owns the loop, calls the model, runs the tools,
//    asks you for permission and enforces limits (MAX_STEPS, path checks,
//    timeouts, output truncation). The model proposes; the harness disposes.
//
// 🔧 Tools: the definitions the model sees (name, description, input schema)
//    and, separately, the code that actually runs them. Both live in tools.ts.
//
// 🌍 Environment: the project folder and the shell. They exist independently
//    of the model, which can only see and change them through tools.
//
// 📋 Context: the `messages` array. Every model reply and every tool result is
//    appended, and the whole array is resent on every call. It only grows.
//
// 🤖 Agent: all of the above together working on a task, in a loop:
//    call model -> run requested tools -> append results -> repeat.
//
// 🔒 Permissions: the model can't be trusted to police itself (it can be wrong,
//    or tricked by text it read in a file). So the harness, which runs the
//    code, decides what's allowed, and asks you before anything risky happens.

import readline from "node:readline/promises";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, type ModelMessage, type ToolResultPart } from "ai";
import { NEEDS_PERMISSION, ROOT, runTool, toolDefinitions } from "./tools.ts";

const MODEL = "claude-sonnet-5-5"; // change this to try another model
const MAX_STEPS = 30; // a hard limit so a confused agent can't loop forever

// Credentials: an API key (sent as x-api-key) or an OAuth token (sent as
// Authorization: Bearer). The SDK reads ANTHROPIC_API_KEY on its own; a token
// has to be passed in, along with the beta header that enables OAuth.
const authToken = process.env.ANTHROPIC_API_KEY ? undefined : process.env.ANTHROPIC_AUTH_TOKEN;
const anthropic = createAnthropic(authToken ? { authToken, headers: { "anthropic-beta": "oauth-2025-04-20" } } : {});

const SYSTEM_PROMPT = `You are a coding agent working in the project at ${ROOT}.
You can only see and change the project through your tools.
- Look around before changing code: list files, read the relevant ones, search.
- Make small, focused edits. Prefer edit_file over rewriting whole files.
- Check your work by running the tests or the program with run_command.
- If the user denies an action, don't retry it; find another way or explain what you need.
- When you're done, finish with a short summary of what you changed and how you verified it.`;

// 📋 Context lives here, outside the loop, so interactive mode can keep it
// between tasks. This array IS the agent's memory.
const messages: ModelMessage[] = [];

const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });

// Show at most a few lines of a long string.
function preview(text: string, maxLines = 6): string {
  const lines = text.split("\n");
  const shown = lines.slice(0, maxLines).join("\n");
  return lines.length > maxLines ? `${shown}\n... (${lines.length - maxLines} more lines)` : shown;
}

// 🔒 Ask the human. Only the harness can call this; the model never sees it.
async function askPermission(name: string, input: any): Promise<boolean> {
  console.log(`\n  ⚠️  The agent wants to ${name}:`);
  if (name === "run_command") console.log(`     $ ${input.command}`);
  if (name === "write_file") console.log(`     ${input.path}\n${preview(input.content, 15)}`);
  if (name === "edit_file") console.log(`     ${input.path}\n--- old\n${input.old_string}\n+++ new\n${input.new_string}`);
  const answer = await terminal.question("  Allow? (y/n) ");
  return answer.trim().toLowerCase().startsWith("y");
}

// 🤖 The agent loop: one task, many steps.
async function runTask(task: string): Promise<void> {
  messages.push({ role: "user", content: task });

  for (let step = 1; step <= MAX_STEPS; step++) {
    console.log(`\n━━━ Step ${step}/${MAX_STEPS} ━━━`);

    // 🧠 One model call = one decision. We send the full context every time.
    // The tools have no `execute`, so the SDK doesn't run them: it returns the
    // model's requested tool calls to us and stops after this single call.
    const result = await generateText({
      model: anthropic(MODEL),
      instructions: SYSTEM_PROMPT,
      messages,
      tools: toolDefinitions,
      maxOutputTokens: 16_000,
    });

    // 📋 Append the model's reply (text + tool calls) to the context, unchanged.
    messages.push(...result.response.messages);
    if (result.text) console.log(`\n💬 ${result.text}`);

    // END #1, decided by the model: it replied without asking for any tool.
    // That's how a model says "I'm done" (or "I need you to answer something").
    if (result.toolCalls.length === 0) {
      if (result.finishReason === "length") console.log("\n(Reply was cut off: hit maxOutputTokens.)");
      return;
    }

    // 🔧 Run every tool the model asked for, and collect one result per call.
    // The model may ask for several at once; all results go back together.
    const results: ToolResultPart[] = [];
    for (const call of result.toolCalls) {
      console.log(`\n🔧 ${call.toolName} ${JSON.stringify(call.input)}`);

      let output: string;
      let isError = false;
      if (NEEDS_PERMISSION.has(call.toolName) && !(await askPermission(call.toolName, call.input))) {
        output = "User denied this action";
        isError = true;
      } else {
        try {
          output = await runTool(call.toolName, call.input);
        } catch (error) {
          // Errors are information, not crashes: the model reads them and adapts.
          output = `Error: ${error instanceof Error ? error.message : String(error)}`;
          isError = true;
        }
      }

      console.log(`   ${isError ? "❌" : "✅"} ${preview(output).replaceAll("\n", "\n      ")}`);
      results.push({
        type: "tool-result",
        toolCallId: call.toolCallId, // links this result to the request that asked for it
        toolName: call.toolName,
        output: isError ? { type: "error-text", value: output } : { type: "text", value: output },
      });
    }

    // 📋 Tool results go into the context too, so the next call can see them.
    messages.push({ role: "tool", content: results });
  }

  // END #2, decided by the harness: the step budget ran out.
  console.log(`\n⏹️  Stopped after MAX_STEPS (${MAX_STEPS}). The task may be unfinished.`);
}

async function main() {
  const task = process.argv.slice(2).join(" ");
  console.log(`🤖 Coding agent | model: ${MODEL} | project: ${ROOT}`);

  if (task) {
    // One-shot mode: run the task, then exit.
    await runTask(task);
  } else {
    // Interactive mode: same `messages` across tasks, so the agent remembers
    // earlier work. (The model doesn't remember; the harness resends it.)
    // END #3, decided by you: an empty line, "exit", or Ctrl+C/Ctrl+D.
    while (true) {
      const next = (await terminal.question("\n📝 Task (empty to quit): ").catch(() => "")).trim();
      if (!next || next === "exit") break;
      try {
        await runTask(next);
      } catch (error) {
        // END #4, decided by the world: an API error (bad key, network, rate limit).
        console.error(`\n💥 ${error instanceof Error ? error.message : error}`);
      }
    }
  }
  terminal.close();
}

main().catch((error) => {
  console.error(`\n💥 ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
