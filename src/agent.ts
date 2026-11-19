// A minimal coding agent, small enough to read in one sitting.
//
// Usage (from inside any project folder):
//   npx tsx path/to/src/agent.ts "Add a test for the add function and make it pass"
//   npx tsx path/to/src/agent.ts            (interactive mode: asks you for tasks)
//
// Reading order: this file (what this agent is), then harness.ts starting at
// createHarness (how any agent runs), then tools.ts (what this agent can do).
//
// THE CONCEPTS
//
// 🧠 Model: the LLM. One call = one decision: given everything so far, either
//    answer in text or ask for some tools to be run. It keeps no memory between
//    calls; anything it "remembers" is because we sent it again.
//
// 🧰 Harness: harness.ts. It owns the loop, calls the model, runs the tools,
//    asks you for permission and enforces limits. It's general: it doesn't
//    know it's running a coding agent. The model proposes; the harness disposes.
//
// 🔧 Tools: tools.ts. Each one has a part the model sees (name, description,
//    input schema) and code that only the harness runs.
//
// 🌍 Environment: the project folder and the shell. They exist independently
//    of the model, which can only see and change them through tools.
//
// 📋 Context: everything the model sees on a call: the system prompt, the
//    tool definitions and the `context` array in the harness. Every model
//    reply and every tool result is appended to that array, and all of it is
//    resent on every call. It only grows.
//
// 🤖 Agent: not any one piece of code. It's what exists while the harness
//    runs a model, a prompt and tools on a task in an environment. This file
//    picks those parts for one agent, a coding agent. Pick a different prompt
//    and tools and you get a different agent on the same harness.
//
// 🔒 Permissions: the model can't be trusted to police itself (it can be wrong,
//    or tricked by text it read in a file). So the harness, which runs the
//    code, decides what's allowed, and asks you before anything risky happens.

import readline from "node:readline/promises";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createHarness } from "./harness.ts";
import { tools } from "./tools.ts";
import { ENVIRONMENT_ROOT } from "./utils.ts";

// 🧠 Which model. Set LOCAL_MODEL to use a model running on your machine
// instead of Claude, e.g. LOCAL_MODEL=qwen3.6:27b with Ollama. It must support
// tool calling. The harness doesn't care which one it gets.
const LOCAL_MODEL = process.env.LOCAL_MODEL;
const MODEL = LOCAL_MODEL ?? "claude-sonnet-5-5"; // change this to try another Claude model

// Credentials: an API key (sent as x-api-key) or an OAuth token (sent as
// Authorization: Bearer). The SDK reads ANTHROPIC_API_KEY on its own; a token
// has to be passed in, along with the beta header that enables OAuth.
const authToken = process.env.ANTHROPIC_API_KEY ? undefined : process.env.ANTHROPIC_AUTH_TOKEN;
const anthropic = createAnthropic(authToken ? { authToken, headers: { "anthropic-beta": "oauth-2025-04-20" } } : {});

// Local servers (Ollama, LM Studio, llama.cpp) speak the OpenAI API. Ollama's
// is on port 11434; set LOCAL_BASE_URL for the others.
const local = createOpenAICompatible({ name: "local", baseURL: process.env.LOCAL_BASE_URL ?? "http://localhost:11434/v1" });

const SYSTEM_PROMPT = `You are a coding agent working in the project at ${ENVIRONMENT_ROOT}.
You can only see and change the project through your tools.
- Look around before changing code: list files, read the relevant ones, search.
- Make small, focused edits. Prefer edit_file over rewriting whole files.
- Check your work by running the tests or the program with run_command.
- If the user denies an action, don't retry it; find another way or explain what you need.
- When you're done, finish with a short summary of what you changed and how you verified it.`;

const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });

const harness = createHarness(
  // How the harness reaches you: in the terminal. The model never sees these.
  {
    confirm: async (question) => (await terminal.question(`${question} (y/n) `)).trim().toLowerCase().startsWith("y"),
    print: (message) => console.log(message),
  },
  // This agent's parts. There's no `agent` variable, because the agent only
  // exists while harness.runTask runs.
  {
    model: LOCAL_MODEL ? local(LOCAL_MODEL) : anthropic(MODEL),
    systemPrompt: SYSTEM_PROMPT,
    tools,
  },
);

// API errors hide the useful part: the HTTP status and the body the API sent
// back. After retries, the SDK wraps the real error in `lastError`.
function describeError(error: any): string {
  const cause = error?.lastError ?? error;
  const status = cause?.statusCode ? ` (HTTP ${cause.statusCode})` : "";
  const body = cause?.responseBody ? `\n${cause.responseBody}` : "";
  return `${error?.message ?? error}${status}${body}`;
}

async function main() {
  const task = process.argv.slice(2).join(" ");
  console.log(`🤖 Coding agent | model: ${MODEL} | project: ${ENVIRONMENT_ROOT}`);

  if (task) {
    // One-shot mode: run the task, then exit.
    await harness.runTask(task);
  } else {
    // Interactive mode: the same harness, and so the same context, across
    // tasks, so the agent remembers earlier work. (The model doesn't
    // remember; the harness resends it.)
    // END #3, decided by you: an empty line, "exit", or Ctrl+C/Ctrl+D.
    while (true) {
      const next = (await terminal.question("\n📝 Task (empty to quit, \"clear\" to forget): ").catch(() => "")).trim();
      if (!next || next === "exit") break;
      if (next === "clear") {
        harness.clearContext();
        console.log("🧹 Context cleared. The agent remembers nothing; the files keep their changes.");
        continue;
      }
      try {
        await harness.runTask(next);
      } catch (error) {
        // END #4, decided by the world: an API error (bad key, network, rate limit).
        console.error(`\n💥 ${describeError(error)}`);
      }
    }
  }
  terminal.close();
}

main().catch((error) => {
  console.error(`\n💥 ${describeError(error)}`);
  process.exit(1);
});
