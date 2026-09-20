// The transport itself has nothing Codex-specific in it — Cursor's ACP adapter speaks the
// same newline-delimited JSON-RPC — so it now lives at ../rpc.js and this file just re-exports
// it under the path everything here already imports from.
export * from "../rpc.js";
