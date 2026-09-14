// Stand-in for the Agent SDK's query(): reads user messages from the prompt iterable and
// plays a scripted turn per message, calling canUseTool the way the real CLI would.
//   default     thinking, streamed text, Bash (asks), Edit (no ask), final text
//   "ask"       AskUserQuestion
//   "fail"      an error result
//   "stubborn"  ignores the interrupt: after the Bash ask is denied it hangs until close()
// A message pushed while a turn plays is folded into it after the Bash result (the next
// tool boundary), answered "Noted: <text>", as Claude Code folds a queued message. The
// "ask" turn has no such boundary, so a message sent during it runs as the next turn.
import type { CanUseTool, Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { stripSteerNote } from "../../src/providers/steer-note.js";

export interface FakeClaudeLog {
  options: Options[];
  permissions: PermissionResult[];
  /** Every user message the fake read from the prompt stream. */
  inputs: SDKUserMessage[];
  /** The options each interrupt() was called with. */
  interrupts: unknown[];
}

const textOf = (message: SDKUserMessage): string =>
  stripSteerNote(typeof message.message.content === "string" ? message.message.content : "");

const as = (message: object): SDKMessage => message as unknown as SDKMessage;

/** Claude Code's words when another process holds the lock on the shared OAuth token. */
export const REFRESH_ERROR =
  "API Error: Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. " +
  "This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again";
type ToolOptions = Parameters<CanUseTool>[2];

export function createFakeQuery(editFile: string) {
  const log: FakeClaudeLog = { options: [], permissions: [], inputs: [], interrupts: [] };

  const queryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): Query => {
    const options = params.options ?? {};
    log.options.push(options);
    const sessionId = options.sessionId ?? options.resume ?? "sess";
    let abort = new AbortController();
    let closed = false;
    let unhang: (() => void) | null = null;
    let refreshFailures = 0;

    // The prompt stream is read all the time, as the CLI reads stdin, so a message
    // pushed mid-turn is waiting here for the turn to fold it in or run it next.
    const inbox: SDKUserMessage[] = [];
    const reader: { wake: (() => void) | null; ended: boolean } = { wake: null, ended: false };
    void (async () => {
      for await (const user of params.prompt) {
        log.inputs.push(user);
        inbox.push(user);
        reader.wake?.();
      }
      reader.ended = true;
      reader.wake?.();
    })();
    const nextInput = async (): Promise<SDKUserMessage | undefined> => {
      while (inbox.length === 0 && !reader.ended) await new Promise<void>((resolve) => (reader.wake = resolve));
      return inbox.shift();
    };

    const stream = (event: object) => as({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u", session_id: sessionId });
    const assistant = (id: string, content: object[]) =>
      as({ type: "assistant", message: { id, content }, parent_tool_use_id: null, uuid: "u", session_id: sessionId });
    const toolResult = (toolUseId: string, content: string, isError: boolean, structured?: object) =>
      as({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
        parent_tool_use_id: null,
        ...(structured ? { tool_use_result: structured } : {}),
      });
    const result = (turn: number, subtype: string, extra: object = {}) =>
      as({
        type: "result",
        subtype,
        is_error: subtype !== "success",
        result: "Done",
        errors: subtype === "success" ? [] : ["something broke"],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 },
        total_cost_usd: 0.01 * turn,
        session_id: sessionId,
        ...extra,
      });
    const ask = async (tool: string, input: Record<string, unknown>, extra: Partial<ToolOptions>): Promise<PermissionResult> => {
      const decision = await options.canUseTool!(tool, input, { signal: abort.signal, toolUseID: "tu", ...extra } as ToolOptions);
      if (!decision) throw new Error("canUseTool gave no decision");
      log.permissions.push(decision);
      return decision;
    };

    async function* turn(n: number, text: string): AsyncGenerator<SDKMessage, void> {
      // "refresh": Claude Code could not refresh the machine's shared login (another process
      // held the lock). An API-error assistant message and a failed result, and nothing from
      // the API. "refresh-once" fails the first try only; "refresh-always" every try.
      if (text.includes("refresh") && (text.includes("always") || refreshFailures++ === 0)) {
        yield as({
          type: "assistant",
          message: { id: `msg_${n}_err`, model: "<synthetic>", content: [{ type: "text", text: REFRESH_ERROR }] },
          parent_tool_use_id: null,
          error: "server_error",
          uuid: "u",
          session_id: sessionId,
        });
        yield result(n, "success", {
          is_error: true,
          result: REFRESH_ERROR,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          total_cost_usd: 0,
        });
        return;
      }
      const first = `msg_${n}_1`;
      yield stream({ type: "message_start", message: { id: first } });
      // "quiet": thinking with its text omitted, as Claude Code sends it without thinking summaries.
      const thought = text.includes("quiet") ? "" : "Tests first.";
      yield stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
      yield stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thought } });
      yield assistant(first, [{ type: "thinking", thinking: thought, signature: "" }]);
      yield stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
      yield stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Running" } });
      yield stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " tests" } });
      yield assistant(first, [{ type: "text", text: "Running tests" }]);

      if (text.includes("fail")) {
        yield result(n, "error_during_execution");
        return;
      }
      if (text.includes("quick")) {
        yield result(n, "success");
        return;
      }
      if (text.includes("ask")) {
        const input = {
          questions: [
            {
              question: "Which database?",
              header: "DB",
              options: [
                { label: "Postgres", description: "server" },
                { label: "SQLite", description: "file" },
              ],
              multiSelect: false,
            },
          ],
        };
        yield assistant(`msg_${n}_2`, [{ type: "tool_use", id: `tu_${n}_ask`, name: "AskUserQuestion", input }]);
        await ask("AskUserQuestion", input, { toolUseID: `tu_${n}_ask` });
        yield toolResult(`tu_${n}_ask`, "answered", false);
        yield result(n, "success");
        return;
      }

      const bashId = `tu_${n}_bash`;
      const bash = { command: "npm test", description: "Run tests" };
      yield assistant(`msg_${n}_2`, [{ type: "tool_use", id: bashId, name: "Bash", input: bash }]);
      const decision = await ask("Bash", bash, {
        toolUseID: bashId,
        title: "Claude wants to run npm test",
        suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "session" }],
      });
      if (abort.signal.aborted || (decision.behavior === "deny" && decision.interrupt)) {
        yield toolResult(bashId, "Interrupted by user", true);
        if (text.includes("stubborn")) {
          // A CLI that never ends the turn: nothing more until the query is closed.
          await new Promise<void>((resolve) => (unhang = resolve));
          return;
        }
        yield result(n, "error_during_execution");
        return;
      }
      if (decision.behavior === "deny") yield toolResult(bashId, decision.message, true);
      else yield toolResult(bashId, "ok", false, { stdout: "ok\n", stderr: "", interrupted: false });

      const folded = inbox.splice(0);
      if (folded.length > 0) {
        yield as({
          type: "assistant",
          message: { id: `msg_${n}_note`, content: [{ type: "text", text: folded.map((m) => `Noted: ${textOf(m)}`).join("\n") }] },
          parent_tool_use_id: null,
          uuid: "u",
          session_id: sessionId,
          user_message_uuids: folded.map((m) => m.uuid),
        });
      }

      const editId = `tu_${n}_edit`;
      const edit = { file_path: editFile, old_string: "return 1;", new_string: "return 2;" };
      yield assistant(`msg_${n}_3`, [{ type: "tool_use", id: editId, name: "Edit", input: edit }]);
      yield toolResult(editId, "The file has been updated.", false);
      yield assistant(`msg_${n}_4`, [{ type: "text", text: "Done" }]);
      yield result(n, "success");
    }

    async function* run(): AsyncGenerator<SDKMessage, void> {
      yield as({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: "none" });
      let n = 0;
      for (let user = await nextInput(); user && !closed; user = await nextInput()) {
        abort = new AbortController();
        yield* turn(++n, textOf(user));
      }
    }

    const generator = run();
    return Object.assign(generator, {
      interrupt: async (opts?: { cancelQueued?: boolean }) => {
        log.interrupts.push(opts);
        if (opts?.cancelQueued) inbox.length = 0;
        abort.abort();
        return undefined;
      },
      close: () => {
        closed = true;
        unhang?.();
        reader.ended = true;
        reader.wake?.();
      },
    }) as unknown as Query;
  };

  return { queryFn, log };
}
