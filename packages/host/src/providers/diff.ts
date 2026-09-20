import path from "node:path";
import { createTwoFilesPatch } from "diff";

const MAX_DIFF_CHARS = 200_000;

/** A path relative to cwd, in / form, for anything a provider reports as an absolute path
 *  (Claude's own tool inputs; Cursor's own tool_call locations). Falls back to the
 *  original when it isn't under cwd at all. */
export function displayPath(file: string, cwd: string): string {
  const relative = path.relative(cwd, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return file;
  return relative.split(path.sep).join("/");
}

/** A real unified diff for a provider that only reports a file's before/after text
 *  (Claude's Write/Edit tools; Cursor's own "edit" tool_call). */
export function unifiedDiff(name: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(`a/${name}`, `b/${name}`, before, after, undefined, undefined, { context: 3 });
  // jsdiff opens with an "Index:"/"====" banner; start at the --- line like git does.
  const start = patch.indexOf("--- ");
  const diff = start >= 0 ? patch.slice(start) : patch;
  return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n... diff truncated` : diff;
}
