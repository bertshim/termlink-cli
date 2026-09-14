import { readFileSync } from "node:fs";
import path from "node:path";
import type { FileChange, Item, ItemStatus } from "@termlink/protocol";
import { createTwoFilesPatch } from "diff";
import { displayCommand } from "../display.js";

const MAX_DIFF_CHARS = 200_000;

export function displayPath(file: string, cwd: string): string {
  const relative = path.relative(cwd, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return file;
  return relative.split(path.sep).join("/");
}

export function unifiedDiff(name: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(`a/${name}`, `b/${name}`, before, after, undefined, undefined, { context: 3 });
  // jsdiff opens with an "Index:"/"====" banner; start at the --- line like git does.
  const start = patch.indexOf("--- ");
  const diff = start >= 0 ? patch.slice(start) : patch;
  return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n... diff truncated` : diff;
}

function readIfExists(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

interface EditSpec {
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
}

function applyEdit(text: string, edit: EditSpec): string | null {
  const oldText = typeof edit.old_string === "string" ? edit.old_string : "";
  const newText = typeof edit.new_string === "string" ? edit.new_string : "";
  if (!oldText || !text.includes(oldText)) return null;
  return edit.replace_all === true ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
}

/**
 * The file changes a Claude file tool is about to make. Claude reports edits as
 * old/new strings, so the host reads the file as it is now (before the tool runs)
 * and computes a real unified diff. Returns null for tools that do not edit files.
 */
export function fileChangesFor(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  readFiles = true,
): FileChange[] | null {
  const target = typeof input.file_path === "string" ? input.file_path : input.notebook_path;
  if (typeof target !== "string") return null;
  const file = path.resolve(cwd, target);
  const name = displayPath(file, cwd);
  // History import passes readFiles=false: the file on disk is no longer the "before".
  const read = (f: string): string | null => (readFiles ? readIfExists(f) : null);

  switch (tool) {
    case "Write": {
      const before = read(file);
      const after = typeof input.content === "string" ? input.content : "";
      const action = before !== null || !readFiles ? "modify" : "add";
      return [{ path: name, action, diff: unifiedDiff(name, before ?? "", after) }];
    }
    case "Edit":
    case "MultiEdit": {
      const edits = tool === "Edit" ? [input as EditSpec] : Array.isArray(input.edits) ? (input.edits as EditSpec[]) : [];
      const before = read(file);
      let after = before;
      for (const edit of edits) after = after === null ? null : applyEdit(after, edit);
      if (before !== null && after !== null) return [{ path: name, action: "modify", diff: unifiedDiff(name, before, after) }];
      // The file is not readable or an edit no longer matches: show the edits themselves.
      // Snippets rarely end in a newline; add one so the diff has no "No newline" markers.
      const line = (value: unknown): string => {
        const text = String(value ?? "");
        return text.endsWith("\n") ? text : `${text}\n`;
      };
      const diff = edits.map((e) => unifiedDiff(name, line(e.old_string), line(e.new_string))).join("\n");
      return [{ path: name, action: "modify", diff }];
    }
    case "NotebookEdit":
      return [{ path: name, action: "modify" }];
    default:
      return null;
  }
}

/** Maps a tool_use block to the item shown while the tool runs. */
export function mapToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  options: { readFiles?: boolean } = {},
): Item {
  // Claude Code on Windows runs shell commands through its PowerShell tool.
  if (name === "Bash" || name === "PowerShell") {
    const command = typeof input.command === "string" ? input.command : "";
    const display = displayCommand(command);
    return { id, kind: "command", command, ...(display ? { display } : {}), cwd, status: "in_progress" };
  }
  const changes = fileChangesFor(name, input, cwd, options.readFiles ?? true);
  if (changes) return { id, kind: "file_change", changes, status: "in_progress" };
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    const todos = input.todos as { content?: unknown; status?: unknown }[];
    return {
      id,
      kind: "todo",
      entries: todos.map((t) => ({ text: String(t.content ?? ""), done: t.status === "completed" })),
      status: "in_progress",
    };
  }
  return { id, kind: "tool", name, input, status: "in_progress" };
}

export interface ToolResult {
  content?: unknown;
  is_error?: boolean;
}

export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) =>
      typeof block === "object" && block !== null && "text" in block && typeof block.text === "string" ? block.text : "",
    )
    .filter(Boolean)
    .join("\n");
}

function bashOutput(structured: unknown): string | null {
  if (typeof structured !== "object" || structured === null) return null;
  const { stdout, stderr } = structured as { stdout?: unknown; stderr?: unknown };
  if (typeof stdout !== "string" && typeof stderr !== "string") return null;
  const out = typeof stdout === "string" ? stdout : "";
  const err = typeof stderr === "string" && stderr ? stderr : "";
  return out && err ? `${out}\n${err}` : out || err;
}

/**
 * Final state of a tool item once its tool_result arrives. `interrupted`: the turn is
 * being stopped, so an error result is the tool being cut short, not the tool failing.
 */
export function completeToolItem(item: Item, result: ToolResult, structured: unknown, declined: boolean, interrupted = false): Item {
  const status: ItemStatus = declined ? "declined" : result.is_error ? (interrupted ? "interrupted" : "failed") : "completed";
  const text = toolResultText(result.content);
  switch (item.kind) {
    case "command": {
      const exit = /exit code (\d+)/i.exec(text);
      const exitCode = declined || interrupted ? null : exit ? Number(exit[1]) : result.is_error ? null : 0;
      return { ...item, output: bashOutput(structured) ?? text, exitCode, status };
    }
    case "tool":
      return { ...item, output: text, status };
    default:
      return { ...item, status };
  }
}
