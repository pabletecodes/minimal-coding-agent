# Minimal coding agent

A small coding agent (about 300 lines including comments) for learning how agents like Claude Code work under the hood.

- `src/agent.ts`: the loop (🧠 model calls, 📋 context, 🔒 permissions, stop conditions)
- `src/tools.ts`: the 🔧 tools: their definitions (what the model sees) and implementations (what actually runs)
- `examples/calculator`: a tiny project with a bug and a failing test, for the agent to fix

It uses the [Vercel AI SDK](https://www.npmjs.com/package/ai) (`ai` + `@ai-sdk/anthropic`) only to make model calls. The loop, the tools and the permission checks are all written out by hand, so you can see them.

## Setup

Requires Node.js 20 or newer.

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # get one at https://console.anthropic.com
```

Or use an OAuth access token instead of an API key. It's only used when `ANTHROPIC_API_KEY` is unset:

```bash
export ANTHROPIC_AUTH_TOKEN=...
```

## Usage

Run it from inside the project you want it to work on. That folder is the agent's whole world.

```bash
cd some/project
npx tsx path/to/src/agent.ts "Add a test for the add function and make it pass"

# No task given: interactive mode. It keeps the conversation between tasks.
npx tsx path/to/src/agent.ts
```

Before writing a file, editing one or running a command, it shows you what it wants to do and waits for `y` or `n`.

## Experiments

Each experiment shows one concept. Run `git checkout examples/calculator` between runs to put the bug back.

### 1. Watch it find and fix the bug

```bash
cd examples/calculator
npm test                                   # see the failure first
npx tsx ../../src/agent.ts "The tests are failing. Find the bug and fix it."
```

Watch the steps. A good run looks around (`list_files`, `read_file`), runs the tests, makes one `edit_file` and runs the tests again. Every step is one model call. Between calls, the harness runs the tools and appends their results to the context.

### 2. Deny a permission request

Run the same task, but answer `n` when the agent asks to run `npm test` or to edit the file. The model gets `User denied this action` as the tool result. Does it try a different command? Edit anyway without testing? Ask you why? The model never decided whether the action was allowed. It can only react to the harness's decision.

### 3. Watch the context grow

In `src/agent.ts`, right after `messages.push(...result.response.messages);`, add:

```ts
console.log(`📋 context: ${messages.length} messages, ${JSON.stringify(messages).length} chars, ${result.usage.inputTokens} input tokens`);
```

Run experiment 1 again. Input tokens go up every step, because the whole history is resent on every call. This is why long sessions get slower and more expensive, and why truncating tool output (`MAX_OUTPUT` in tools.ts) matters.

### 4. Take away the agent's ability to test

In `src/tools.ts`, comment out the `run_command` entry in `toolDefinitions`. Run experiment 1 again. The model can still read and edit, but it can't check its work. Does it still find the bug? Does its summary claim the tests pass when it never ran them? Feedback from the environment is what makes an agent better than a single prompt.

### 5. Run out of steps

Set `MAX_STEPS = 3` in `src/agent.ts` and give it a bigger task:

```bash
npx tsx ../../src/agent.ts "Add power, modulo and square root functions, each with tests, and make sure all tests pass."
```

It stops partway and prints `Stopped after MAX_STEPS`. Here the harness ended the task, not the model. Then try interactive mode: give the same task, let it hit the limit, and type `continue`. Because `messages` is kept between tasks, it picks up where it left off.

## How the loop ends

| Who decides | How |
| --- | --- |
| 🧠 The model | It replies without requesting any tool (it's done, or it needs your input) |
| 🧰 The harness | `MAX_STEPS` is reached |
| 🧑 You | Empty task, `exit`, or Ctrl+C in interactive mode |
| 🌍 The world | An API error (missing key, network, rate limit) |
