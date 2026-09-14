/**
 * The line added to a message sent while the agent works, so the agent says how it
 * takes it on — the "Got it, I'll check that after this" the Claude Code CLI gives.
 * Only what goes to the agent carries it; the message on screen is what was typed.
 * The agent's own transcript keeps it, so history readers take it off again.
 */
export const STEER_NOTE =
  "(Sent while you were working. Fold it into what you are doing, and say in one line how you will handle it.)";

export const withSteerNote = (text: string): string => `${text.replace(/\s+$/, "")}\n\n${STEER_NOTE}`;

export function stripSteerNote(text: string): string {
  const at = text.lastIndexOf(STEER_NOTE);
  return at < 0 ? text : text.slice(0, at).replace(/\s+$/, "");
}
