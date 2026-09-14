// Runs Claude through the Agent SDK directly, without TermLink, and prints every
// message and stream event with its time since the prompt was pushed. The baseline
// for what the host adds, and a way to see what arrives while Claude is thinking.
//
//   node --conditions=source --import tsx scripts/sdk-probe.ts [--turns 2] [--prompt "..."] [--model m] [--cwd dir]
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { InputQueue } from "../src/providers/claude/input-queue.js";
import { resolveClaudeExecutable } from "../src/providers/claude/provider.js";

const { values } = parseArgs({
  options: {
    turns: { type: "string", default: "2" },
    prompt: { type: "string", default: "Reply in two short sentences: confirm you got this message, then name three colors." },
    model: { type: "string" },
    cwd: { type: "string" },
  },
});
const cwd = path.resolve(values.cwd ?? path.join(import.meta.dirname, "..", "..", ".."));
const executable = resolveClaudeExecutable();
if (!executable) throw new Error("no claude executable");

const input = new InputQueue<SDKUserMessage>();
const spawnAt = performance.now();
const q = query({
  prompt: input,
  options: {
    cwd,
    includePartialMessages: true,
    pathToClaudeCodeExecutable: executable,
    ...(values.model ? { model: values.model } : {}),
  },
});

let t0 = spawnAt;
let turn = 0;
const turns = Number(values.turns) || 2;
const at = (): string => `+${Math.round(performance.now() - t0)}ms`.padStart(8);

function push(): void {
  turn++;
  t0 = performance.now();
  console.log(`\n--- turn ${turn}: push`);
  input.push({ type: "user", message: { role: "user", content: values.prompt }, parent_tool_use_id: null });
}

push();
let lastDelta = "";
for await (const message of q) {
  if (message.type === "stream_event") {
    const e = message.event as { type: string; index?: number; content_block?: { type: string }; delta?: { type: string } };
    const what = e.type === "content_block_start" ? `${e.type} ${e.content_block?.type}` : e.type === "content_block_delta" ? `delta ${e.delta?.type}` : e.type;
    // Collapse runs of the same delta type to their first and a count.
    if (what === lastDelta) continue;
    lastDelta = what;
    console.log(`${at()} stream ${what}${e.index !== undefined ? ` [${e.index}]` : ""}`);
  } else {
    lastDelta = "";
    const sub = "subtype" in message ? `/${String(message.subtype)}` : "";
    if (message.type === "assistant") {
      const blocks = (message.message.content as { type: string; thinking?: string }[]).map((b) =>
        b.type === "thinking" ? `thinking(${b.thinking?.length ?? 0} chars)` : b.type,
      );
      console.log(`${at()} assistant [${blocks.join(", ")}]`);
    } else {
      console.log(`${at()} ${message.type}${sub}${turn === 1 && message.type === "system" ? ` (spawn +${Math.round(performance.now() - spawnAt)}ms)` : ""}`);
    }
    if (message.type === "result") {
      if (turn >= turns) break;
      push();
    }
  }
}
input.end();
q.close();
