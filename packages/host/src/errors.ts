import type { ErrorCode } from "@termlink/protocol";

/** An error that is reported to the client with its code instead of as "internal". */
export class HostError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
