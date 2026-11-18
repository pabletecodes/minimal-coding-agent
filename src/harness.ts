// 🧰 THE HARNESS
//
// The general machinery that turns a model into an agent: the loop, the
// context, running tools, asking permission and enforcing limits.
// Nothing in here is specific to coding. agent.ts plugs in a model, a system
// prompt and some tools; a different agent could reuse this file unchanged.
//
// Read it top to bottom: each section builds on the one before.

import { generateText, tool, type LanguageModel, type ModelMessage, type ToolResultPart } from "ai";
import type { Tool } from "./tools.ts";

const MAX_STEPS = 30; // model calls per task: a hard limit so a confused agent can't loop forever

// --- 1. User interface and agent definition ---------------------------------

// How the harness reaches a human: the terminal in agent.ts, but it could be a
// web page, an IDE panel, or nothing at all. It's not part of the agent: the
// same agent can run behind any UI. The harness decides WHEN and WHAT; these
// decide HOW. The model never sees any of it.
export type UserInterface = {
  confirm: (question: string) => Promise<boolean>; // 🔒 a yes/no question; the harness waits, and the answer changes what happens
  print: (message: string) => void; // one-way; changes nothing
};

// Which agent to run: the parts that make one particular agent. Swap them and
// the same harness runs a different agent.
export type AgentDefinition = {
  model: LanguageModel; // 🧠 which model makes the decisions
  systemPrompt: string; // what the model is told before any task
  tools: Record<string, Tool>; // 🔧 what the model can ask the harness to do
};

// --- 2. The harness --------------------------------------------------------

// Set up the harness: the generic machinery, reaching a human through `ui`
// and running the agent that `agentDefinition` defines.
export function createHarness(ui: UserInterface, agentDefinition: AgentDefinition) {
  // 📋 The context carries over between tasks. The model remembers nothing
  // between calls. What it sees on each call is this array plus the system
  // prompt and the tool definitions, which are resent unchanged every time.
  const context: ModelMessage[] = [];

  // Run a task: add it to the context, hand over to the loop, then add
  // everything the loop produced. Only here does the context change.
  async function runTask(task: string): Promise<void> {
    context.push({ role: "user", content: task });
    const newMessages = await loop(agentDefinition, ui, context);
    context.push(...newMessages);
  }

  // Forget everything: the next task starts from an empty context. The
  // environment keeps every change already made.
  function clearContext(): void {
    context.length = 0;
  }

  return { runTask, clearContext };
}

// --- 3. The loop -----------------------------------------------------------

// 🔁 Many model calls, until the model stops asking for tools or the step
// budget runs out. It only reads the context; it returns the messages this
// task produced and leaves adding them to the caller.
async function loop(agentDefinition: AgentDefinition, ui: UserInterface, context: readonly ModelMessage[]): Promise<ModelMessage[]> {
  const newMessages: ModelMessage[] = [];

  for (let step = 1; step <= MAX_STEPS; step++) {
    ui.print(`\n━━━ Step ${step}/${MAX_STEPS} ━━━`);

    // 🧠 One model call = one decision. We send the full context every time.
    // The SDK returns the model's requested tool calls and stops after this
    // single call, because none of the tools has an `execute`.
    const messages = [...context, ...newMessages];
    const reply = await generateText({
      model: agentDefinition.model,
      instructions: agentDefinition.systemPrompt, // the AI SDK calls the system prompt "instructions"
      messages,
      tools: toolDefinitions(agentDefinition.tools),
      maxOutputTokens: 16_000,
    });
    newMessages.push(...reply.response.messages);
    if (reply.text) ui.print(`\n💬 ${reply.text}`);

    // END #1, decided by the model: it replied without asking for any tool.
    // That's how a model says "I'm done" (or "I need you to answer something").
    if (reply.toolCalls.length === 0) {
      if (reply.finishReason === "length") ui.print("\n(Reply was cut off: hit maxOutputTokens.)");
      return newMessages;
    }

    const results = await runTools(reply.toolCalls, agentDefinition.tools, ui);
    if (results.length > 0) newMessages.push({ role: "tool", content: results });
  }

  // END #2, decided by the harness: the step budget ran out.
  ui.print(`\n⏹️  Stopped after ${MAX_STEPS} steps (MAX_STEPS). The task may be unfinished.`);
  return newMessages;
}

// --- 4. What the model sees of the tools -----------------------------------

// What the model sees of each tool: description and schema, never `run`.
// There's no `execute` either, so the AI SDK hands tool calls back to our
// loop instead of running them itself. The harness stays in charge.
function toolDefinitions(tools: Record<string, Tool>) {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => [name, tool({ description: t.description, inputSchema: t.inputSchema })]),
  );
}

// --- 5. 🔧 Running tool calls ----------------------------------------------

type ToolCall = Awaited<ReturnType<typeof generateText>>["toolCalls"][number];
type ToolOutcome = { output: string; isError: boolean };

// Run every tool the model asked for, and collect one result per call.
// The model may ask for several at once; all results go back together.
async function runTools(calls: ToolCall[], tools: Record<string, Tool>, ui: UserInterface) {
  const results: ToolResultPart[] = [];
  for (const call of calls) {
    ui.print(`\n🔧 ${call.toolName} ${JSON.stringify(call.input)}`);

    // Input that doesn't match the tool's schema: the SDK has already put an
    // error result for this call into the context, so there's nothing to run.
    if (call.invalid) {
      ui.print("   ❌ Invalid input. The SDK has already sent the model an error.");
      continue;
    }

    const { output, isError } = await runToolCall(call, tools, ui);
    ui.print(`   ${isError ? "❌" : "✅"} ${output.slice(0, 200)}`); // a short preview
    results.push({
      type: "tool-result",
      toolCallId: call.toolCallId, // links this result to the request that asked for it
      toolName: call.toolName,
      output: isError ? { type: "error-text", value: output } : { type: "text", value: output },
    });
  }
  return results;
}

async function runToolCall(call: ToolCall, tools: Record<string, Tool>, ui: UserInterface): Promise<ToolOutcome> {
  const tool = tools[call.toolName];
  if (!tool) return { output: `Error: Unknown tool: ${call.toolName}`, isError: true };

  // 🔒 The harness asks you; the model only finds out what you decided.
  if (tool.needsPermission && !(await ui.confirm(permissionQuestion(call)))) {
    return { output: "User denied this action", isError: true };
  }

  try {
    return { output: await tool.run(call.input), isError: false };
  } catch (error) {
    // Errors are information, not crashes: the model reads them and adapts.
    return { output: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

// Shown in full: you should see exactly what you're approving.
function permissionQuestion(call: ToolCall): string {
  const fields = Object.entries(call.input as object).map(([key, value]) => `\n     ${key}: ${value}`);
  return `\n  ⚠️  The model wants to run ${call.toolName}:${fields.join("")}\n  Allow?`;
}
